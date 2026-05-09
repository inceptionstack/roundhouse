# Transport Pairing Design

> Date: 2026-05-09
> Status: merged to main

## Problem

Pairing logic in `gateway.ts` is Telegram-specific:
- Reads nonce from file, matches `/start <nonce>`
- Extracts Telegram chatId/userId from message
- Updates config with Telegram-specific IDs

Different transports will need different pairing flows (e.g., Slack OAuth, Discord guild join).

## Design

### What the gateway needs from pairing (transport-agnostic):

```typescript
/** Result of a successful pairing — what gateway stores in config */
interface PairingResult {
  /** Unique thread/channel ID for this user (used for notify) */
  threadId: string | number;
  /** Unique user ID (used for allowlist) */  
  userId: string | number;
  /** Display name */
  username: string;
}
```

### What the transport needs during pairing:

Each transport handles its own pairing state (file, OAuth token, etc.).
The gateway just asks: "Is this message a pairing attempt? If so, handle it."

### Interface addition to TransportAdapter:

```typescript
interface TransportAdapter {
  // ... existing methods ...

  /** 
   * Try to handle an incoming message as a pairing attempt.
   * Returns PairingResult if pairing succeeded, null if message wasn't a pairing attempt.
   * Transport manages its own state (nonce files, OAuth, etc.)
   */
  handlePairing(thread: ChatThread, message: IncomingMessage): Promise<PairingResult | null>;

  /**
   * Check if pairing is still pending (transport reads its own state).
   * Used by gateway to know whether to try pairing on incoming messages.
   */
  isPairingPending(): Promise<boolean>;
}
```

### Gateway integration:

The actual implementation in `gateway.ts::handlePendingPairing()` is inline (no helper methods):

```typescript
if (!this.pairingComplete && await this.transport.isPairingPending()) {
  const result = await this.transport.handlePairing(thread, message);
  if (!result) return false;

  const { threadId: rawThreadId, userId: rawUserId, username } = result;
  // Coerce to number (config arrays are number[] today)
  const threadId = typeof rawThreadId === "string" ? Number(rawThreadId) : rawThreadId;
  const userId = typeof rawUserId === "string" ? Number(rawUserId) : rawUserId;
  if (!Number.isFinite(threadId) || !Number.isFinite(userId)) return false;

  // Update in-memory config
  if (!this.config.chat.allowedUserIds) this.config.chat.allowedUserIds = [];
  if (!this.config.chat.allowedUserIds.includes(userId)) {
    this.config.chat.allowedUserIds.push(userId);
  }
  if (!this.config.chat.notifyChatIds) this.config.chat.notifyChatIds = [];
  if (!this.config.chat.notifyChatIds.includes(threadId)) {
    this.config.chat.notifyChatIds.push(threadId);
  }

  // Persist config atomically (tempfile + rename)
  // ... (same as before, see gateway.ts for full implementation)

  this.pairingComplete = true;
  await thread.post("✅ Roundhouse paired successfully!\n\nSend /status to verify.");
  return true;
}
```
```

### What moves into TelegramAdapter.handlePairing():

1. Read pending pairing file
2. Check if text matches `/start <nonce>`
3. Verify author is in allowedUsers
4. Extract chatId/userId from Telegram message format
5. Call `completePendingPairing()`
6. Return `{ threadId: chatId, userId, username }`

### What stays in gateway (transport-agnostic):

1. Config update (allowedUserIds, notifyChatIds)
2. Config file persistence
3. `pairingComplete` flag
4. Success message posting

## File Changes

- `src/transports/types.ts` — Add `PairingResult`, `handlePairing`, `isPairingPending` to interface
- `src/transports/telegram/telegram-adapter.ts` — Implement pairing methods
- `src/gateway/gateway.ts` — Replace 70-line `handlePendingPairing` with ~15-line adapter delegation
