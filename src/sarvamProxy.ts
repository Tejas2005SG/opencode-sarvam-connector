import { setTimeout as wait } from "timers/promises";
import { AccountManager } from "./accountManager";
import { createAccountStore } from "./accounts";
import { logger, safeErrorMessage } from "./logger";
import { ChatMessage, ChatWithRotationInput, NoSarvamAccountsAvailable } from "./types";

const DEFAULT_BASE_URL = "https://api.sarvam.ai";
const DEFAULT_RETRY_DELAYS = [500, 2000, 4000];

type SarvamErrorType = "auth" | "quota" | "transient" | "fatal";

interface NormalizedSarvamError {
  type: SarvamErrorType;
  status?: number;
  message: string;
}

export interface RequestSuccess {
  body: any;
  headers: Headers;
}

export interface SarvamRequestOptions {
  sarvamBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SarvamProxyOptions {
  accountManager?: AccountManager;
  sarvamBaseUrl?: string;
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
}

class RotationLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  public constructor(private readonly maxConcurrency: number) {}

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}

const limiter = new RotationLimiter(
  Math.max(1, Number.parseInt(process.env.SARVAM_MAX_CONCURRENT_ROTATIONS ?? "5", 10))
);

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "api-subscription-key": apiKey,
    Authorization: `Bearer ${apiKey}`
  };
}

function normalizeModel(model: string): string {
  return model.startsWith("sarvam/") ? model.slice("sarvam/".length) : model;
}

export function toSarvamMessages(messages: ChatMessage[]): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  return messages
    .filter((message) => message.role !== "tool")
    .map((message) => {
      if (message.role === "assistant") {
        return { role: "assistant" as const, content: message.content };
      }
      if (message.role === "system") {
        return { role: "system" as const, content: message.content };
      }
      return { role: "user" as const, content: message.content };
    });
}

export function resolveSarvamBaseUrl(baseUrl?: string): string {
  const candidate = baseUrl?.trim();
  if (
    !candidate ||
    candidate.length === 0 ||
    candidate.toLowerCase() === "undefined" ||
    candidate.toLowerCase() === "null"
  ) {
    return DEFAULT_BASE_URL;
  }
  return candidate.replace(/\/$/, "");
}

function classifyError(status: number | undefined, message: string): SarvamErrorType {
  const lower = message.toLowerCase();
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (
    status === 429 ||
    lower.includes("quota") ||
    lower.includes("credit") ||
    lower.includes("insufficient") ||
    lower.includes("exhaust")
  ) {
    return "quota";
  }
  if (status === undefined || status >= 500 || status === 408) {
    return "transient";
  }
  return "fatal";
}

function normalizeThrownError(error: unknown): NormalizedSarvamError {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const typed = error as { status: number; message?: string };
    const message = typed.message ?? "Sarvam API request failed";
    return {
      type: classifyError(typed.status, message),
      status: typed.status,
      message
    };
  }

  const message = safeErrorMessage(error);
  return {
    type: classifyError(undefined, message),
    message
  };
}

function parseUsageTokens(body: any): number | undefined {
  const usage = body?.usage;
  if (!usage) {
    return undefined;
  }

  const totalTokens = usage.total_tokens ?? usage.totalTokens;
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) {
    return Math.max(0, Math.floor(totalTokens));
  }
  return undefined;
}

function parseRemainingCredits(headers: Headers): number | undefined {
  const candidates = [
    headers.get("x-sarvam-credits-remaining"),
    headers.get("x-credits-remaining"),
    headers.get("x-remaining-credits")
  ];
  for (const value of candidates) {
    if (!value) {
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

export async function requestSarvamChatCompletion(
  apiKey: string,
  input: ChatWithRotationInput,
  options: SarvamRequestOptions = {}
): Promise<RequestSuccess> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = resolveSarvamBaseUrl(options.sarvamBaseUrl ?? process.env.SARVAM_BASE_URL);

  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify({
      model: normalizeModel(input.model),
      messages: toSarvamMessages(input.messages),
      temperature: input.temperature,
      top_p: input.top_p,
      max_tokens: input.max_tokens
    })
  });

  const text = await response.text();
  let body: any = {};
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }

  if (!response.ok) {
    const errorMessage =
      body?.error?.message ?? body?.message ?? `Sarvam API request failed with HTTP ${response.status}`;
    throw {
      status: response.status,
      message: errorMessage
    };
  }

  return { body, headers: response.headers };
}

async function resolveAccountManager(options: SarvamProxyOptions): Promise<AccountManager> {
  if (options.accountManager) {
    return options.accountManager;
  }

  const store = createAccountStore();
  await store.init();
  return new AccountManager(store);
}

export async function validateSarvamApiKey(
  apiKey: string,
  options: { sarvamBaseUrl?: string; fetchImpl?: typeof fetch } = {}
): Promise<{ valid: boolean; status: number; message: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = resolveSarvamBaseUrl(options.sarvamBaseUrl ?? process.env.SARVAM_BASE_URL);
  const response = await fetchImpl(`${baseUrl}/v1/models`, {
    method: "GET",
    headers: buildHeaders(apiKey)
  });

  const message = response.ok
    ? "API key is valid."
    : `Sarvam validation failed with HTTP ${response.status}.`;
  return {
    valid: response.ok,
    status: response.status,
    message
  };
}

export async function chatWithRotation(
  input: ChatWithRotationInput,
  options: SarvamProxyOptions = {}
): Promise<any> {
  return limiter.run(async () => {
    const accountManager = await resolveAccountManager(options);
    const exhaustedEmails = new Set<string>();
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    let shouldRotate = true;

    while (shouldRotate) {
      shouldRotate = false;
      const account = await accountManager.pickActive(exhaustedEmails);
      if (!account) {
        throw new NoSarvamAccountsAvailable();
      }

      const apiKey = await accountManager.getCredential(account.email);
      if (exhaustedEmails.size > 0) {
        logger.info({ event: "rotation_used", email: account.email });
      }

        let transientRetries = 0;
        let retryCurrentAccount = true;
        while (retryCurrentAccount) {
          try {
            const success = await requestSarvamChatCompletion(apiKey, input, options);
            const usageTokens = parseUsageTokens(success.body);
            const remainingCredits = parseRemainingCredits(success.headers);
            if (remainingCredits !== undefined) {
            await accountManager.setCredits(account.email, remainingCredits);
          } else {
            await accountManager.deductEstimated(
              account.email,
              input.messages,
              input.max_tokens,
              usageTokens
            );
          }
          await accountManager.touchLastUsed(account.email);
          return success.body;
        } catch (error) {
          const normalizedError = normalizeThrownError(error);
          logger.warn({
            event: "sarvam_error",
            type: normalizedError.type,
            code: normalizedError.status,
            message: normalizedError.message
          });

          if (normalizedError.type === "auth" || normalizedError.type === "quota") {
            await accountManager.markExhausted(account.email);
            exhaustedEmails.add(account.email);
            shouldRotate = true;
            retryCurrentAccount = false;
            continue;
          }

          if (normalizedError.type === "transient") {
            if (transientRetries < retryDelays.length) {
              const backoffMs = retryDelays[transientRetries];
              transientRetries += 1;
              await wait(backoffMs);
              continue;
            }

            exhaustedEmails.add(account.email);
            shouldRotate = true;
            retryCurrentAccount = false;
            continue;
          }

          throw new Error(normalizedError.message);
        }
      }
    }
  });
}
