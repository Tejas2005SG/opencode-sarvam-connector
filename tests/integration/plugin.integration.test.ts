import fs from "fs";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";
import { AccountManager } from "../../src/accountManager";
import { FileAccountStore } from "../../src/accounts";
import { createSarvamPlugin } from "../../src/plugin";
import type { LoaderResult, PluginContext } from "../../src/pluginTypes";
import { MockSarvamServer } from "../fixture/mockSarvamServer";

const TEST_MASTER_KEY = Buffer.alloc(32, 17).toString("base64");

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

function asLoaderResult(result: LoaderResult | Record<string, unknown>): LoaderResult {
  if (!("fetch" in result) || typeof result.fetch !== "function") {
    throw new Error("Expected Sarvam auth loader to return a fetch-capable loader result.");
  }
  return result as LoaderResult;
}

describe("createSarvamPlugin integration", () => {
  let server: MockSarvamServer;
  let tempDir: string;
  let previousKey: string | undefined;
  let previousConfigPath: string | undefined;
  let previousBaseUrl: string | undefined;

  beforeEach(async () => {
    previousKey = process.env.SARVAM_STORE_KEY;
    previousConfigPath = process.env.OPENCODE_CONFIG_PATH;
    previousBaseUrl = process.env.SARVAM_BASE_URL;
    process.env.SARVAM_STORE_KEY = TEST_MASTER_KEY;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sarvam-plugin-test-"));
    process.env.OPENCODE_CONFIG_PATH = tempDir;
    server = new MockSarvamServer();
    await server.start();
    process.env.SARVAM_BASE_URL = server.baseUrl;
  });

  afterEach(async () => {
    await server.stop();
    if (previousKey === undefined) {
      delete process.env.SARVAM_STORE_KEY;
    } else {
      process.env.SARVAM_STORE_KEY = previousKey;
    }
    if (previousConfigPath === undefined) {
      delete process.env.OPENCODE_CONFIG_PATH;
    } else {
      process.env.OPENCODE_CONFIG_PATH = previousConfigPath;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.SARVAM_BASE_URL;
    } else {
      process.env.SARVAM_BASE_URL = previousBaseUrl;
    }
    await removeTempDirWithRetry(tempDir);
  });

  it("forwards the selected direct-auth model and top_p to Sarvam", async () => {
    server.setBehavior("direct-key", {
      chatQueue: [
        {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "ok-direct" } }],
            usage: { total_tokens: 30 }
          }
        }
      ]
    });

    const context: PluginContext = {
      client: {},
      directory: tempDir
    };
    const plugin = await createSarvamPlugin("sarvam")(context);
    const loader = asLoaderResult(
      await plugin.auth.loader(
        async () => ({ type: "api_key", key: "direct-key" }),
        { models: { "sarvam-105b": {} } }
      )
    );

    const response = await loader.fetch("undefined/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sarvam-105b",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.5,
        top_p: 1,
        max_tokens: 2000
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "ok-direct" } }]
    });
    expect(server.getLastChatRequest("direct-key")?.body).toEqual({
      model: "sarvam-105b",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.5,
      top_p: 1,
      max_tokens: 2000
    });
  });

  it("keeps sarvam-m on the raw request path and filters tool messages", async () => {
    server.setBehavior("direct-key", {
      chatQueue: [
        {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "ok-sarvam-m" } }],
            usage: { total_tokens: 25 }
          }
        }
      ]
    });

    const context: PluginContext = {
      client: {},
      directory: tempDir
    };
    const plugin = await createSarvamPlugin("sarvam")(context);
    const loader = asLoaderResult(
      await plugin.auth.loader(
        async () => ({ type: "api_key", key: "direct-key" }),
        { models: { "sarvam-m": {} } }
      )
    );

    const response = await loader.fetch("undefined/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sarvam-m",
        messages: [
          { role: "system", content: "you are a coder" },
          { role: "user", content: "write code" },
          { role: "tool", content: "tool output should be removed" }
        ],
        max_tokens: 256
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "ok-sarvam-m" } }]
    });
    expect(server.getLastChatRequest("direct-key")?.body).toEqual({
      model: "sarvam-m",
      messages: [
        { role: "system", content: "you are a coder" },
        { role: "user", content: "write code" }
      ],
      max_tokens: 256
    });
  });

  it("falls back to the direct auth key when stored accounts are exhausted", async () => {
    server.setBehavior("stored-key", {
      chatQueue: [
        {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "should-not-run" } }],
            usage: { total_tokens: 10 }
          }
        }
      ]
    });
    server.setBehavior("direct-key", {
      chatQueue: [
        {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "ok-fallback" } }],
            usage: { total_tokens: 18 }
          }
        }
      ]
    });

    const store = new FileAccountStore(path.join(tempDir, "sarvam_accounts.json"));
    await store.init();
    const manager = new AccountManager(store);
    await manager.addAccount({
      email: "stored@example.com",
      apiKey: "stored-key",
      initialCredits: 0
    });

    const context: PluginContext = {
      client: {},
      directory: tempDir
    };
    const plugin = await createSarvamPlugin("sarvam")(context);
    const loader = asLoaderResult(
      await plugin.auth.loader(
        async () => ({ type: "api_key", key: "direct-key" }),
        { models: { "sarvam-105b": {} } }
      )
    );

    const response = await loader.fetch("undefined/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sarvam-105b",
        messages: [{ role: "user", content: "hello" }]
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "ok-fallback" } }]
    });
    expect(server.getChatRequests("stored-key")).toHaveLength(0);
    expect(server.getLastChatRequest("direct-key")?.body).toEqual({
      model: "sarvam-105b",
      messages: [{ role: "user", content: "hello" }]
    });
  });
});
