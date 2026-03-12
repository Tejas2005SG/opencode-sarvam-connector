import crypto from "crypto";
import { AccountManager } from "./accountManager";
import { createAccountStore } from "./accounts";
import { logger, safeErrorMessage } from "./logger";
import {
  chatWithRotation,
  requestSarvamChatCompletion,
  resolveSarvamBaseUrl,
  validateSarvamApiKey
} from "./sarvamProxy";
import { ChatMessage, NoSarvamAccountsAvailable } from "./types";
import type {
  ApiKeyAuthDetails,
  AuthDetails,
  FetchInput,
  GetAuth,
  LoaderResult,
  PluginContext,
  PluginResult,
  Provider,
  SarvamAuthExchangeResult
} from "./pluginTypes";

/** Derive a stable, unique internal identifier from an API key (sha256-based). */
function keyIdentifier(apiKey: string): string {
  const hash = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  return `key-${hash}@sarvam.local`;
}

function isApiKeyAuth(auth: AuthDetails): auth is ApiKeyAuthDetails {
  return auth.type === "api_key" && typeof auth.key === "string" && auth.key.length > 0;
}

function normalizeModel(model: string): string {
  return model.startsWith("sarvam/") ? model : `sarvam/${model}`;
}

function normalizeMessages(rawMessages: Array<{ role: string; content: string }> | undefined): ChatMessage[] {
  if (!rawMessages) {
    return [];
  }

  return rawMessages.map((message, index) => {
    if (typeof message.content !== "string") {
      throw new Error(`Invalid message content at index ${index}.`);
    }

    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "tool"
    ) {
      throw new Error(`Invalid chat role at index ${index}: ${message.role}`);
    }

    return {
      role: message.role,
      content: message.content
    };
  });
}

/**
 * Parse one or more API keys from user input.
 *
 * Supported formats:
 *   - Single plain API key:          `sk-xxx`
 *   - Multiple keys (newline):       `sk-aaa\nsk-bbb`
 *   - Multiple keys (comma):         `sk-aaa,sk-bbb`
 *   - JSON object (single):          `{"apiKey":"sk-xxx","initialCredits":5000}`
 *   - JSON array (multiple):         `[{"apiKey":"sk-aaa"},{"apiKey":"sk-bbb"}]`
 *   - Legacy email:key[:credits]:    `user@example.com:sk-xxx:5000`
 */
function parseKeyInputs(input: string): Array<{ keyId: string; apiKey: string; initialCredits?: number }> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Input is empty.");
  }

  // JSON array
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as Array<{ apiKey?: string; initialCredits?: number }>;
    return arr.map((item, i) => {
      if (!item.apiKey) throw new Error(`Entry at index ${i} must include apiKey.`);
      return {
        keyId: keyIdentifier(item.apiKey),
        apiKey: item.apiKey,
        initialCredits:
          typeof item.initialCredits === "number" && item.initialCredits >= 0
            ? Math.floor(item.initialCredits)
            : undefined
      };
    });
  }

  // JSON object (single key)
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as { apiKey?: string; initialCredits?: number };
    if (!parsed.apiKey) throw new Error("JSON input must include apiKey.");
    return [
      {
        keyId: keyIdentifier(parsed.apiKey),
        apiKey: parsed.apiKey,
        initialCredits:
          typeof parsed.initialCredits === "number" && parsed.initialCredits >= 0
            ? Math.floor(parsed.initialCredits)
            : undefined
      }
    ];
  }

  // One or more plain keys (newline or comma separated), with legacy email:key support
  const lines = trimmed.split(/[\n,]+/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.map((line) => {
    // Legacy format: email:apiKey[:credits]
    const parts = line.split(":");
    if (parts.length >= 2 && parts[0]?.includes("@")) {
      const apiKey = parts[1].trim();
      if (apiKey.length === 0) throw new Error("API key is required.");
      let initialCredits: number | undefined;
      if (parts[2] && parts[2].trim().length > 0) {
        const c = Number.parseInt(parts[2].trim(), 10);
        if (!Number.isNaN(c) && c >= 0) initialCredits = c;
      }
      return { keyId: keyIdentifier(apiKey), apiKey, initialCredits };
    }
    // Plain API key
    return { keyId: keyIdentifier(line), apiKey: line };
  });
}

async function chatWithDirectApiKey(
  apiKey: string,
  payload: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  }
): Promise<unknown> {
  const response = await requestSarvamChatCompletion(
    apiKey,
    {
      model: payload.model,
      messages: payload.messages,
      temperature: payload.temperature,
      top_p: payload.top_p,
      max_tokens: payload.max_tokens
    },
    { sarvamBaseUrl: process.env.SARVAM_BASE_URL }
  );
  return response.body;
}

function toJsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function getRequestBodyText(input: FetchInput, init?: RequestInit): Promise<string> {
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return "";
    }
  }

  if (typeof init?.body === "string") {
    return init.body;
  }

  if (init?.body instanceof URLSearchParams) {
    return init.body.toString();
  }

  if (init?.body instanceof Uint8Array) {
    return Buffer.from(init.body).toString("utf8");
  }

  if (init?.body instanceof ArrayBuffer) {
    return Buffer.from(init.body).toString("utf8");
  }

  return "";
}

function getRequestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function extractModelFromRequestUrl(requestUrl: string): string | undefined {
  const modelPathMatch = requestUrl.match(/\/models\/([^:/?]+)(?::\w+)?/);
  if (modelPathMatch?.[1]) {
    return modelPathMatch[1];
  }

  const queryMatch = requestUrl.match(/[?&]model=([^&]+)/);
  if (queryMatch?.[1]) {
    return decodeURIComponent(queryMatch[1]);
  }

  return undefined;
}

async function buildLoaderResult(
  getAuth: GetAuth,
  provider: Provider,
  manager: AccountManager
): Promise<LoaderResult> {
  if (provider.models) {
    for (const model of Object.values(provider.models)) {
      if (model) {
        model.cost = { input: 0, output: 0 };
      }
    }
  }

  const sarvamBaseUrl = resolveSarvamBaseUrl(process.env.SARVAM_BASE_URL);

  function fixBrokenUrl(rawUrl: string): string {
    // OpenCode builds URL as `${provider.baseURL}/path`. If baseURL is not
    // configured in opencode.json, it becomes "undefined/path". Rewrite it.
    return rawUrl.replace(/^(undefined|null)(\/|$)/, `${sarvamBaseUrl}$2`);
  }

  function fixInput(input: FetchInput): FetchInput {
    if (typeof input === "string") {
      return fixBrokenUrl(input);
    }
    if (input instanceof URL) {
      return new URL(fixBrokenUrl(input.toString()));
    }
    const fixedUrl = fixBrokenUrl(input.url);
    if (fixedUrl !== input.url) {
      return new Request(fixedUrl, input);
    }
    return input;
  }

  return {
    apiKey: "",
    // Expose baseURL so OpenCode builds valid request URLs even when the user
    // has not configured provider.baseURL in opencode.json. Without this,
    // OpenCode produces "undefined/chat/completions" which Node rejects before
    // our fetch interceptor can run.
    baseURL: `${sarvamBaseUrl}/v1`,
    async fetch(rawInput: FetchInput, init?: RequestInit): Promise<Response> {
      // Rewrite broken base URL before any processing.
      // OpenCode builds `${provider.baseURL}/path`; if baseURL is unconfigured
      // that produces "undefined/path" which Node fetch rejects outright.
      const input = fixInput(rawInput);
      const requestUrl = getRequestUrl(input);
      const isChatCompletions = requestUrl.includes("chat/completions");

      const bodyText = await getRequestBodyText(input, init);

      // Non-chat-completions paths: pass through (URL is now valid after fixInput)
      if (!isChatCompletions) {
        return fetch(input, init);
      }

      // Parse JSON body
      let payload: {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        temperature?: number;
        top_p?: number;
        max_tokens?: number;
      };
      if (bodyText.trim().length === 0) {
        payload = {};
      } else {
        try {
          payload = JSON.parse(bodyText) as typeof payload;
        } catch {
          return toJsonResponse(400, {
            error: { message: "Invalid JSON body for chat/completions request." }
          });
        }
      }

      const requestedModel = payload.model ?? extractModelFromRequestUrl(requestUrl);
      if (!requestedModel) {
        return toJsonResponse(400, {
          error: { message: "Missing model in request body/url for Sarvam request." }
        });
      }

      // Not a Sarvam model — pass through to original provider
      if (!requestedModel.startsWith("sarvam") && !requestedModel.includes("/sarvam")) {
        return fetch(input, init);
      }

      try {
        const accounts = await manager.listAccounts();
        const normalizedModel = normalizeModel(requestedModel);
        const normalizedMessages = normalizeMessages(payload.messages);

        if (accounts.length > 0) {
          try {
            const responseBody = await chatWithRotation(
              {
                model: normalizedModel,
                messages: normalizedMessages,
                temperature: payload.temperature,
                top_p: payload.top_p,
                max_tokens: payload.max_tokens
              },
              { accountManager: manager }
            );
            return toJsonResponse(200, responseBody as Record<string, unknown>);
          } catch (error) {
            if (!(error instanceof NoSarvamAccountsAvailable)) {
              throw error;
            }
          }
        }

        const auth = await getAuth();
        if (isApiKeyAuth(auth)) {
          const responseBody = await chatWithDirectApiKey(auth.key, {
            model: normalizedModel,
            messages: normalizedMessages,
            temperature: payload.temperature,
            top_p: payload.top_p,
            max_tokens: payload.max_tokens
          });
          return toJsonResponse(200, responseBody as Record<string, unknown>);
        }

        if (accounts.length > 0) {
          const unavailable = new NoSarvamAccountsAvailable();
          return toJsonResponse(429, {
            error: { code: unavailable.code, message: unavailable.message }
          });
        }

        return toJsonResponse(401, {
          error: {
            message: "No Sarvam API key configured. Run `opencode auth login` and select Sarvam."
          }
        });
      } catch (error) {
        logger.error({ event: "sarvam_error", type: "plugin_loader", message: safeErrorMessage(error) });
        return toJsonResponse(500, { error: { message: safeErrorMessage(error) } });
      }
    }
  };
}

async function handleManualAuthLogin(
  codeInput: string,
  manager: AccountManager
): Promise<SarvamAuthExchangeResult> {
  try {
    const entries = parseKeyInputs(codeInput);
    const addedKeyIds: string[] = [];

    for (const entry of entries) {
      const validation = await validateSarvamApiKey(entry.apiKey);
      if (!validation.valid) {
        return {
          type: "failed",
          error: `API key validation failed (HTTP ${validation.status}).`
        };
      }
      await manager.addAccount({ email: entry.keyId, apiKey: entry.apiKey, initialCredits: entry.initialCredits });
      addedKeyIds.push(entry.keyId);
    }

    return {
      type: "success",
      access: "sarvam-multi-auth",
      refresh: `keys=${addedKeyIds.join(",")}`,
      expires: Date.now() + 1000 * 60 * 60 * 24 * 365
    };
  } catch (error) {
    return {
      type: "failed",
      error: safeErrorMessage(error)
    };
  }
}

export const createSarvamPlugin =
  (providerId = "sarvam") =>
  async (_context: PluginContext): Promise<PluginResult> => {
    void _context;
    const store = createAccountStore();
    await store.init();
    const manager = new AccountManager(store);

    return {
      auth: {
        provider: providerId,
        loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>> =>
          buildLoaderResult(getAuth, provider, manager),
        methods: [
          {
            label: "Add Sarvam API Keys (supports multiple, one per line)",
            type: "oauth",
            authorize: async (): Promise<{
              url: string;
              instructions: string;
              method: "code";
              callback: (code: string) => Promise<SarvamAuthExchangeResult>;
            }> => ({
              url: "",
              instructions:
                "Paste one or more Sarvam API keys. Separate multiple keys with newlines or commas. Keys rotate automatically when credits are exhausted. Optionally use JSON format: [{\"apiKey\":\"...\",\"initialCredits\":5000}]",
              method: "code",
              callback: async (codeInput: string): Promise<SarvamAuthExchangeResult> =>
                handleManualAuthLogin(codeInput, manager)
            })
          },
          {
            label: "Single Sarvam API Key",
            type: "api"
          }
        ]
      }
    };
  };

export const SarvamMultiAuthPlugin = createSarvamPlugin("sarvam");
export const SarvamOAuthPlugin = SarvamMultiAuthPlugin;

export async function bootstrapApiKeyAuthIntoStore(auth: AuthDetails): Promise<void> {
  if (!isApiKeyAuth(auth)) {
    return;
  }

  const store = createAccountStore();
  await store.init();
  const manager = new AccountManager(store);
  const keyId = keyIdentifier(auth.key);
  const existing = await manager.listAccounts();
  if (existing.some((item) => item.email === keyId)) {
    return;
  }

  await manager.addAccount({
    email: keyId,
    apiKey: auth.key
  });
}
