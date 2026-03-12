import { AccountManager } from "./accountManager";
import { chatWithRotation } from "./sarvamProxy";
import { ChatMessage } from "./types";

export const SARVAM_MODELS = ["sarvam-105b", "sarvam-30b", "sarvam-m"];

export interface OpenCodeChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  models: string[];
  chat(request: OpenCodeChatRequest): Promise<unknown>;
}

export function createSarvamOpenCodeProvider(options: {
  accountManager?: AccountManager;
  sarvamBaseUrl?: string;
} = {}): OpenCodeProvider {
  return {
    id: "sarvam",
    name: "Sarvam Multi Auth",
    models: SARVAM_MODELS.map((model) => `sarvam/${model}`),
    chat: async (request: OpenCodeChatRequest): Promise<unknown> =>
      chatWithRotation(
        {
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          top_p: request.top_p,
          max_tokens: request.max_tokens
        },
        {
          accountManager: options.accountManager,
          sarvamBaseUrl: options.sarvamBaseUrl
        }
      )
  };
}

export default createSarvamOpenCodeProvider;
