import { estimateTokens, estimateTokensFromMessages } from "../../src/accountManager";

describe("estimateTokens", () => {
  it("estimates tokens with char/4 + response budget", () => {
    expect(estimateTokens("12345678", 100)).toBe(102);
    expect(estimateTokens("", 50)).toBe(50);
  });

  it("estimates from messages", () => {
    const result = estimateTokensFromMessages(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" }
      ],
      20
    );
    expect(result).toBeGreaterThanOrEqual(22);
  });
});
