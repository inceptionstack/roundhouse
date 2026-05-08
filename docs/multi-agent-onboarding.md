# Multi-Agent Onboarding Design

> Date: 2026-05-08  
> Status: Planning  
> Relates to: usability-report-2026-05-08.md (item #8: getting started flow)

---

## Problem

Users arrive in one of three states:

| State | Has installed | Agent config exists | What roundhouse should do |
|-------|--------------|--------------------|-|
| **A: Pi user** | `pi` CLI globally | `~/.pi/agent/settings.json` | Use existing Pi — don't re-install or overwrite |
| **B: OpenClaw user** | `oc` CLI globally | `~/.openclaw/openclaw.json` | Use existing OpenClaw gateway — roundhouse acts as Telegram frontend |
| **C: Fresh user** | Neither | Nothing | Install Pi (lightweight, no gateway process needed) |

Currently, `roundhouse setup --telegram` assumes Pi and always installs it. This breaks for:
- OpenClaw users: don't need Pi at all; already have a running agent gateway
- Fresh users: works, but gives no choice

---

## Detection Logic

```typescript
interface DetectedEnvironment {
  hasPi: boolean;        // `which pi` succeeds OR ~/.pi/agent/settings.json exists
  hasOpenClaw: boolean;  // `which oc` succeeds OR ~/.openclaw/openclaw.json exists
  hasKiro: boolean;      // `which kiro-cli` succeeds OR ~/.kiro/ exists
  piConfigured: boolean; // settings.json has defaultProvider set
  ocRunning: boolean;    // oc gateway health check responds
}

function detectEnvironment(): DetectedEnvironment { ... }
```

Detection runs at setup start (preflight). Results drive the wizard flow.

---

## Setup Flow (Interactive `--telegram`)

```
① Preflight checks...
   ✓ Node.js, npm, writable dirs, AWS creds

② Detecting agent environment...
   [scenario branches here]
```

### Scenario A: Pi detected
```
   ✓ Pi CLI found (v0.73.1)
   ✓ Pi configured (amazon-bedrock, claude-opus-4-6)
   
   Using existing Pi installation.
   → [skip package install, skip settings.json write]
   → [proceed to Telegram token, pairing, etc.]
```

### Scenario B: OpenClaw detected
```
   ✓ OpenClaw CLI found (v2026.4.14)
   ✓ OpenClaw gateway running on port 3001
   
   Using existing OpenClaw gateway as agent backend.
   Agent type: openclaw
   → [skip Pi install entirely]
   → [configure roundhouse to proxy to OpenClaw gateway]
   → [proceed to Telegram token, pairing, etc.]
```

### Scenario C: Nothing detected
```
   No agent backend detected.
   
   Available options:
     1. Pi (recommended — lightweight, runs in-process)
     2. Kiro CLI (requires kiro-cli installed)
     3. OpenClaw (requires separate gateway)
   
   Select agent backend [1]: 
   → [install selected agent]
   → [proceed to Telegram token, pairing, etc.]
```

### Scenario D: Multiple detected
```
   ✓ Pi CLI found (v0.73.1)
   ✓ OpenClaw CLI found (v2026.4.14)
   
   Multiple agent backends detected:
     1. Pi (configured, ready)
     2. OpenClaw (gateway running)
   
   Select agent backend [1]:
```

---

## Config Impact

```jsonc
// ~/.roundhouse/gateway.config.json
{
  "agent": {
    "type": "pi",         // or "kiro" or "openclaw"
    "cwd": "~",
    // type-specific fields:
    "provider": "...",    // pi only
    "model": "...",       // pi only
    "gatewayUrl": "..."   // openclaw only
  }
}
```

---

## OpenClaw Adapter (new — PR needed)

OpenClaw runs its own gateway process. Roundhouse would be a Telegram frontend that proxies messages to it:

```
User → Telegram → Roundhouse → OpenClaw Gateway (localhost:3001) → Agent
                  ← streaming events ←
```

This requires a new adapter (`src/agents/openclaw/openclaw-adapter.ts`) that:
- Sends prompts via HTTP to `http://localhost:3001/api/v1/chat`
- Receives SSE streaming responses
- Maps OpenClaw events to `AgentStreamEvent`

**Scope:** Separate PR after kiro adapter stabilizes.

---

## Implementation Plan

### Phase 1: Detection + Smart Defaults (next PR)
- [ ] Add `detectEnvironment()` to `src/cli/detect.ts`
- [ ] Integrate into setup wizard (after preflight, before package install)
- [ ] Skip Pi install if already configured
- [ ] Skip settings.json write if already configured (unless `--force`)
- [ ] Show detection results in preflight output

### Phase 2: Agent Selection (follow-up)
- [ ] Interactive prompt when multiple backends detected
- [ ] `--agent` flag respects detection (warns if selected agent not installed)
- [ ] Fresh users get a choice menu

### Phase 3: OpenClaw Adapter
- [ ] `src/agents/openclaw/openclaw-adapter.ts` extending BaseAdapter
- [ ] HTTP client to OpenClaw gateway API
- [ ] SSE event stream parsing → AgentStreamEvent
- [ ] Register in registry.ts
- [ ] Setup: configure gatewayUrl, validate connectivity

### Phase 4: Headless/Automation Support
- [ ] `ROUNDHOUSE_AGENT=openclaw roundhouse setup --headless ...` works
- [ ] Cloud-init/SSM scripts can specify agent type without interaction
- [ ] lowkey packs updated for all agent types

---

## Non-Goals (for now)

- **Runtime agent switching**: One agent per roundhouse instance. Switch via config + restart.
- **Multi-agent routing**: Different threads to different agents. Future consideration.
- **OpenClaw session management**: OpenClaw manages its own sessions; roundhouse just proxies.

---

## Compatibility Notes

- Pi adapter: No changes needed. Already works.
- Kiro adapter: Already implemented (PR #12). Needs `kiro-cli` on PATH.
- OpenClaw adapter: New work. Requires running gateway.
- Existing roundhouse installs: `roundhouse setup` re-run should detect and preserve existing agent config.
