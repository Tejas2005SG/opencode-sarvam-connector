import {
  AccountStore,
  decryptApiKey,
  encryptApiKey,
  parseMasterKeyFromEnv
} from "./accounts";
import { logger } from "./logger";
import { ChatMessage, PublicAccount, StoredAccount } from "./types";

export interface AddAccountInput {
  email: string;
  apiKey: string;
  initialCredits?: number;
}

function selectionTier(credits: number | undefined): number {
  if (typeof credits === "number" && credits > 0) {
    return 0;
  }
  if (credits === undefined) {
    return 1;
  }
  return 2;
}

function lastUsedTimestamp(account: StoredAccount): number {
  if (!account.meta?.lastUsed) {
    return 0;
  }
  const parsed = Date.parse(account.meta.lastUsed);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function estimateTokens(text: string, maxResponseTokens = 512): number {
  const inputTokens = Math.ceil(Math.max(0, text.length) / 4);
  return inputTokens + Math.max(0, Math.floor(maxResponseTokens));
}

export function estimateTokensFromMessages(
  messages: ChatMessage[],
  maxResponseTokens = 512
): number {
  const combined = messages.map((message) => message.content).join("\n");
  return estimateTokens(combined, maxResponseTokens);
}

export function sortAccountsForSelection(
  accounts: StoredAccount[],
  defaultEmail?: string,
  excludedEmails: Set<string> = new Set()
): StoredAccount[] {
  return accounts
    .filter((account) => !excludedEmails.has(account.email))
    .filter((account) => account.credits === undefined || account.credits > 0)
    .sort((left, right) => {
      const leftTier = selectionTier(left.credits);
      const rightTier = selectionTier(right.credits);
      if (leftTier !== rightTier) {
        return leftTier - rightTier;
      }

      const leftIsDefault = left.email === defaultEmail ? 1 : 0;
      const rightIsDefault = right.email === defaultEmail ? 1 : 0;
      if (leftIsDefault !== rightIsDefault) {
        return rightIsDefault - leftIsDefault;
      }

      if (leftTier === 0) {
        return (right.credits ?? 0) - (left.credits ?? 0);
      }

      const leftLastUsed = lastUsedTimestamp(left);
      const rightLastUsed = lastUsedTimestamp(right);
      if (leftLastUsed !== rightLastUsed) {
        return leftLastUsed - rightLastUsed;
      }

      return left.email.localeCompare(right.email);
    });
}

export function pickActiveAccount(
  accounts: StoredAccount[],
  defaultEmail?: string,
  excludedEmails: Set<string> = new Set()
): StoredAccount | undefined {
  return sortAccountsForSelection(accounts, defaultEmail, excludedEmails)[0];
}

export class AccountManager {
  public constructor(private readonly store: AccountStore) {}

  public async addAccount(input: AddAccountInput): Promise<void> {
    const key = parseMasterKeyFromEnv();
    const encryptedApiKey = encryptApiKey(input.apiKey, key);
    const credits = input.initialCredits === undefined ? undefined : Math.max(0, Math.floor(input.initialCredits));
    await this.store.upsertAccount({
      email: input.email,
      encryptedApiKey,
      credits,
      meta: {}
    });
    logger.info({ event: "account_added", email: input.email });
  }

  public async listAccounts(): Promise<PublicAccount[]> {
    const accounts = await this.store.listAccounts();
    const defaultEmail = await this.store.getDefaultEmail();
    return accounts.map((account) => ({
      email: account.email,
      credits: account.credits,
      lastUsed: account.meta?.lastUsed,
      exhaustedAt: account.meta?.exhaustedAt,
      isDefault: account.email === defaultEmail
    }));
  }

  public async removeAccount(email: string): Promise<boolean> {
    const removed = await this.store.removeAccount(email);
    if (removed) {
      logger.info({ event: "account_removed", email });
    }
    return removed;
  }

  public async setDefault(email: string): Promise<void> {
    await this.store.setDefault(email);
  }

  public async decryptAccount(email: string): Promise<string> {
    const key = parseMasterKeyFromEnv();
    const account = await this.store.getAccount(email);
    if (!account) {
      throw new Error(`Account ${email} does not exist.`);
    }
    return decryptApiKey(account.encryptedApiKey, key);
  }

  public async pickActive(excludedEmails: Set<string> = new Set()): Promise<StoredAccount | undefined> {
    const [accounts, defaultEmail] = await Promise.all([
      this.store.listAccounts(),
      this.store.getDefaultEmail()
    ]);
    return pickActiveAccount(accounts, defaultEmail, excludedEmails);
  }

  public async markExhausted(email: string): Promise<void> {
    await this.store.markExhausted(email);
    logger.warn({ event: "account_exhausted", email });
  }

  public async touchLastUsed(email: string): Promise<void> {
    await this.store.touchLastUsed(email);
  }

  public async setCredits(email: string, credits: number): Promise<void> {
    await this.store.setCredits(email, credits);
  }

  public async fudgeCredits(email: string, credits: number): Promise<void> {
    await this.store.setCredits(email, credits);
  }

  public async deductEstimated(
    email: string,
    messages: ChatMessage[],
    maxTokens: number | undefined,
    exactUsageTokens?: number
  ): Promise<number | undefined> {
    const tokensToDeduct =
      exactUsageTokens && exactUsageTokens > 0
        ? Math.floor(exactUsageTokens)
        : estimateTokensFromMessages(messages, maxTokens ?? 512);
    const next = await this.store.deductCredits(email, tokensToDeduct);
    logger.info({ event: "deducted", email, tokens: tokensToDeduct, remainingCredits: next });
    return next;
  }

  public async getCredential(email: string): Promise<string> {
    return this.decryptAccount(email);
  }
}
