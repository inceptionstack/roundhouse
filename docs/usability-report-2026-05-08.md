# Roundhouse Usability Report

> Date: 2026-05-08  
> Based on: First macOS install by a new user (fresh machine, no prior config)  
> Version tested: 0.4.3 (pre-fix)

---

## Frictions Observed (in order of encounter)

### 1. ❌ `roundhouse install` crashes on macOS
**Symptom:** Attempts systemd operations, fails with "sudo: a password is required"  
**Root cause:** No platform detection — assumes Linux/systemd unconditionally  
**Impact:** First command a user tries after `npm install -g` fails with a scary stack trace  
**Status:** ✅ Fixed in PR #13 — detects darwin, explains alternatives  

**Remaining work:**
- [ ] Consider adding `launchd` plist generation for macOS (like systemd on Linux)
- [ ] Or: document the `roundhouse start` foreground approach for macOS in onboarding

---

### 2. ❌ `roundhouse start` fails: "TELEGRAM_BOT_TOKEN is required"
**Symptom:** Setup writes token to `~/.roundhouse/.env` but start doesn't read it  
**Root cause:** `cmdRun()` spawned the gateway without loading the env file  
**Impact:** User must manually `export TELEGRAM_BOT_TOKEN=...` before starting — defeats the purpose of setup writing secrets to .env  
**Status:** ✅ Fixed in PR #13 — `loadEnvFile()` called before gateway spawn  

**Remaining work:**
- [ ] Add a pre-start check: if `.env` exists but key secrets are missing from env, warn clearly
- [ ] Consider: `roundhouse start` could validate token against Telegram API before spawning

---

### 3. ⚠️ Extension conflict: "Tool web_search conflicts"
**Symptom:** Pi agent logs an error about duplicate `web_search` tool registration  
**Root cause:** Roundhouse shipped `pi/extensions/web-search.ts` in npm package AND users have their own copy in `~/.pi/agent/extensions/`  
**Impact:** Confusing error in logs; unclear which version "wins"  
**Status:** ✅ Fixed in PR #13 — removed bundled extension; user-level copy is canonical  

**Remaining work:**
- [ ] Bundle provisioner should detect existing user extensions before installing duplicates
- [ ] Consider extension dedup logic in Pi agent loader (upstream)

---

### 4. ⚠️ Pairing timeout during setup
**Symptom:** "Pairing timed out. Run 'roundhouse pair' later."  
**Root cause:** User must switch to Telegram, find the bot, send `/start <code>` within timeout window  
**Impact:** Setup "succeeds" but pairing doesn't — user must run a second command later  

**Planned fixes:**
- [ ] Increase pairing timeout (currently 60s → consider 120s or 180s)
- [ ] Show clearer instructions: "Open Telegram NOW and tap the link above"
- [ ] After timeout: offer to retry immediately instead of requiring `roundhouse pair`
- [ ] Consider: auto-open the Telegram link on macOS (`open <url>`)

---

### 5. ⚠️ npm deprecation warnings spam
**Symptom:** Every npm operation shows 5+ deprecation warnings about `@mariozechner/pi-*` packages  
**Root cause:** Upstream pi SDK packages are deprecated in favor of `@earendil-works/pi-*`  
**Impact:** Looks broken/abandoned to new users; clutters terminal  

**Planned fixes:**
- [ ] Migrate dependency to `@earendil-works/pi-coding-agent` (requires testing)
- [ ] Short-term: suppress npm stderr during auto-install operations
- [ ] Track upstream: check if `@earendil-works` packages are stable enough to switch

---

### 6. ⚠️ Whisper/STT auto-install during first message
**Symptom:** First user message triggers `pip3 install openai-whisper` in the background  
**Root cause:** STT enabled by default; whisper binary not pre-installed  
**Impact:** Delayed response on first message; `--help` failure logged even after install  

**Planned fixes:**
- [ ] Move STT dependency install to `roundhouse setup` (preflight/postflight)
- [ ] If whisper not available at startup, log once and disable STT gracefully
- [ ] Consider: `--no-voice` should be the default on macOS (whisper install is heavy)
- [ ] Fix: suppress `--help` check failure if binary works for actual transcription

---

### 7. 💡 `roundhouse setup` output could be friendlier
**Observations:**
- Step numbers skip (①②③③④⑥b⑥⑥⑦⑧⑨⑩) — confusing
- "Not Linux — skipping service check" is internal jargon
- Extensions installed during setup trigger npm output noise

**Planned fixes:**
- [ ] Renumber steps sequentially (no skips, no 6b)
- [ ] Replace "Not Linux" with platform-appropriate messaging
- [ ] Capture npm stdout/stderr during extension install; show only on failure
- [ ] Add a final summary block with "What to do next" steps

---

### 8. 💡 No clear "getting started" path
**Observation:** User tried `install` → `setup` → `start` (3 commands). Should be just `setup` → `start`.  

**Planned fixes:**
- [ ] `roundhouse setup --telegram` should be the ONLY required command after npm install
- [ ] `roundhouse install` should be an internal/advanced command (or merged into setup for Linux)
- [ ] Add post-install npm hook or `npx @inceptionstack/roundhouse` entry point that runs setup
- [ ] README "Quick Start" section: make it 2 steps max

---

## Priority Matrix

| # | Friction | Severity | Status | Effort |
|---|----------|----------|--------|--------|
| 1 | systemd on macOS | High | ✅ Done | — |
| 2 | .env not loaded | High | ✅ Done | — |
| 3 | Extension conflict | Medium | ✅ Done | — |
| 4 | Pairing timeout | Medium | Planned | Low |
| 5 | npm deprecation spam | Medium | Planned | Medium (upstream dep) |
| 6 | Whisper auto-install | Low | Planned | Low |
| 7 | Setup output polish | Low | Planned | Low |
| 8 | Getting started flow | Medium | Planned | Medium |

---

## Recommended Next Steps

1. **Publish v0.4.4** with the fixes from PR #13 (items 1-3 resolved)
2. **Pairing UX** (item 4): increase timeout, auto-open link on macOS
3. **Migrate pi SDK** (item 5): switch to `@earendil-works/pi-coding-agent`
4. **Simplify onboarding** (item 8): make `setup` the single entry point
5. **STT setup-time install** (item 6): move whisper check to setup postflight
