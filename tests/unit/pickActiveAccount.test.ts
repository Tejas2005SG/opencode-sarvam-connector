import { pickActiveAccount, sortAccountsForSelection } from "../../src/accountManager";
import { StoredAccount } from "../../src/types";

describe("pickActiveAccount", () => {
  it("prefers known positive credits highest first", () => {
    const accounts: StoredAccount[] = [
      { email: "unknown@example.com", encryptedApiKey: "enc1" },
      { email: "low@example.com", encryptedApiKey: "enc2", credits: 50 },
      { email: "high@example.com", encryptedApiKey: "enc3", credits: 1000 }
    ];
    const picked = pickActiveAccount(accounts);
    expect(picked?.email).toBe("high@example.com");
  });

  it("uses unknown credit account when no known-positive account exists", () => {
    const accounts: StoredAccount[] = [
      { email: "zero@example.com", encryptedApiKey: "enc1", credits: 0 },
      { email: "unknown@example.com", encryptedApiKey: "enc2" }
    ];
    const picked = pickActiveAccount(accounts);
    expect(picked?.email).toBe("unknown@example.com");
  });

  it("honors default account as tiebreaker", () => {
    const accounts: StoredAccount[] = [
      { email: "a@example.com", encryptedApiKey: "enc1", credits: 100 },
      { email: "b@example.com", encryptedApiKey: "enc2", credits: 100 }
    ];
    const ordered = sortAccountsForSelection(accounts, "b@example.com");
    expect(ordered[0].email).toBe("b@example.com");
  });
});
