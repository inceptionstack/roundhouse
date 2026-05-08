# Roundhouse Usability Report

> Date: 2026-05-08 (updated after PR #13, #16 fixes)  
> Based on: First macOS install by a new user (fresh machine, no prior config)  
> Version tested: 0.4.3 (pre-fix) → fixes shipping in next publish

---

## Frictions Observed (in order of encounter)

### 1. ~~`roundhouse install` crashes on macOS~~
**Status:** ✅ Fixed in PR #13 — detects darwin, explains alternatives  

---

### 2. ~~`roundhouse start` fails: "TELEGRAM_BOT_TOKEN is required"~~
**Status:** ✅ Fixed in PR #13 — `loadEnvFile()` with proper unescaping  

---

### 3. ~~Extension conflict: "Tool web_search conflicts"~~
**Status:** ✅ Fixed in PR #16 — extensions copied to user dir only if not already present; no auto-load via package.json  

---

### 4. ⚠️ Pairing UX during setup
**Symptom:** "Pairing timed out. Run 'roundhouse pair' later."  
**Root cause:** User must switch to Telegram, find the bot, send `/start <code>` within timeout window  
**Impact:** Setup "succeeds" but pairing doesn't — user must run a second command later  
**Note:** Timeout is actually 300s (5 min), not 60s as originally reported. The real issue is that users don't notice the link or don't know what to do with it.

**Planned fixes:**
- [ ] Auto-open the Telegram deep link on macOS (`open <url>`)
- [ ] After timeout: offer to retry immediately instead of requiring `roundhouse pair`
- [ ] Show clearer instructions: "Open Telegram NOW and tap the link above"
- [ ] Add a visual countdown or "waiting for pairing..." spinner

---

### 5. ⚠️ npm deprecation warnings spam
**Symptom:** Every npm operation shows 5+ deprecation warnings about `@mariozechner/pi-*` packages  
**Root cause:** Upstream pi SDK packages are deprecated in favor of `@earendil-works/pi-*`  
**Impact:** Looks broken/abandoned to new users; clutters terminal  

**Planned fixes:**
- [ ] Migrate dependency to `@earendil-works/pi-coding-agent` (requires testing)
- [ ] Short-term: suppress npm stderr during auto-install operations in setup
- [ ] Track upstream: check if `@earendil-works` packages are stable enough to switch

---

### 6. ⚠️ Whisper/STT auto-install during first message
**Symptom:** First user message triggers `pip3 install openai-whisper` in the background  
**Root cause:** STT enabled by default; whisper binary not pre-installed  
**Impact:** Delayed response on first message; `--help` failure logged  

**Planned fixes:**
- [ ] Move STT dependency install to `roundhouse setup` (postflight check)
- [ ] If whisper not available at startup, log once and disable STT gracefully
- [ ] Default to `--no-voice` on macOS (whisper install is heavy via pip)
- [ ] Suppress `--help` check noise if binary works for actual transcription

---

### 7. 💡 `roundhouse setup` output polish
**Observations:**
- Step circled-number labels don't match execution order (e.g. ③ used for both username and stop-gateway, ⑥ used for both pairing and secrets, ⑥b for bundle)
- "Not Linux — skipping service check" is internal jargon
- Extensions installed during setup trigger npm output noise
- No visual feedback during 5-min pairing wait

**Planned fixes:**
- [ ] Renumber steps sequentially to match actual execution order (10 steps, ①-⑩)
- [ ] Replace platform jargon with user-friendly messaging
- [ ] Capture npm stdout/stderr during extension install; show only on failure
- [ ] Add spinner/countdown during pairing wait
- [ ] Add a final "What to do next" block

---

### 8. 💡 No clear "getting started" path
**Observation:** User tried `install` → `setup` → `start` (3 commands). Should be `setup` → `start`.  

**Planned fixes:**
- [ ] `roundhouse setup --telegram` is the ONLY required command after npm install
- [ ] `roundhouse install` becomes internal/advanced (or merged into setup for Linux)
- [ ] README "Quick Start": 2 steps max
- [ ] Setup auto-runs `roundhouse start` at the end (or offers to)

---

### 9. 💡 No TAVILY_API_KEY guidance
**Symptom:** After setup, first web search fails with "TAVILY_API_KEY not set"  
**Root cause:** Extension requires env var but setup never mentions it  
**Impact:** Users think web search is broken  

**Planned fixes:**
- [ ] Add `TAVILY_API_KEY` to setup's env file template (with empty placeholder)
- [ ] Show hint in postflight: "Set TAVILY_API_KEY in ~/.roundhouse/.env for web search"
- [ ] Consider: free tier Tavily key provisioning during setup

---

### 10. 💡 No agent environment detection
**Symptom:** Setup always installs Pi even if user has OpenClaw or Kiro  
**Root cause:** No detection logic for existing agent backends  
**Impact:** Unnecessary installs; OpenClaw users can't use roundhouse as Telegram frontend  

**Planned fixes:** (see `docs/multi-agent-onboarding.md`)
- [ ] `detectEnvironment()` checks for pi/oc/kiro binaries and configs
- [ ] Skip install if agent already configured
- [ ] Offer choice when multiple backends detected
- [ ] OpenClaw adapter (separate PR — HTTP proxy to gateway)

---

### 11. 💡 Setup reinstalls packages unnecessarily  
**Symptom:** npm install runs even if packages are present → deprecation noise  
**Root cause:** No binary/version check before attempting install  

**Planned fixes:**
- [ ] Check `which pi` / package exists before running npm install
- [ ] If installed and correct version, skip with ✓ message
- [ ] Suppress npm stderr (pipe to /dev/null, show on failure only)

---

### 12. 💡 `roundhouse start` without prior setup gives confusing error
**Symptom:** `process.exit(1)` with "failed to load config from ROUNDHOUSE_CONFIG=..."  
**Root cause:** No guard in `cmdStart`/`cmdRun` checking if config exists before launching  
**Impact:** New user who skips setup and runs `start` sees a crash, not a helpful hint  

**Planned fixes:**
- [ ] Check if config file exists before spawning gateway
- [ ] If missing: print "Run 'roundhouse setup --telegram' first" and exit cleanly

---

## Priority Matrix

| # | Friction | Severity | Status | Effort |
|---|----------|----------|--------|--------|
| 1 | systemd on macOS | High | ✅ Done (PR #13) | — |
| 2 | .env not loaded | High | ✅ Done (PR #13) | — |
| 3 | Extension conflict | Medium | ✅ Done (PR #16) | — |
| 4 | Pairing UX (not timeout—already 5min) | Medium | Open | Low |
| 5 | npm deprecation spam | Medium | Open | Medium |
| 6 | Whisper auto-install | Low | Open | Low |
| 7 | Setup step numbering | Low | Open | Low |
| 8 | Getting started flow | Medium | Open | Medium |
| 9 | TAVILY_API_KEY guidance | Low | Open | Low |
| 10 | Agent detection | Medium | Open | Medium |
| 11 | Unnecessary reinstalls | Low | Open | Low |
| 12 | start without setup crashes | Medium | Open | Low |

---

## Recommended Next Steps (updated)

### v0.4.5 — Quick wins
1. **Pairing UX** (item 4): Auto-open Telegram link on macOS, add spinner during wait
2. **TAVILY_API_KEY** (item 9): Add placeholder to .env template, hint in postflight
3. **Start guard** (item 12): Check config exists before spawning, hint to run setup
4. **Step numbering** (item 7): Renumber to match execution order
5. **Skip reinstall** (item 11): Check binary exists before npm install

### v0.5.0 — Onboarding
6. **Agent detection** (item 10): `detectEnvironment()` in setup preflight
7. **Simplify onboarding** (item 8): setup = single entry point, offer to auto-start
8. **Suppress npm noise** (items 5, 11): pipe stderr, show only on failure

### Longer-term
9. **Migrate pi SDK** (item 5): switch to `@earendil-works/pi-coding-agent`
10. **OpenClaw adapter** (item 10): HTTP/SSE proxy to localhost gateway
11. **STT setup-time install** (item 6): whisper check in postflight, default off on macOS
