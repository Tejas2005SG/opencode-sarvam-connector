import fs from "fs";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";
import { AccountManager } from "../../src/accountManager";
import { AccountStore, FileAccountStore, SqliteAccountStore } from "../../src/accounts";
import { chatWithRotation } from "../../src/sarvamProxy";
import { MockSarvamServer } from "../fixture/mockSarvamServer";

const TEST_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");

async function removeTempDirWithRetry(dirPath: string): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.promises.rm(dirPath, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 50
      });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const retryable = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
      await sleep(75 * attempt);
    }
  }
}

describe("chatWithRotation integration", () => {
  let server: MockSarvamServer;
  let tempDir: string;
  let previousKey: string | undefined;
  let storesToClose: AccountStore[];

  beforeEach(async () => {
    previousKey = process.env.SARVAM_STORE_KEY;
    process.env.SARVAM_STORE_KEY = TEST_MASTER_KEY;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sarvam-connector-test-"));
    server = new MockSarvamServer();
    storesToClose = [];
    await server.start();
  });

  afterEach(async () => {
    for (const store of storesToClose.reverse()) {
      try {
        await store.close();
      } catch {
        // best-effort cleanup for teardown
      }
    }
    await server.stop();
    if (previousKey === undefined) {
      delete process.env.SARVAM_STORE_KEY;
    } else {
      process.env.SARVAM_STORE_KEY = previousKey;
    }
    await removeTempDirWithRetry(tempDir);
  });

  it("scenario A: single account success path", async () => {
    server.setBehavior("key-a", {
      chatQueue: [
        {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "ok-a" } }],
            usage: { total_tokens: 80 }
          }
        }
      ]
    });

    const store = new FileAccountStore(path.join(tempDir, "accounts.json"));
    storesToClose.push(store);
    await store.init();
    const manager = new AccountManager(store);
    await manager.addAccount({ email: "a@example.com", apiKey: "key-a", initialCredits: 1000 });

    const response = await chatWithRotation(
      {
        model: "sarvam-105b",
        messages: [{ role: "user", content: "hello" }]
      },
      { accountManager: manager, sarvamBaseUrl: server.baseUrl }
    );

    expect(response.choices[0].message.content).toBe("ok-a");
    const listed = await manager.listAccounts();
    expect(listed[0].credits).toBe(920);
  });

  it("scenario B: quota error rotates to secondary account", async () => {
    server.setBehavior("key-bad", {
      chatQueue: [
        {
          status: 429,
          body: { error: { message: "quota exceeded" } }
        }
      ]
    });
    server.setBehavior("key-good", {
      chatQueue: [
        {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "ok-good" } }],
            usage: { total_tokens: 50 }
          }
        }
      ]
    });

    const store = new FileAccountStore(path.join(tempDir, "accounts.json"));
    storesToClose.push(store);
    await store.init();
    const manager = new AccountManager(store);
    await manager.addAccount({ email: "bad@example.com", apiKey: "key-bad", initialCredits: 500 });
    await manager.addAccount({ email: "good@example.com", apiKey: "key-good", initialCredits: 400 });

    const response = await chatWithRotation(
      {
        model: "sarvam-105b",
        messages: [{ role: "user", content: "hello" }]
      },
      { accountManager: manager, sarvamBaseUrl: server.baseUrl }
    );

    expect(response.choices[0].message.content).toBe("ok-good");
    const listed = await manager.listAccounts();
    const bad = listed.find((item) => item.email === "bad@example.com");
    expect(bad?.credits).toBe(0);
  });

  it("scenario C: auth error marks exhausted and rotates", async () => {
    server.setBehavior("key-auth-fail", {
      chatQueue: [
        {
          status: 401,
          body: { error: { message: "unauthorized" } }
        }
      ]
    });
    server.setBehavior("key-next", {
      chatQueue: [
        {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "ok-next" } }],
            usage: { total_tokens: 25 }
          }
        }
      ]
    });

    const store = new FileAccountStore(path.join(tempDir, "accounts.json"));
    storesToClose.push(store);
    await store.init();
    const manager = new AccountManager(store);
    await manager.addAccount({ email: "auth@example.com", apiKey: "key-auth-fail", initialCredits: 800 });
    await manager.addAccount({ email: "next@example.com", apiKey: "key-next", initialCredits: 300 });

    const response = await chatWithRotation(
      {
        model: "sarvam-30b",
        messages: [{ role: "user", content: "hello" }]
      },
      { accountManager: manager, sarvamBaseUrl: server.baseUrl }
    );

    expect(response.choices[0].message.content).toBe("ok-next");
    const listed = await manager.listAccounts();
    const exhausted = listed.find((item) => item.email === "auth@example.com");
    expect(exhausted?.credits).toBe(0);
  });

  it("scenario D: concurrent requests with sqlite do not lose deductions", async () => {
    server.setBehavior("key-concurrent", {
      defaultChatResponse: {
        status: 200,
        body: {
          choices: [{ message: { role: "assistant", content: "ok-concurrent" } }],
          usage: { total_tokens: 100 }
        }
      }
    });

    const sqlitePath = path.join(tempDir, "accounts.db");
    const store = new SqliteAccountStore(sqlitePath);
    storesToClose.push(store);
    await store.init();
    const manager = new AccountManager(store);
    await manager.addAccount({
      email: "concurrent@example.com",
      apiKey: "key-concurrent",
      initialCredits: 1000
    });

    await Promise.all([
      chatWithRotation(
        {
          model: "sarvam-m",
          messages: [{ role: "user", content: "run-1" }]
        },
        { accountManager: manager, sarvamBaseUrl: server.baseUrl }
      ),
      chatWithRotation(
        {
          model: "sarvam-m",
          messages: [{ role: "user", content: "run-2" }]
        },
        { accountManager: manager, sarvamBaseUrl: server.baseUrl }
      )
    ]);

    const listed = await manager.listAccounts();
    expect(listed[0].credits).toBe(800);
  });

  it("scenario E: forwards requested model options and strips tool messages", async () => {
    server.setBehavior("key-options", {
      chatQueue: [
        {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "ok-options" } }],
            usage: { total_tokens: 40 }
          }
        }
      ]
    });

    const store = new FileAccountStore(path.join(tempDir, "accounts.json"));
    storesToClose.push(store);
    await store.init();
    const manager = new AccountManager(store);
    await manager.addAccount({ email: "options@example.com", apiKey: "key-options", initialCredits: 500 });

    const response = await chatWithRotation(
      {
        model: "sarvam/sarvam-105b",
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "hello" },
          { role: "tool", content: "tool output should not reach Sarvam" }
        ],
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 256
      },
      { accountManager: manager, sarvamBaseUrl: server.baseUrl }
    );

    expect(response.choices[0].message.content).toBe("ok-options");
    expect(server.getLastChatRequest("key-options")?.body).toEqual({
      model: "sarvam-105b",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" }
      ],
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 256
    });
  });
});
