#!/usr/bin/env node
import crypto from "crypto";
import { Command } from "commander";
import prompts from "prompts";
import { AccountManager } from "./accountManager";
import { createAccountStore } from "./accounts";
import { safeErrorMessage } from "./logger";
import { validateSarvamApiKey } from "./sarvamProxy";

interface RootOptions {
  json?: boolean;
}

/** Derive the same stable identifier used in plugin.ts. */
function keyIdentifier(apiKey: string): string {
  const hash = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  return `key-${hash}@sarvam.local`;
}

/** Display-friendly masked key: `abcd...wxyz`. */
function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) return "***";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

/**
 * Accept either a full key ID (`key-abc@sarvam.local`), a short ID
 * (`key-abc`), or a legacy email address — and always return the
 * canonical identifier used by the account store.
 */
function resolveKeyId(id: string): string {
  if (!id.includes("@") && id.startsWith("key-")) {
    return `${id}@sarvam.local`;
  }
  return id;
}

/** Strip the internal domain suffix for nicer display output. */
function displayId(email: string): string {
  return email.replace(/@sarvam\.local$/, "");
}

function parseCredits(raw: string | undefined): number | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error("Credits must be a non-negative integer.");
  }
  return parsed;
}

function printOutput(payload: unknown, fallbackMessage: string, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stdout.write(`${fallbackMessage}\n`);
}

function printError(error: unknown, asJson: boolean): void {
  const message = safeErrorMessage(error);
  if (asJson) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          message
        }
      })}\n`
    );
    return;
  }

  process.stderr.write(`Error: ${message}\n`);
}

async function createManager(): Promise<AccountManager> {
  const store = createAccountStore();
  await store.init();
  return new AccountManager(store);
}

async function promptForApiKeys(apiKey?: string): Promise<string[]> {
  if (apiKey) {
    return apiKey.split(/[\n,]+/).map((k) => k.trim()).filter((k) => k.length > 0);
  }
  const response = await prompts(
    {
      type: "text",
      name: "keys",
      message: "Paste one or more Sarvam API keys (separate multiple keys with commas or newlines)",
      validate: (value: string) =>
        value.trim().length > 0 ? true : "At least one API key is required."
    },
    {
      onCancel: () => {
        throw new Error("Operation cancelled.");
      }
    }
  );
  return (response.keys as string).split(/[\n,]+/).map((k) => k.trim()).filter((k) => k.length > 0);
}

async function run(): Promise<void> {
  const program = new Command("opencode");
  program.description("OpenCode CLI").option("--json", "Output machine-readable JSON.");

  const sarvam = program.command("sarvam").description("Sarvam connector account management.");

  sarvam
    .command("add")
    .description("Add one or more Sarvam API keys for automatic rotation.")
    .option("--api-key <apiKey>", "Sarvam API key (or comma-separated keys)")
    .option("--initialCredits <initialCredits>", "Optional initial credits estimate applied to each key")
    .action(async (commandOptions: { apiKey?: string; initialCredits?: string }, command: Command) => {
      const opts = command.optsWithGlobals() as RootOptions;
      const manager = await createManager();
      const initialCredits = parseCredits(commandOptions.initialCredits);
      const rawKeys = await promptForApiKeys(commandOptions.apiKey);
      for (const apiKey of rawKeys) {
        const keyId = keyIdentifier(apiKey);
        const validation = await validateSarvamApiKey(apiKey);
        if (!validation.valid) {
          throw new Error(`Key ${maskKey(apiKey)} validation failed. Account was not saved.`);
        }
        await manager.addAccount({ email: keyId, apiKey, initialCredits });
        printOutput(
          { ok: true, event: "key_added", keyId, maskedKey: maskKey(apiKey) },
          `Added key ${displayId(keyId)} (${maskKey(apiKey)}).`,
          Boolean(opts.json)
        );
      }
    });

  sarvam
    .command("list")
    .description("List configured Sarvam API keys.")
    .action(async (_commandOptions: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as RootOptions;
      const manager = await createManager();
      const accounts = await manager.listAccounts();
      if (opts.json) {
        printOutput({ ok: true, accounts }, "", true);
        return;
      }

      if (accounts.length === 0) {
        printOutput({}, "No Sarvam API keys configured.", false);
        return;
      }

      for (const account of accounts) {
        const defaultMark = account.isDefault ? " (default)" : "";
        const creditsText =
          account.credits === undefined ? "unknown credits" : `credits=${account.credits}`;
        const lastUsedText = account.lastUsed ? `, lastUsed=${account.lastUsed}` : "";
        process.stdout.write(`- ${displayId(account.email)}${defaultMark}: ${creditsText}${lastUsedText}\n`);
      }
    });

  sarvam
    .command("remove")
    .description("Remove an API key.")
    .argument("<keyId>", "Key ID (from 'sarvam list') or full identifier")
    .action(async (keyId: string, command: Command) => {
      const opts = command.optsWithGlobals() as RootOptions;
      const manager = await createManager();
      const resolved = resolveKeyId(keyId);
      const removed = await manager.removeAccount(resolved);
      if (!removed) {
        throw new Error(`Key ${keyId} was not found.`);
      }
      printOutput(
        { ok: true, event: "key_removed", keyId: resolved },
        `Removed key ${displayId(resolved)}.`,
        Boolean(opts.json)
      );
    });

  sarvam
    .command("set-default")
    .description("Set default key for rotation preference.")
    .argument("<keyId>", "Key ID (from 'sarvam list') or full identifier")
    .action(async (keyId: string, command: Command) => {
      const opts = command.optsWithGlobals() as RootOptions;
      const manager = await createManager();
      const resolved = resolveKeyId(keyId);
      await manager.setDefault(resolved);
      printOutput(
        { ok: true, event: "default_key_set", keyId: resolved },
        `Default key set to ${displayId(resolved)}.`,
        Boolean(opts.json)
      );
    });

  sarvam
    .command("test")
    .description("Validate an existing API key against Sarvam.")
    .argument("<keyId>", "Key ID (from 'sarvam list') or full identifier")
    .action(async (keyId: string, command: Command) => {
      const opts = command.optsWithGlobals() as RootOptions;
      const manager = await createManager();
      const resolved = resolveKeyId(keyId);
      const apiKey = await manager.decryptAccount(resolved);
      const result = await validateSarvamApiKey(apiKey);
      if (!result.valid) {
        throw new Error(`Validation failed for ${displayId(resolved)}.`);
      }
      printOutput(
        { ok: true, keyId: resolved, status: result.status },
        `Key ${displayId(resolved)} is valid.`,
        Boolean(opts.json)
      );
    });

  sarvam
    .command("decrypt")
    .description("Developer-only: decrypt and print an API key.")
    .argument("<keyId>", "Key ID (from 'sarvam list') or full identifier")
    .option("--yes", "Skip confirmation prompt")
    .action(async (keyId: string, commandOptions: { yes?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals() as RootOptions;
      const resolved = resolveKeyId(keyId);
      if (!commandOptions.yes) {
        const confirmation = await prompts({
          type: "confirm",
          name: "ok",
          message: `Decrypt API key for ${displayId(resolved)}?`,
          initial: false
        });
        if (!confirmation.ok) {
          throw new Error("Decrypt cancelled.");
        }
      }

      const manager = await createManager();
      const apiKey = await manager.decryptAccount(resolved);
      printOutput({ ok: true, keyId: resolved, apiKey }, apiKey, Boolean(opts.json));
    });

  sarvam
    .command("fudge")
    .description("Adjust estimated credits for an API key.")
    .argument("<keyId>", "Key ID (from 'sarvam list') or full identifier")
    .argument("<credits>", "New credit value")
    .action(async (keyId: string, creditsRaw: string, command: Command) => {
      const opts = command.optsWithGlobals() as RootOptions;
      const manager = await createManager();
      const resolved = resolveKeyId(keyId);
      const credits = parseCredits(creditsRaw);
      if (credits === undefined) {
        throw new Error("Credits are required.");
      }
      await manager.fudgeCredits(resolved, credits);
      printOutput(
        { ok: true, event: "credits_updated", keyId: resolved, credits },
        `Credits for ${displayId(resolved)} updated to ${credits}.`,
        Boolean(opts.json)
      );
    });

  await program.parseAsync(process.argv);
}

run().catch((error) => {
  const asJson = process.argv.includes("--json");
  printError(error, asJson);
  process.exit(1);
});
