# Sarvam Connector for OpenCode

> **⚠️ OpenCode only** — This plugin integrates [Sarvam AI](https://www.sarvam.ai) models with [OpenCode](https://opencode.ai). It is not compatible with Cursor, VS Code Copilot, or other AI coding tools.


<img width="1918" height="1197" alt="opencode-sarvam" src="https://github.com/user-attachments/assets/53315b3b-6730-4746-9875-a537e9603b87" />


`opencode-sarvam-multi-auth` gives OpenCode access to Sarvam's frontier-class Indian language models with **automatic API key rotation**, encrypted local key storage, and seamless failover when a key's credits run out.

---

## What is Sarvam AI?

[Sarvam AI](https://www.sarvam.ai) is an Indian AI company building sovereign, frontier-class models optimised for Indian languages and use cases. Their models power population-scale applications across enterprise, government, and developer platforms.

Get your API key at [dashboard.sarvam.ai](https://dashboard.sarvam.ai) → **API Keys** section.

---

## Installation

### Option A — Let an LLM do it

Paste this into any OpenCode session:

```text
Install the opencode-sarvam-multi-auth plugin and add the Sarvam model definitions to
~/.config/opencode/opencode.json by following the installation and models sections in
this README.
```

### Option B — Manual setup

**1. Add the plugin to your OpenCode config** (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sarvam-multi-auth@latest"],
  "provider": {
    "sarvam": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.sarvam.ai/v1"
      },
      "models": {
        "sarvam-105b": {
          "name": "Sarvam 105B",
          "limit": { "context": 131072, "output": 8192 },
          "modalities": { "input": ["text"], "output": ["text"] }
        },
        "sarvam-30b": {
          "name": "Sarvam 30B",
          "limit": { "context": 131072, "output": 8192 },
          "modalities": { "input": ["text"], "output": ["text"] }
        },
        "sarvam-m": {
          "name": "Sarvam M",
          "limit": { "context": 131072, "output": 8192 },
          "modalities": { "input": ["text"], "output": ["text"] }
        }
      }
    }
  }
}
```

**2. Log in and add your API key(s):**

```bash
opencode auth login
```

Select **"Add Sarvam API Keys (supports multiple, one per line)"** and paste one or more keys.

You can paste:

| Format | Example |
|--------|---------|
| Single key | `sk_xxx...` |
| Multiple keys (one per line) | `sk_aaa...\nsk_bbb...` |
| Multiple keys (comma separated) | `sk_aaa..., sk_bbb...` |
| JSON array with optional credits | `[{"apiKey":"sk_aaa","initialCredits":120000},{"apiKey":"sk_bbb"}]` |
| JSON object (single key) | `{"apiKey":"sk_xxx","initialCredits":50000}` |

Alternatively, select **"Single Sarvam API Key"** to add just one key through the standard API key flow.

**3. Start coding:**

```bash
opencode run "Explain this code" --model=sarvam/sarvam-105b
opencode run "Refactor this function" --model=sarvam/sarvam-30b
opencode run "Write unit tests" --model=sarvam/sarvam-m
```

Or just open OpenCode in VS Code and select a Sarvam model from the model picker.

---

## Key Rotation

When you add multiple API keys, the connector automatically rotates between them:

- **Rotation order:** highest known positive credits first, then unknown-credit keys.
- **Triggers:** HTTP `401`/`403` (auth failure) or `429` (quota/credit exhaustion) → the current key is marked exhausted and the next key takes over transparently.
- **Transient errors** (network issues, `500`) are retried with exponential backoff (`500ms → 2s → 4s`) before rotating.
- **No downtime:** rotation happens in-flight — your OpenCode session never sees an error.

---

## CLI Key Management

You can manage your keys directly from the terminal:

```bash
# Add one or more API keys interactively
node dist/src/cli.js sarvam add

# Add a key non-interactively
node dist/src/cli.js sarvam add --api-key sk_xxx...

# Add multiple keys at once
node dist/src/cli.js sarvam add --api-key "sk_aaa,sk_bbb"

# List all keys (shows key ID + credit balance)
node dist/src/cli.js sarvam list

# Remove a key (use the key ID shown by 'list')
node dist/src/cli.js sarvam remove key-a3f9c1d82b0e

# Set a preferred default key for rotation
node dist/src/cli.js sarvam set-default key-a3f9c1d82b0e

# Validate a key is still accepted by Sarvam
node dist/src/cli.js sarvam test key-a3f9c1d82b0e

# Manually adjust estimated credits for a key
node dist/src/cli.js sarvam fudge key-a3f9c1d82b0e 50000

# Print the raw API key (developer use only)
node dist/src/cli.js sarvam decrypt key-a3f9c1d82b0e --yes
```

**JSON output** (for scripting):

```bash
node dist/src/cli.js --json sarvam list
```

### Key IDs

Each API key is assigned a stable, hash-derived ID in the format `key-<12hex chars>` (e.g. `key-a3f9c1d82b0e`). This ID:
- Is the same every time you add the same key (idempotent — no duplicates)
- Never exposes your raw API key
- Is what you pass to `remove`, `test`, `set-default`, `fudge`, and `decrypt` commands

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SARVAM_STORE_KEY` | **Yes** | AES-256-GCM encryption key for stored API keys |
| `SARVAM_STORE_BACKEND` | No | `file` (default) or `sqlite` |
| `SARVAM_SQLITE_PATH` | No | Full path to SQLite database file |
| `OPENCODE_CONFIG_PATH` | No | Override default OpenCode config path |
| `SARVAM_BASE_URL` | No | Override API endpoint (default: `https://api.sarvam.ai`) |
| `SARVAM_MAX_CONCURRENT_ROTATIONS` | No | Max parallel rotation attempts (default: `5`) |

**Generate an encryption key:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set it in your shell profile:

```bash
export SARVAM_STORE_KEY="<your-generated-key>"
```

---

## Available Sarvam Models

| Model ID | Description | Context | Max Output |
|----------|-------------|---------|------------|
| `sarvam-105b` | Flagship 105B parameter model — best quality | 128K tokens | 8K tokens |
| `sarvam-30b` | Fast, capable 30B model — balanced speed/quality | 128K tokens | 8K tokens |
| `sarvam-m` | Lightweight model — lowest latency | 128K tokens | 8K tokens |

All models are accessible at `https://api.sarvam.ai/v1/chat/completions`.
Get your API key and monitor usage at [dashboard.sarvam.ai](https://dashboard.sarvam.ai).

---

## Security

- API keys are encrypted at rest with **AES-256-GCM** (12-byte IV, 16-byte auth tag).
- The encryption key (`SARVAM_STORE_KEY`) is never stored — only you hold it.
- Key IDs shown in `sarvam list` are SHA-256 fingerprints — they never reveal your raw key.

**If you lose `SARVAM_STORE_KEY`:** stored keys cannot be decrypted. Generate a new encryption key and re-add your Sarvam API keys.

---

## ToS Notice

> Rotating across multiple **independent user accounts** may conflict with Sarvam's Terms of Service depending on your deployment model. If you are the owner of all keys (e.g. personal projects, organisation-owned keys), rotation across your own keys is standard practice.
>
> Verify ToS compliance before production rollout: [docs.sarvam.ai](https://docs.sarvam.ai/api-reference-docs/introduction)

---

## Useful Links

- Sarvam AI: [sarvam.ai](https://www.sarvam.ai)
- Sarvam Dashboard (get API key): [dashboard.sarvam.ai](https://dashboard.sarvam.ai)
- Sarvam API Docs: [docs.sarvam.ai](https://docs.sarvam.ai/api-reference-docs/introduction)
- OpenCode: [opencode.ai](https://opencode.ai)
- Sarvam Discord: [discord.com/invite/5rAsykttcs](https://discord.com/invite/5rAsykttcs)
