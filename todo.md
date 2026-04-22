# Roundhouse TODO

## CLI Commands

- [x] `roundhouse start` — start gateway foreground
- [x] `roundhouse install` — install as systemd daemon
- [x] `roundhouse uninstall` — remove daemon
- [x] `roundhouse update` — npm update + restart
- [x] `roundhouse status` — show daemon status
- [x] `roundhouse logs` — tail daemon logs
- [x] `roundhouse stop` — stop daemon
- [x] `roundhouse restart` — restart daemon
- [x] `roundhouse config` — show config

## Planned Features

### `roundhouse tui`

Open the configured agent's TUI (e.g. pi interactive mode) with the session already resumed to the "main" session that Telegram/Slack/other chats write to.

This means:
- Detect which agent is configured (e.g. `pi`)
- Find the active session file for the default/primary thread
- Launch the agent's TUI pointed at that session
  - For pi: `pi --resume <session.jsonl>`
  - For kiro: TBD
- The user can then interact with the same conversation that Telegram users are chatting with
- Typing in the TUI and typing in Telegram both contribute to the same session context
- Need to handle concurrent access (gateway + TUI writing to same session file)

Open questions:
- Which thread is the "main" one? Could be: the most recently active thread, or a configured default thread, or a prompt to pick one
- Should `roundhouse tui` pause the gateway's session handle for that thread to avoid concurrent writes?
- Should there be a `roundhouse tui <thread_id>` to pick a specific thread?

### `roundhouse attach <thread_id>`

Lower-level version of `tui` — just prints the session file path and opens the agent CLI against it. No thread selection UX.

### Cross-platform session unification

Map multiple platform identities (Telegram @alice, Slack @alice) to a single session thread, so chatting from any platform continues the same conversation.

Config would look like:
```json
{
  "users": {
    "alice": {
      "telegram": "123456789",
      "slack": "U12345"
    }
  }
}
```

### Agent streaming to chat

Currently the gateway waits for the full agent response, then posts it. For long responses, stream partial updates to the chat platform:
- Post an initial message
- Edit it as more text arrives
- Finalize when the agent completes

Chat SDK supports this via `thread.post()` + `thread.edit()` or streaming mode.

### Webhook mode for production

Currently Telegram uses polling (good for dev). For production deployments:
- Support webhook mode with a built-in HTTP server
- Or integrate with an existing web framework (Express, Hono, Next.js)
- `roundhouse install --webhook --url https://my-domain.com/api/webhooks`

### Multi-agent routing

Swap `SingleAgentRouter` for smarter routing:
- `UserChoiceRouter` — user sends `/agent kiro` to switch
- `FallbackRouter` — try primary, fall back to secondary
- `RoundRobinRouter` — load balance across instances

### Health check endpoint

Expose a simple HTTP endpoint for monitoring:
- `GET /health` → `{ "status": "ok", "agent": "pi", "platforms": ["telegram"], "uptime": 12345 }`

### CI/CD

- [ ] GitHub Actions workflow to publish to npm on tag push
- [ ] Automated tests in CI
- [ ] Version bump script
