# Slack Transport Adapter Design

> Status: Design  
> Author: Loki  
> Date: 2026-05-11  
> Target: Roundhouse v0.5.25+

## 1. Architecture Decisions

### Socket Mode (chosen) vs Events API vs Polling

| | Socket Mode | Events API | Polling (history) |
|---|---|---|---|
| Public URL | ❌ Not needed | ✅ Required | ❌ Not needed |
| Infra | Zero (WebSocket from bot) | Needs HTTPS endpoint | None (API reads) |
| Latency | Real-time | Real-time | 5-30s (polling interval) |
| Firewall | Works behind NAT/firewall | Needs inbound port | Works behind NAT |
| API pressure | 1 connection | 1 connection | Many (history reads) |
| Consistency | Real-time events | Real-time events | Dedup needed |

**Decision: Socket Mode.** Alternatives:
- **Events API:** Requires public HTTPS endpoint + Lambda/managed service to forward to Roundhouse. Operational burden.
- **Polling:** Roundhouse would call `conversations.history` every N seconds per channel, track cursor, handle duplicates/missed events. Higher API quota burn (1 read per channel per poll), higher latency, need distributed dedup state.

Socket Mode needs zero additional infrastructure — same operational model as Telegram long-polling but with real-time events instead of polling. The bot initiates a WebSocket connection to Slack, receives events as they happen.

**Dependencies:**
- `@slack/bolt` — Framework handling Socket Mode, event dispatch, middleware
- `@slack/web-api` — Direct Web API calls (chat.postMessage, chat.update, files.upload)

### Threading Model

Slack threads via `thread_ts`:
- **DM conversations**: Each DM channel (`D...`) = one thread context (like Telegram private chat)
- **Channel conversations**: Each thread (identified by `thread_ts`) = one session
- **Unthreaded channel messages**: Create a new thread on first reply (always thread)

Thread ID format: `slack:<channelId>:<thread_ts>` (or `slack:<channelId>` for DM without threading)

### Multi-Transport Coexistence

Gateway already supports one `TransportAdapter`. For multi-transport:
- Phase 1: Config selects ONE adapter (telegram OR slack) — no gateway change needed
- Phase 2: `CompositeTransportAdapter` wraps multiple adapters, dispatches by thread prefix

Phase 1 is sufficient for initial Slack support. Phase 2 is straightforward when needed.

## 2. Module Layout

```
src/transports/slack/
├── slack-adapter.ts      # SlackAdapter class implementing TransportAdapter
├── format.ts             # markdownToMrkdwn conversion
├── socket.ts             # Socket Mode connection lifecycle
├── streaming.ts          # Progressive message updates (chat.update loop)
├── pairing.ts            # DM-based pairing flow
├── notify.ts             # Channel/DM notification delivery
└── index.ts              # Barrel export
```

Mirrors `src/transports/telegram/` structure exactly.

## 3. TransportAdapter Method Implementations

### `enrichPrompt(text: string): string`

Adds Slack-specific context hint:
```typescript
enrichPrompt(text: string): string {
  return `[Format: Slack mrkdwn. Use *bold*, _italic_, \`code\`, \`\`\`blocks\`\`\`. No HTML.]\n\n${text}`;
}
```

### `postMessage(thread: ChatThread, text: string): Promise<void>`

Converts markdown → mrkdwn, then splits the *converted* output at 4000 chars (Slack limit). Splitter is fence-aware (won't break mid-code-block):
```typescript
async postMessage(thread: ChatThread, text: string): Promise<void> {
  const mrkdwn = markdownToMrkdwn(text);
  const { channelId, threadTs } = parseSlackThread(thread);
  for (const chunk of splitMrkdwn(mrkdwn, SLACK_TEXT_LIMIT)) {
    await this.client.chat.postMessage({
      channel: channelId,
      text: chunk,
      thread_ts: threadTs,
      unfurl_links: false,
    });
  }
}
```

**`splitMrkdwn` sketch** (in `format.ts`):
```typescript
export function splitMrkdwn(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    // Try to split at a newline before the limit
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    // Don't split inside a code fence (``` ... ```)
    const fencesBefore = (remaining.slice(0, splitAt).match(/```/g) || []).length;
    if (fencesBefore % 2 !== 0) {
      // Inside a fence — find the closing fence AFTER current position
      const closingFence = remaining.indexOf('```', splitAt);
      if (closingFence !== -1) {
        splitAt = closingFence + 3;
      } else {
        // No closing fence found (malformed) — split at limit
        splitAt = limit;
      }
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    // Trim leading newline only (not all whitespace)
    if (remaining.startsWith('\n')) remaining = remaining.slice(1);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
```

**Notes:**
- Chunks may exceed `limit` when a code fence extends beyond it (acceptable — Slack will accept slightly over 4000 in practice, and breaking a fence is worse).
- Same pattern as Telegram's `splitMessage()` in `src/util.ts` but with fence-awareness.
- Implementation should share or extend the existing splitter.

### `registerCommands(token: string): Promise<void>`

No-op for Socket Mode (Slack doesn't have a "register commands" API like Telegram's setMyCommands). Slash commands are registered via app manifest. If slash commands are added later, they are wired via `app.command()` handlers in `socket.ts` during Bolt app initialization — not through this method.

### `ownsThread(thread: ChatThread): boolean`

```typescript
ownsThread(thread: ChatThread): boolean {
  return typeof thread.id === 'string' && thread.id.startsWith('slack:');
}
```

### `notify(chatIds: number[], text: string): Promise<void>`

Slack uses string channel IDs, not numeric. The interface takes `number[]` (Telegram legacy). SlackAdapter maps gateway numeric IDs to Slack strings via **`pairedChannels`** config (see Section 7: Configuration Schema):

```typescript
async notify(chatIds: number[], text: string): Promise<void> {
  if (chatIds.length === 0) return; // No-op on empty (matches TelegramAdapter)
  const mrkdwn = markdownToMrkdwn(text);
  const targets: string[] = [];
  
  // Map numeric gateway IDs to Slack channel strings via pairedChannels
  for (const id of chatIds) {
    const slackChannel = this.config.pairedChannels?.[String(id)];
    if (slackChannel) {
      targets.push(slackChannel);
    } else {
      console.warn(`[slack] notify: no pairedChannels entry for gatewayId=${id}, skipping`);
    }
  }
  
  const finalTargets = [...new Set(targets)]; // Dedupe
  if (finalTargets.length === 0) {
    console.warn(`[slack] notify: no targets resolved for gatewayIds=[${chatIds.join(',')}]`);
    return;
  }
  for (const channel of finalTargets) {
    await this.client.chat.postMessage({ channel, text: mrkdwn });
  }
}
```

**Design:** Empty `chatIds` = no-op (matches TelegramAdapter semantics). Unmapped IDs are dropped with warning. For explicit broadcast, gateway calls with configured `notifyChatIds` from config.

### `createThread(chatId: number): ChatThread`

Creates a synthetic thread for boot turns and cron notifications. Maps `chatId` → Slack channel via `pairedChannels` config (Section 7: Configuration Schema). Throws if mapping not found (no silent fallback — synthetic turns must have explicit routing).

```typescript
createThread(chatId: number): ChatThread {
  const channelId = this.config.pairedChannels?.[String(chatId)];
  if (!channelId) {
    throw new Error(
      `[slack] createThread: no pairedChannels entry for gatewayId=${chatId}. ` +
      `Synthetic threads (boot turn, cron) require explicit paired channel mapping.`
    );
  }
  return {
    id: `slack:${channelId}`,
    post: async (text: string) => {
      const mrkdwn = markdownToMrkdwn(text);
      for (const chunk of splitMrkdwn(mrkdwn, SLACK_TEXT_LIMIT)) {
        await this.client.chat.postMessage({ channel: channelId, text: chunk });
      }
    },
  };
}
```

**Design change:** No `primaryChannel` fallback. Synthetic turns (boot, cron) are not ad-hoc — they should only fire to an explicitly paired channel to prevent accidental routing to wrong destinations.

### `isPairingPending(): Promise<boolean>`

Same pattern as Telegram — check for nonce file:
```typescript
async isPairingPending(): Promise<boolean> {
  const pending = await readPendingSlackPairing();
  return pending?.status === 'pending';
}
```

### `handlePairing(thread, message): Promise<PairingResult | null>`

See Section 6 (Pairing Flow).

## 4. Markdown → mrkdwn Conversion

Slack mrkdwn is close to markdown but has key differences:

| Markdown | Slack mrkdwn | Action |
|----------|-------------|--------|
| `**bold**` | `*bold*` | Convert |
| `*italic*` / `_italic_` | `_italic_` | Passthrough |
| `` `code` `` | `` `code` `` | Passthrough |
| ```` ```block``` ```` | ```` ```block``` ```` | Passthrough |
| `[text](url)` | `<url\|text>` | Convert |
| `# Heading` | `*Heading*` | Convert to bold |
| `> quote` | `> quote` | Passthrough |
| `- list` | `• list` | Convert bullet |
| `&` `<` `>` | `&amp;` `&lt;` `&gt;` | Escape |

```typescript
// src/transports/slack/format.ts

const CODE_BLOCK_RE = /(```[\s\S]*?```|`[^`]+`)/g;

/**
 * Convert markdown to Slack mrkdwn.
 * Code blocks/inline code are protected from transformation.
 */
export function markdownToMrkdwn(md: string): string {
  // Split into code vs non-code segments; only transform non-code
  const segments = md.split(CODE_BLOCK_RE);
  return segments.map((segment, i) => {
    // Odd indices are code blocks/inline code — passthrough
    if (i % 2 === 1) return segment;
    return transformNonCode(segment);
  }).join('');
}

function transformNonCode(text: string): string {
  // ⚠️ DESIGN NOTE: This regex-chaining approach is functional but fragile.
  // A stateful token-stream parser would be more robust for production:
  // (1) tokenize input into {type, value} tuples (link_text, url, bold, code, etc.),
  // (2) transform by token type, (3) reassemble. This avoids overlapping replacements,
  // order-of-operations gotchas, and edge cases (balanced parens in URLs, nested < >).
  // Implementation should consider this upgrade path before shipping.
  
  // 1. Convert __bold__ → *bold* (markdown alt-bold via double underscore)
  text = text.replace(/__([^_]+)__/g, '*$1*');
  // 2. Convert **bold** → *bold*
  text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  // 3. Convert [text](url) → <url|text> (before < > escaping)
  //    Note: URLs with ) (e.g. Wikipedia) may break — known limitation of simple regex.
  //    Implementation should use a balanced-paren-aware parser for robustness.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+(?:\([^)]*\)[^)\s]*)?)\)/g, '<$2|$1>');
  // 4. Protect bare URLs and already-converted <url|text> links from entity escaping
  const placeholders: string[] = [];
  const PH = '\u{FFFC}'; // Object Replacement Character — never in normal text
  // Tokenize <url|text> spans first
  text = text.replace(/<[^>]+\|[^>]+>/g, (match) => {
    placeholders.push(match);
    return `${PH}${placeholders.length - 1}${PH}`;
  });
  // Tokenize bare URLs (strip trailing punctuation not part of URL)
  text = text.replace(/(https?:\/\/\S+?)(?=[.,;:)\]]*(?:\s|$))/g, (url) => {
    placeholders.push(url);
    return `${PH}${placeholders.length - 1}${PH}`;
  });
  // 5. # Heading → *Heading*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // 6. Bullet lists: - , * , + → • (convert * bullets before they collide with bold)
  text = text.replace(/^(\s*)[-*+] /gm, '$1• ');
  // 7. Escape & (skip existing entities including numeric/hex)
  text = text.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
  // 8. Escape remaining < > (now safe — links/URLs are tokenized)
  text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 9. Escape standalone underscores (mid-word _ triggers italic in Slack)
  text = text.replace(/(?<=\w)_(?=\w)/g, '\\_');
  // 10. Restore placeholders
  const phRe = new RegExp(`${PH}(\\d+)${PH}`, 'g');
  text = text.replace(phRe, (_, idx) => placeholders[Number(idx)]);
  return text;
}
```

**Design notes:**
- **Code protection:** Split by code fences/inline code (regex alternation). Only non-code segments are transformed. Same pattern as `src/transports/telegram/format.ts`.
- **Order-of-operations:** Structural conversions (bold, links) → URL protection → entity escaping → underscore escape → restore URLs.
- **< > escaping:** After link conversion, remaining `<`/`>` are escaped to prevent Slack auto-link/mention parsing.
- **Underscore trap:** Only mid-word underscores (`\w_\w`) are escaped. Leading/trailing `_italic_` preserved. URLs protected by placeholder before this step.
- **Splitting:** Consumer (`postMessage`) must split the *converted* output at 4000 chars. Splitter must respect code fence boundaries (don't break mid-fence).

## 5. Streaming / Progressive Edits

### The 4-Second Problem

Slack requires event acknowledgment within 3 seconds. Agent responses take 5-60s. Strategy:

1. **Acknowledge immediately** (Bolt handles this automatically in Socket Mode)
2. **Post initial message** with typing indicator: `⏳ Thinking...`
3. **Update progressively** via `chat.update` as text streams in
4. **Final update** with complete response

```typescript
// src/transports/slack/streaming.ts
export async function handleSlackStream(
  client: WebClient,
  channelId: string,
  threadTs: string | undefined,
  stream: AsyncIterable<AgentStreamEvent>,
): Promise<void> {
  // Post placeholder
  const initial = await client.chat.postMessage({
    channel: channelId,
    text: '⏳ ...',
    thread_ts: threadTs,
  });
  const messageTs = initial.ts!;

  let buffer = '';
  let lastUpdate = 0;
  let consecutiveFailures = 0;
  const UPDATE_INTERVAL_MS = 1000; // Rate limit: 1 update/sec
  const MAX_UPDATE_FAILURES = 5;   // Abort update loop after N consecutive non-ratelimit failures
  const MAX_RATELIMIT_STREAK = 10; // Cap ratelimit-only backoffs too
  const PREVIEW_CHARS = 3000;      // Show first N chars during streaming (not entire buffer)
  let ratelimitStreak = 0;
  let everUpdated = false;

  for await (const event of stream) {
    if (event.type === 'text-delta') {
      buffer += event.text;
      const now = Date.now();
      if (now - lastUpdate >= UPDATE_INTERVAL_MS && consecutiveFailures < MAX_UPDATE_FAILURES && ratelimitStreak < MAX_RATELIMIT_STREAK) {
        try {
          // Interim updates show preview only (first N chars + ellipsis if longer)
          // This prevents update failures when full buffer grows past Slack's update size limit
          const preview = buffer.length > PREVIEW_CHARS 
            ? buffer.slice(0, PREVIEW_CHARS) + '…' 
            : buffer;
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: markdownToMrkdwn(preview),
          });
          lastUpdate = now;
          consecutiveFailures = 0;
          ratelimitStreak = 0;
          everUpdated = true;
        } catch (err: any) {
          if (err?.data?.error === 'ratelimited') {
            // Note: @slack/web-api surfaces retry_after via err.data.retry_after
            // or err.retryAfter depending on version. Verify against installed SDK.
            ratelimitStreak++;
            const retryAfter = (err.data?.retry_after ?? err.retryAfter ?? 2) * 1000;
            lastUpdate = now + retryAfter;
          } else {
            consecutiveFailures++;
            console.warn(`[slack] chat.update failed (${consecutiveFailures}/${MAX_UPDATE_FAILURES}):`, err.message);
          }
        }
      }
    }
  }

  // Final update with complete text (or cleanup placeholder if no content)
  if (buffer) {
    const finalMrkdwn = markdownToMrkdwn(buffer);
    const chunks = splitMrkdwn(finalMrkdwn, SLACK_TEXT_LIMIT);
    try {
      // Update placeholder with first chunk
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: chunks[0],
      });
      everUpdated = true; // Track that final update succeeded
      // Post remaining chunks as threaded follow-ups
      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({
          channel: channelId,
          text: chunks[i],
          thread_ts: threadTs ?? messageTs,
        });
      }
    } catch (err: any) {
      console.warn(`[slack] final update failed:`, err.message);
      // If the placeholder never updated successfully, delete it and post complete response fresh
      // This preserves thread structure: all chunks post coherently (either all in one thread or fresh)
      if (!everUpdated) {
        try { await client.chat.delete({ channel: channelId, ts: messageTs }); } catch {}
        // Post all chunks fresh; if threadTs provided, thread under that; otherwise post first chunk
        // and thread the rest under it for coherence
        if (threadTs) {
          // Channel thread: post all under existing threadTs
          for (const chunk of chunks) {
            await client.chat.postMessage({ channel: channelId, text: chunk, thread_ts: threadTs });
          }
        } else {
          // DM or new thread: post first chunk top-level, rest threaded under it
          const firstMsg = await client.chat.postMessage({ channel: channelId, text: chunks[0] });
          for (let i = 1; i < chunks.length; i++) {
            await client.chat.postMessage({ channel: channelId, text: chunks[i], thread_ts: firstMsg.ts });
          }
        }
      } else {
        console.warn('[slack] final chat.update failed after partial success; response partially visible');
      }
    }
  } else {
    // No text output (tool-only turn or error) — delete orphaned placeholder
    try { await client.chat.delete({ channel: channelId, ts: messageTs }); } catch {}
  }
}
```

**Rate limiting:** Slack allows ~1 `chat.update` per second per message. We batch updates at 1s intervals (same cadence as Telegram progressive edits).

**Event handling:** The streaming loop only processes `text-delta` events. Other events (`tool-start`, `tool-end`, `turn-end`, `error`) should be handled by the caller (gateway's streaming handler) which dispatches tool status messages separately. The Slack streaming function is only responsible for progressive text output — same separation as Telegram's `handleTelegramHtmlStream`.

**Units:** `retry_after` from Slack API is in seconds (per Slack docs). The `?? 2` fallback provides a 2-second default.

## 6. Pairing Flow

### Setup (CLI side)
```
roundhouse setup --slack
> Enter Slack Bot Token (xoxb-...): ****
> Enter Slack App Token (xapp-...): ****
> Generating pairing nonce...
> Send this message to the bot in Slack DM: "pair <nonce>"
> Waiting for pairing...
```

### Runtime (Slack DM side)
1. User opens DM with the bot
2. User sends: `pair abc123`
3. SlackAdapter's `handlePairing()` validates nonce using constant-time comparison (`crypto.timingSafeEqual` with length-check guard — reject immediately if lengths differ)
4. On match: extracts `userId`, `channelId` (DM channel), `username`
5. Returns `PairingResult { threadId: channelId, userId, username }`
6. Gateway writes config atomically (temp-file + rename pattern, same as Telegram pairing) to avoid clobbering on crash

### Nonce File
```json
// ~/.roundhouse/pairing-slack.json
{
  "status": "pending",
  "nonce": "abc123",
  "createdAt": "2026-05-11T...",
  "expiresAt": "2026-05-11T..."  // createdAt + 10 minutes
}
```

**TTL:** Nonce expires after 10 minutes. `handlePairing()` checks `expiresAt` before validating. Expired nonces are deleted on next check. This prevents stale pairing files from accumulating.

**File permissions:** Written with mode 0600 (owner-only read/write), matching Telegram pairing file pattern.

## 7. Configuration Schema

```jsonc
// roundhouse.json — tokens via env vars (recommended), config has non-secret settings
{
  "chat": {
    "activeAdapter": "slack",  // Required when multiple adapters configured
    "adapters": {
      "slack": {
        // Tokens: use SLACK_BOT_TOKEN / SLACK_APP_TOKEN env vars
        "pairedChannels": {          // Numeric gateway ID → Slack channel ID (from pairing flow)
          "1775159795": "D04XXXXX"   // gatewayId → Slack DM channel
        },
        "allowedUserIds": ["U04XXXXX"],
        "requireMention": true        // Default: true. In channels, only respond to @bot
      }
    }
  }
}
```

### Environment Variables (recommended for tokens)
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

**Security note:** Prefer environment variables over roundhouse.json for tokens. roundhouse.json is 0644 by default (readable by other users on shared systems). If tokens must be in config, implementation should warn if file mode is not 0600.

### Slack App Manifest (required scopes)
```yaml
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - chat:write.public    # Post to public channels bot hasn't joined
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - users:read
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
```

## 8. Security

### Token Handling
- Bot token: use `SLACK_BOT_TOKEN` env var (preferred) or store in roundhouse.json with 0600 perms
- App token (Socket Mode): use `SLACK_APP_TOKEN` env var (preferred) or store in roundhouse.json with 0600 perms
- If tokens in config file: implementation must enforce 0600 perms on write (roundhouse.json is 0644 by default — unsafe!)
- No tokens logged or transmitted

### Allowlist Enforcement
- `allowedUserIds`: Array of Slack user IDs (U-prefixed)
- All incoming messages checked against allowlist before processing
- Channel messages additionally require @mention if `requireMention: true`
- DM messages from non-allowed users ignored silently

### Message Filtering (SlackAdapter method)
```typescript
private isAllowed(userId: string, channelType: 'im' | 'mpim' | 'channel' | 'group', isMention: boolean): boolean {
  if (!this.config.allowedUserIds.includes(userId)) return false;
  if (channelType !== 'im' && channelType !== 'mpim' && this.config.requireMention && !isMention) return false;
  return true;
}
```

**Enforcement:** `channelType` and `isMention` explicitly checked. DMs allowed for users in allowlist. Channel/group messages require @mention when `requireMention: true`. This prevents accidental processing if a future listener forwards non-mention events.

## 9. Multi-Transport Coexistence

### Phase 1: Single Adapter Selection

Config requires explicit `activeAdapter` key when multiple adapters are configured:

```typescript
// src/transports/index.ts
export function createTransport(config: GatewayConfig): TransportAdapter {
  const adapters = config.chat.adapters;
  const configured = [adapters.telegram && 'telegram', adapters.slack && 'slack'].filter(Boolean);

  if (configured.length > 1 && !config.chat.activeAdapter) {
    throw new Error(
      `Multiple transports configured (${configured.join(', ')}) but no chat.activeAdapter specified. ` +
      `Set chat.activeAdapter to one of: ${configured.join(', ')}`
    );
  }

  const active = config.chat.activeAdapter ?? configured[0];
  if (!configured.includes(active)) {
    throw new Error(`chat.activeAdapter "${active}" is not configured. Available: ${configured.join(', ')}`);
  }

  if (active === 'slack') return new SlackAdapter(adapters.slack!);
  return new TelegramAdapter(config);
}
```

### Phase 2: Composite Adapter (future)
```typescript
class CompositeTransportAdapter implements TransportAdapter {
  private adapters: TransportAdapter[];

  notify(chatIds, text) {
    // Broadcast to all adapters
    return Promise.all(this.adapters.map(a => a.notify(chatIds, text)));
  }

  ownsThread(thread) {
    return this.adapters.some(a => a.ownsThread(thread));
  }

  postMessage(thread, text) {
    const adapter = this.adapters.find(a => a.ownsThread(thread));
    return adapter!.postMessage(thread, text);
  }
}
```

## 10. Error Handling

| Scenario | Strategy |
|----------|----------|
| Socket disconnected | @slack/bolt auto-reconnects (exponential backoff) |
| Rate limited (429) | Bolt retries automatically; streaming backs off |
| Token revoked | Log error, notify via alternate transport if available |
| Message too long | Split at 4000 chars (Slack limit), send as multiple messages |
| chat.update fails | Fall back to new message (don't block stream) |
| File upload fails | Log warning, post text fallback |
| Channel not found | Skip notification, log error |

### Reconnection
Socket Mode handles reconnection internally. @slack/bolt emits `error` events for logging:
```typescript
app.error(async (error) => {
  console.error('[slack] Bolt error:', error.message);
});
```

## 11. Testing Strategy

### Unit Tests
- `format.test.ts` — markdownToMrkdwn conversion (entity escaping, bold, links, headings, bullets)
- `pairing.test.ts` — nonce validation, expiry, file cleanup
- `streaming.test.ts` — rate limiting, buffer accumulation, final update

### Integration Tests (with mocks)
- `slack-adapter.test.ts` — full TransportAdapter interface contract
  - Mock `WebClient` (postMessage, update, filesUpload)
  - Mock Socket Mode connection
  - Verify allowlist enforcement
  - Verify thread ID format parsing

### Smoke Test
- Start adapter with real tokens in dev workspace
- Send DM → verify response
- Send channel @mention → verify threaded response
- Verify streaming updates visually

## 12. Key Differences from Telegram Adapter

| Aspect | Telegram | Slack |
|--------|----------|-------|
| Connection | Long-polling (Chat SDK) | Socket Mode (Bolt) |
| Thread ID | `telegram:<chatId>[:topicId]` | `slack:<channelId>:<threadTs>` |
| Formatting | HTML (`<b>`, `<code>`) | mrkdwn (`*bold*`, `` `code` ``) |
| Message limit | 4096 chars | 4000 chars (text block) |
| Streaming | Edit message (editMessageText) | chat.update |
| Commands | BotFather + setMyCommands | App manifest (slash commands) |
| Chat IDs | Numeric | String (C/D/G prefix) |
| Pairing | `/start <nonce>` | `pair <nonce>` in DM |
| Typing | sendChatAction | N/A (Slack shows "typing" natively) |

## 13. Implementation Plan

1. **Phase 1: Basic DM** (MVP)
   - Socket Mode connection
   - DM message handling
   - postMessage / notify
   - Pairing flow
   - markdownToMrkdwn

2. **Phase 2: Streaming**
   - Progressive chat.update
   - Rate limiting
   - Error fallback

3. **Phase 3: Channels**
   - @mention handling
   - Thread isolation
   - requireMention enforcement

4. **Phase 4: Rich Features**
   - File/attachment support
   - Slash commands
   - Interactive messages (buttons)
