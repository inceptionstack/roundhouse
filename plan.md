# Plan: Setup --telegram (Interactive + Headless)

## Overview

Two modes behind `roundhouse setup --telegram`:

1. **Interactive wizard** — guides user from zero to chatting on Telegram
2. **Headless automation** — SSM/cloud-init installs, starts gateway, user pairs later

---

## Feature 1: Interactive Wizard

### Command
```bash
npx @inceptionstack/roundhouse setup --telegram
```

### Flow (10 steps)
1. Detect TTY → if no TTY, fail with "use --headless for automation"
2. Print inline BotFather guide (create bot, get token)
3. Masked token prompt via Node readline (no deps, no shell history)
4. Prompt for Telegram username (who can use the bot)
5. Preflight checks (node, npm, disk, AWS creds)
6. Validate token via `getMe`, discover bot username
7. Install packages (roundhouse, pi-coding-agent)
8. Generate nonce, print `t.me/bot?start=nonce` link + QR code
9. Poll for `/start <nonce>`, capture chat ID + user ID
10. Write config/env, register bot commands, install+start service, send confirmation

### Key Details
- **Masked input**: `readline.Interface` with `_writeToOutput` override (Node built-in, zero deps)
- **QR code**: `qrcode-terminal` package (small, mature, purpose-built)
- **Service auto-detect**: systemd on Linux, skip with instructions on macOS/Windows
- **Token never in argv or logs** — env var or masked prompt only

---

## Feature 2: Headless Automation

### Command
```bash
TELEGRAM_BOT_TOKEN=... roundhouse setup --telegram --headless --user royosh
```

### Flow (9 steps)
1. Parse flags/env — reject `--bot-token` (argv visible in process listings)
2. Require `--user` (no empty allowlist)
3. Preflight checks
4. Validate token via `getMe`
5. Install packages
6. Generate nonce, write `~/.roundhouse/telegram-pairing.json`
7. Write config/env with `allowedUsers` but empty `allowedUserIds`/`notifyChatIds`
8. Register bot commands
9. Install, enable, start systemd → verify active → exit 0

### Post-Setup (gateway handles)
- Gateway starts immediately and is functional
- Gateway detects `telegram-pairing.json` with `status: "pending"`
- When user opens `t.me/bot?start=nonce` and sends `/start`:
  - Gateway validates username against `allowedUsers`
  - Captures `chatId`, `userId`, writes them to config
  - Marks pairing complete
  - Sends confirmation message
- Nonce persists across gateway restarts until paired

### Key Details
- **Structured JSON logging** — one JSON object per line (for SSM/cloud-init/Docker)
- **Diagnostic errors** — on failure, dump versions, paths, config state, service state
- **Exit codes**: 0=success, 1=general, 2=usage, 3=preflight, 4=telegram, 5=packages, 6=config, 7=service
- **Token via env var only** — `--bot-token` rejected in headless mode

---

## New File: `src/pairing.ts`

```ts
interface PendingPairing {
  version: 1;
  nonce: string;           // "rh-" + randomBytes(8).hex
  botUsername: string;
  allowedUsers: string[];
  createdAt: string;       // ISO
  status: "pending" | "paired";
  pairedAt?: string;
  chatId?: number;
  userId?: number;
  username?: string;
}
```

- Atomic writes (tmp+rename, mode 0600)
- `readPendingPairing()`, `writePendingPairing()`, `completePendingPairing()`
- Reuse nonce on re-run without `--force`; rotate on `--force`

## Gateway Pairing Hook

In `gateway.ts`, before `isAllowed()` check:

```ts
if (pendingPairing?.status === "pending" && isStartForNonce(text, nonce)) {
  // Validate username against pendingPairing.allowedUsers
  // Write chatId + userId to config
  // Mark pairing complete
  // Update in-memory config (no restart needed)
  // Send confirmation
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `src/cli/setup.ts` | Extend options, add wizard + headless flows, structured logger |
| `src/cli/setup-telegram.ts` | Accept caller nonce, export lower-level helpers |
| `src/gateway.ts` | Pending pairing detection + completion before auth |
| `src/cli/cli.ts` | Updated help text |
| `package.json` | Add `qrcode-terminal` dep |

## Files to Create

| File | Purpose |
|------|---------|
| `src/pairing.ts` | Persistent pairing state (pending/paired) |
| `src/cli/setup-prompts.ts` | `promptText()`, `promptMasked()` — Node readline only |
| `src/cli/setup-logger.ts` | Text (interactive) + JSON (headless) structured logger |
| `src/cli/qr.ts` | QR code wrapper (qrcode-terminal) |

## Backward Compatibility

- `roundhouse setup --user X` (no `--telegram`) → current flow, unchanged
- `--non-interactive` → accepted, maps to headless behavior
- `--bot-token` → accepted for non-headless, discouraged in docs
- `--notify-chat` → still skips pairing
- Existing configs preserved unless `--force`

## Test Plan

### Unit Tests
- Argument parsing: `--telegram`, `--headless` combinations and rejections
- Prompt helpers: masked input, Ctrl+C handling (fake streams)
- Pairing persistence: write/read/complete/reuse/force-rotate
- Gateway pairing: nonce match, username validation, config merge, in-memory update
- Structured logging: valid JSON lines, no token leakage
- Service detection: systemd/macOS/container scenarios
- Error diagnostics: versions, paths, config state

### E2E Smoke Tests
- Fresh EC2: `--telegram --headless --user X` → service active, config written, pairing pending
- Open pairing link → gateway completes pairing, sends confirmation
- macOS interactive → reaches manual-start instructions
- Docker with `--service skip` → config written, exits successfully

## Implementation Order

1. `src/cli/setup-prompts.ts` — masked input, text prompt
2. `src/cli/setup-logger.ts` — text + JSON structured logger
3. `src/pairing.ts` — persistent pairing state
4. `src/cli/qr.ts` — QR wrapper
5. `src/cli/setup-telegram.ts` — expose lower-level helpers, accept nonce
6. `src/cli/setup.ts` — Feature 1: interactive wizard flow
7. Tests for Feature 1
8. `src/gateway.ts` — pending pairing hook
9. `src/cli/setup.ts` — Feature 2: headless flow
10. Tests for Feature 2
11. E2E on fresh EC2
