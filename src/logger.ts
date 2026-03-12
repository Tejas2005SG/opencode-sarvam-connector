import pino from "pino";

export const logger = pino({
  name: "opencode-sarvam-multi-auth",
  level: process.env.SARVAM_LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "apiKey",
      "*.apiKey",
      "headers.authorization",
      "headers.Authorization",
      "encryptedApiKey"
    ],
    censor: "[REDACTED]"
  }
});

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
