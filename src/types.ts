export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatWithRotationInput {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export interface AccountMeta {
  lastUsed?: string;
  exhaustedAt?: string;
}

export interface StoredAccount {
  email: string;
  encryptedApiKey: string;
  credits?: number;
  meta?: AccountMeta;
}

export interface PublicAccount {
  email: string;
  credits?: number;
  lastUsed?: string;
  exhaustedAt?: string;
  isDefault: boolean;
}

export class NoSarvamAccountsAvailable extends Error {
  public readonly code = "NoSarvamAccountsAvailable";

  public constructor(message = "No Sarvam accounts are available for this request.") {
    super(message);
    this.name = "NoSarvamAccountsAvailable";
  }
}

export class MissingStoreKeyError extends Error {
  public constructor() {
    super(
      "Missing SARVAM_STORE_KEY. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
    this.name = "MissingStoreKeyError";
  }
}
