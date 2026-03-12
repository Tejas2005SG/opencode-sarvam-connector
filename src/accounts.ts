import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { MissingStoreKeyError, StoredAccount } from "./types";

const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;

interface FileStoreState {
  accounts: StoredAccount[];
  defaultEmail?: string;
}

interface SqliteAccountRow {
  email: string;
  encryptedApiKey: string;
  credits: number | null;
  meta: string | null;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  public async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export interface AccountStore {
  init(): Promise<void>;
  close(): Promise<void>;
  listAccounts(): Promise<StoredAccount[]>;
  getAccount(email: string): Promise<StoredAccount | undefined>;
  upsertAccount(account: StoredAccount): Promise<void>;
  removeAccount(email: string): Promise<boolean>;
  setDefault(email: string): Promise<void>;
  getDefaultEmail(): Promise<string | undefined>;
  markExhausted(email: string): Promise<void>;
  setCredits(email: string, credits?: number): Promise<void>;
  deductCredits(email: string, amount: number): Promise<number | undefined>;
  touchLastUsed(email: string): Promise<void>;
}

export interface CreateStoreOptions {
  backend?: "file" | "sqlite";
  filePath?: string;
  sqlitePath?: string;
}

export function parseMasterKeyFromEnv(envValue = process.env.SARVAM_STORE_KEY): Buffer {
  if (!envValue) {
    throw new MissingStoreKeyError();
  }

  const key = Buffer.from(envValue, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error("SARVAM_STORE_KEY must be a base64-encoded 32-byte key.");
  }

  return key;
}

export function encryptApiKey(plainText: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptApiKey(cipherText: string, key: Buffer): string {
  const raw = Buffer.from(cipherText, "base64");
  if (raw.length <= IV_LENGTH_BYTES + TAG_LENGTH_BYTES) {
    throw new Error("Encrypted API key payload is malformed.");
  }

  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const tag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
  const encrypted = raw.subarray(IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

export function resolveConfigBasePath(): string {
  const configured = process.env.OPENCODE_CONFIG_PATH;
  if (!configured) {
    return path.join(os.homedir(), ".config", "opencode");
  }
  return configured;
}

export function resolveFileStorePath(filePath?: string): string {
  if (filePath) {
    return filePath;
  }

  const configured = resolveConfigBasePath();
  if (configured.toLowerCase().endsWith(".json")) {
    return configured;
  }

  return path.join(configured, "sarvam_accounts.json");
}

export function resolveSqliteStorePath(sqlitePath?: string): string {
  if (sqlitePath) {
    return sqlitePath;
  }

  const configured = resolveConfigBasePath();
  if (configured.toLowerCase().endsWith(".db")) {
    return configured;
  }

  return path.join(configured, "sarvam_accounts.db");
}

function normalizeCredits(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function parseMeta(metaRaw: string | null): StoredAccount["meta"] | undefined {
  if (!metaRaw) {
    return undefined;
  }

  const parsed = JSON.parse(metaRaw) as StoredAccount["meta"];
  return parsed;
}

function serializeMeta(meta: StoredAccount["meta"] | undefined): string | null {
  if (!meta) {
    return null;
  }
  return JSON.stringify(meta);
}

export class FileAccountStore implements AccountStore {
  private readonly filePath: string;
  private readonly mutex = new AsyncMutex();

  public constructor(filePath = resolveFileStorePath()) {
    this.filePath = filePath;
  }

  public async init(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        await fs.promises.access(this.filePath);
      } catch {
        await this.writeState({ accounts: [] });
      }
    });
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }

  public async listAccounts(): Promise<StoredAccount[]> {
    return this.mutex.runExclusive(async () => {
      const state = await this.readState();
      return state.accounts.map((account) => ({ ...account }));
    });
  }

  public async getAccount(email: string): Promise<StoredAccount | undefined> {
    return this.mutex.runExclusive(async () => {
      const state = await this.readState();
      const account = state.accounts.find((item) => item.email === email);
      return account ? { ...account } : undefined;
    });
  }

  public async upsertAccount(account: StoredAccount): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const state = await this.readState();
      const index = state.accounts.findIndex((item) => item.email === account.email);
      const normalized: StoredAccount = {
        email: account.email,
        encryptedApiKey: account.encryptedApiKey,
        credits: normalizeCredits(account.credits),
        meta: account.meta
      };

      if (index >= 0) {
        state.accounts[index] = normalized;
      } else {
        state.accounts.push(normalized);
      }

      await this.writeState(state);
    });
  }

  public async removeAccount(email: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const state = await this.readState();
      const before = state.accounts.length;
      state.accounts = state.accounts.filter((item) => item.email !== email);
      if (state.defaultEmail === email) {
        delete state.defaultEmail;
      }

      if (state.accounts.length !== before) {
        await this.writeState(state);
        return true;
      }

      return false;
    });
  }

  public async setDefault(email: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const state = await this.readState();
      const exists = state.accounts.some((item) => item.email === email);
      if (!exists) {
        throw new Error(`Account ${email} does not exist.`);
      }
      state.defaultEmail = email;
      await this.writeState(state);
    });
  }

  public async getDefaultEmail(): Promise<string | undefined> {
    return this.mutex.runExclusive(async () => {
      const state = await this.readState();
      return state.defaultEmail;
    });
  }

  public async markExhausted(email: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const state = await this.readState();
      const account = state.accounts.find((item) => item.email === email);
      if (!account) {
        return;
      }

      account.credits = 0;
      account.meta = {
        ...account.meta,
        exhaustedAt: new Date().toISOString()
      };
      await this.writeState(state);
    });
  }

  public async setCredits(email: string, credits?: number): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const state = await this.readState();
      const account = state.accounts.find((item) => item.email === email);
      if (!account) {
        throw new Error(`Account ${email} does not exist.`);
      }

      account.credits = normalizeCredits(credits);
      await this.writeState(state);
    });
  }

  public async deductCredits(email: string, amount: number): Promise<number | undefined> {
    return this.mutex.runExclusive(async () => {
      const state = await this.readState();
      const account = state.accounts.find((item) => item.email === email);
      if (!account) {
        throw new Error(`Account ${email} does not exist.`);
      }

      if (account.credits === undefined) {
        return undefined;
      }

      const next = Math.max(0, account.credits - amount);
      account.credits = next;
      await this.writeState(state);
      return next;
    });
  }

  public async touchLastUsed(email: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const state = await this.readState();
      const account = state.accounts.find((item) => item.email === email);
      if (!account) {
        return;
      }

      account.meta = {
        ...account.meta,
        lastUsed: new Date().toISOString()
      };
      await this.writeState(state);
    });
  }

  private async readState(): Promise<FileStoreState> {
    const raw = await fs.promises.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as FileStoreState;
    return {
      defaultEmail: parsed.defaultEmail,
      accounts: (parsed.accounts ?? []).map((account) => ({
        ...account,
        credits: normalizeCredits(account.credits)
      }))
    };
  }

  private async writeState(state: FileStoreState): Promise<void> {
    const tempPath = `${this.filePath}.tmp`;
    const payload = JSON.stringify(state, null, 2);
    await fs.promises.writeFile(tempPath, payload, "utf8");
    await fs.promises.rename(tempPath, this.filePath);
  }
}

export class SqliteAccountStore implements AccountStore {
  private readonly dbPath: string;
  private readonly db: Database.Database;

  public constructor(dbPath = resolveSqliteStorePath()) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  public async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        email TEXT PRIMARY KEY,
        encryptedApiKey TEXT NOT NULL,
        credits INTEGER,
        meta TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  public async close(): Promise<void> {
    this.db.close();
  }

  public async listAccounts(): Promise<StoredAccount[]> {
    const rows = this.db
      .prepare("SELECT email, encryptedApiKey, credits, meta FROM accounts ORDER BY email ASC")
      .all() as SqliteAccountRow[];

    return rows.map((row) => ({
      email: row.email,
      encryptedApiKey: row.encryptedApiKey,
      credits: normalizeCredits(row.credits),
      meta: parseMeta(row.meta)
    }));
  }

  public async getAccount(email: string): Promise<StoredAccount | undefined> {
    const row = this.db
      .prepare("SELECT email, encryptedApiKey, credits, meta FROM accounts WHERE email = ?")
      .get(email) as SqliteAccountRow | undefined;
    if (!row) {
      return undefined;
    }

    return {
      email: row.email,
      encryptedApiKey: row.encryptedApiKey,
      credits: normalizeCredits(row.credits),
      meta: parseMeta(row.meta)
    };
  }

  public async upsertAccount(account: StoredAccount): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO accounts (email, encryptedApiKey, credits, meta)
         VALUES (@email, @encryptedApiKey, @credits, @meta)
         ON CONFLICT(email) DO UPDATE SET
           encryptedApiKey = excluded.encryptedApiKey,
           credits = excluded.credits,
           meta = excluded.meta`
      )
      .run({
        email: account.email,
        encryptedApiKey: account.encryptedApiKey,
        credits: normalizeCredits(account.credits) ?? null,
        meta: serializeMeta(account.meta)
      });
  }

  public async removeAccount(email: string): Promise<boolean> {
    const accountResult = this.db.prepare("DELETE FROM accounts WHERE email = ?").run(email);
    this.db.prepare("DELETE FROM settings WHERE key = 'defaultEmail' AND value = ?").run(email);
    return accountResult.changes > 0;
  }

  public async setDefault(email: string): Promise<void> {
    const account = await this.getAccount(email);
    if (!account) {
      throw new Error(`Account ${email} does not exist.`);
    }

    this.db
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES ('defaultEmail', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(email);
  }

  public async getDefaultEmail(): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'defaultEmail'")
      .get() as { value: string } | undefined;
    return row?.value;
  }

  public async markExhausted(email: string): Promise<void> {
    const existing = await this.getAccount(email);
    if (!existing) {
      return;
    }

    const nextMeta = {
      ...existing.meta,
      exhaustedAt: new Date().toISOString()
    };
    this.db
      .prepare("UPDATE accounts SET credits = 0, meta = ? WHERE email = ?")
      .run(JSON.stringify(nextMeta), email);
  }

  public async setCredits(email: string, credits?: number): Promise<void> {
    const normalized = normalizeCredits(credits);
    this.db.prepare("UPDATE accounts SET credits = ? WHERE email = ?").run(normalized ?? null, email);
  }

  public async deductCredits(email: string, amount: number): Promise<number | undefined> {
    const tx = this.db.transaction((targetEmail: string, tokens: number): number | undefined => {
      const row = this.db
        .prepare("SELECT credits FROM accounts WHERE email = ?")
        .get(targetEmail) as { credits: number | null } | undefined;
      if (!row) {
        throw new Error(`Account ${targetEmail} does not exist.`);
      }

      if (row.credits === null || row.credits === undefined) {
        return undefined;
      }

      const nextCredits = Math.max(0, row.credits - Math.max(0, Math.floor(tokens)));
      this.db.prepare("UPDATE accounts SET credits = ? WHERE email = ?").run(nextCredits, targetEmail);
      return nextCredits;
    });

    return tx(email, amount);
  }

  public async touchLastUsed(email: string): Promise<void> {
    const account = await this.getAccount(email);
    if (!account) {
      return;
    }

    const nextMeta = {
      ...account.meta,
      lastUsed: new Date().toISOString()
    };
    this.db
      .prepare("UPDATE accounts SET meta = ? WHERE email = ?")
      .run(JSON.stringify(nextMeta), email);
  }
}

export function createAccountStore(options: CreateStoreOptions = {}): AccountStore {
  const backend = options.backend ?? (process.env.SARVAM_STORE_BACKEND as "file" | "sqlite" | undefined) ?? "file";
  if (backend === "sqlite") {
    return new SqliteAccountStore(
      resolveSqliteStorePath(options.sqlitePath ?? process.env.SARVAM_SQLITE_PATH)
    );
  }

  return new FileAccountStore(resolveFileStorePath(options.filePath ?? process.env.SARVAM_FILE_PATH));
}
