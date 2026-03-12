import { decryptApiKey, encryptApiKey, parseMasterKeyFromEnv } from "../../src/accounts";

describe("encryption", () => {
  it("encrypts and decrypts API keys roundtrip", () => {
    const keyBase64 = Buffer.alloc(32, 7).toString("base64");
    const key = parseMasterKeyFromEnv(keyBase64);
    const secret = "sarvam-secret-key-123";

    const encrypted = encryptApiKey(secret, key);
    expect(encrypted).not.toBe(secret);

    const decrypted = decryptApiKey(encrypted, key);
    expect(decrypted).toBe(secret);
  });
});
