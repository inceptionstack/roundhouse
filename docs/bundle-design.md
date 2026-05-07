# roundhouse-bundle — Revised Design

Ship roundhouse with a pre-configured extension/skill/MCP stack. Skills are synced
from `inceptionstack/loki-skills` at install time (always latest from main).

---

## Goal

A user runs `roundhouse setup` and ends up with:

- pi installed and runnable
- 31 skills auto-synced from `inceptionstack/loki-skills` (AWS, DevOps, etc.)
- MCPorter skill for MCP server access
- Web-search extension (Tavily) registered
- MCP servers (AWS) wired via mcporter + playwright-cli for browser automation
- All managed by roundhouse — no separate "bundle" package to maintain

---

## Key Decisions

### No Separate npm Package
Roundhouse itself IS the bundle. No `@inceptionstack/roundhouse-bundle`.

### Skills Synced at Install Time (Not Shipped Statically)
Skills update frequently (upstream `kirodotdev/powers` merges, new skills added).
Shipping 2MB of skills inside the npm tarball means every skill update requires a
roundhouse version bump. Instead:

- `roundhouse setup` clones/pulls `inceptionstack/loki-skills` into `~/.pi/agent/skills/`
- `roundhouse update` re-syncs skills (alongside npm package update)
- Skills stay fresh without roundhouse releases

### Extensions Shipped in npm Package
Extensions are small, stable, and tightly coupled to roundhouse. They ship in `pi/extensions/`.

## Bundle Taxonomy

Everything in the bundle falls into one of four categories:

### 1. Skills (agent knowledge, loaded on-demand)
Markdown files that teach the agent HOW to do something. Progressive disclosure —
only descriptions in system prompt, full content loaded when task matches.
- Source: `inceptionstack/loki-skills` (synced at install)
- Location: `~/.pi/agent/skills/*/SKILL.md`
- Examples: aws-mcp, cloud-architect, strands, mcporter

### 2. CLI Tools (executables the agent calls via bash)
Globally-installed binaries. The agent discovers them via skills, calls via bash.
- `playwright-cli` — browser automation (navigate, click, fill, screenshot)
- `mcporter` — MCP server bridge (AWS APIs, docs, pricing)
- `uv`/`uvx` — Python package runner (needed by mcporter's AWS MCP servers)

### 3. Extensions (pi plugins, modify agent behavior)
TypeScript files that register tools or hooks into the pi runtime.
Shipped in the npm package at `pi/extensions/`.
- `web-search.ts` — registers `web_search` tool (Tavily API)

### 4. Configs (static files placed at known paths)
JSON/YAML config files that configure CLI tools. Shipped in `pi/config/`,
copied to target locations during setup.
- `mcporter.json` → `~/.mcporter/mcporter.json` (5 MCP server definitions)

---

## Directory Layout

```
@inceptionstack/roundhouse (npm -g)
├── src/                          # gateway, adapters, CLI
├── pi/                           # shipped in npm tarball
│   ├── extensions/
│   │   └── web-search.ts         # Tavily web search (env: TAVILY_API_KEY)
│   └── config/
│       └── mcporter.json         # MCP server definitions (copied to ~/.mcporter/)
└── package.json
    pi: { extensions: ["./pi/extensions"] }
    files: ["src/", "bin/", "pi/", ...]

~/.pi/agent/skills/               # synced at install time from loki-skills
├── aws-mcp/                      # AWS API execution via mcporter
├── cloud-architect/              # CDK patterns
├── mcporter/                     # how to call MCP servers via CLI
├── playwright-cli/               # browser automation via playwright-cli (TODO: create)
└── ... (31+ total)

Global CLI tools (installed during setup):
├── playwright-cli                # @playwright/cli — browser automation, screenshots
├── mcporter                      # MCP server bridge for AWS APIs
└── uvx                           # Python package runner (AWS MCP servers)
```

---

## Install flow

```
roundhouse setup
  1. Install pi globally (if missing)
  2. Install uv/uvx (if missing): curl | sh
  3. Install CLI tools: npm install -g mcporter @playwright/cli
  4. Run: playwright-cli install (downloads Chromium)
  5. Copy static mcporter.json → ~/.mcporter/mcporter.json
  6. Write ~/.pi/agent/settings.json:
     - provider, model
     - packages: ["npm:@inceptionstack/roundhouse"]  ← self-reference for extensions
  7. Sync skills from GitHub:
     git clone https://github.com/inceptionstack/loki-skills.git /tmp/loki-skills
     cp -r /tmp/loki-skills/*/ ~/.pi/agent/skills/
     (includes mcporter skill — no special handling needed)
  8. Run `pi install` (eager, discovers extensions from roundhouse's pi/ dir)
  9. Install systemd unit, start daemon
```

---

## Skill Sync Details

### Sync is ADDITIVE (never deletes)
The sync copies skills from loki-skills into `~/.pi/agent/skills/` but never removes
skills that exist locally but not in the repo. This allows:
- Custom/internal skills (bedrock-api-keys, task-board, loki-telemetry-lambda)
- User-created skills
- Skills from other sources

All coexist safely with the synced set.

### During `roundhouse setup`:
```bash
SKILLS_REPO="https://github.com/inceptionstack/loki-skills.git"
SKILLS_DIR="$HOME/.pi/agent/skills"

rm -rf /tmp/loki-skills
git clone --depth 1 "$SKILLS_REPO" /tmp/loki-skills
mkdir -p "$SKILLS_DIR"
for d in /tmp/loki-skills/*/; do
  [ -d "$d" ] && cp -r "$d" "$SKILLS_DIR/"  # overwrites matching names, leaves others
done
rm -rf /tmp/loki-skills
```

### During `roundhouse update` (alongside npm update):
Same additive sync — pull latest skills, overwrite matching, leave custom ones untouched.

### Skill format
- All skills use `SKILL.md` + `refs/` (converted from upstream POWER.md + steering/)
- Pi auto-discovers `~/.pi/agent/skills/*/SKILL.md` at session start
- OpenClaw uses identical format

---

## Packages installed during setup

| Package | Role |
|---|---|
| `@inceptionstack/roundhouse` (self) | Web-search extension, gateway |
| `mcporter` | MCP CLI runtime (bridges MCP servers into pi via bash) |
| `@playwright/cli` | Browser automation CLI (navigate, click, fill, screenshot) |

### System dependencies (installed during setup)
| Dependency | Install method | Purpose |
|---|---|---|
| `uv` / `uvx` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | Run AWS MCP servers |
| `git` | System package manager | Clone/sync loki-skills repo |
| Chromium | `playwright-cli install` | Headless browser for playwright-cli |
| Node.js (via mise) | Already present from roundhouse install | Runtime |

---

## Browser Automation (playwright-cli)

`playwright-cli` is a direct CLI tool — no MCP protocol needed. The agent calls it
via bash, same as any other command. Much simpler than routing through mcporter.

```bash
playwright-cli open "https://example.com"
playwright-cli snapshot                    # accessibility tree with refs
playwright-cli click e8                    # click by ref
playwright-cli fill e8 "hello"             # fill input
playwright-cli screenshot                  # save PNG
playwright-cli close
```

Key advantages over `@playwright/mcp` via mcporter:
- No MCP protocol overhead (direct CLI)
- Faster cold start (~1s vs npx + MCP handshake)
- Session persistence across calls (browser stays open)
- Same ref-based targeting as the MCP version
- Aligns with pi's "CLI tools + skills" philosophy

A `playwright-cli` skill (SKILL.md) teaches the agent the command patterns.

---

## MCP Servers (via mcporter CLI skill)

MCPorter is installed globally and configured at `~/.mcporter/mcporter.json`.
Pi accesses MCP tools via the `mcporter` skill (bash calls to `mcporter call`).

### Tier 1 — AWS APIs and documentation

| Server | Type | Purpose |
|---|---|---|
| `aws-mcp` | Local (uvx) | Execute 15K+ AWS APIs with SigV4 auth, SOPs, troubleshooting |
| `aws-knowledge` | Remote HTTP | AWS best practices, documentation search, regional availability |
| `aws-documentation` | Local (uvx) | Deeper doc reading, works offline, broader content parsing |
| `aws-iac` | Local (uvx) | CloudFormation docs, CDK best practices, security validation |
| `aws-pricing` | Local (uvx) | Real-time pricing data, cost estimation |

### Why mcporter skill (not pi-mcp-adapter extension)?
- Pi's philosophy: "Build CLI tools with READMEs (see Skills)"
- mcporter is a CLI tool — agent calls `mcporter call <server>.<tool> ...` via bash
- Zero token overhead (skill loaded on-demand, no tool registration in context)
- Lazy server startup — uvx servers start on first call
- Config lives in standard `~/.mcporter/mcporter.json`

---

## Extensions (shipped in npm package)

### `pi/extensions/web-search.ts`
Tavily web search integration. Registers `web_search` tool.
- Requires `TAVILY_API_KEY` environment variable
- Returns graceful error message if key not set
- 30s fetch timeout, proper abort signal handling
- Pi auto-discovers via `package.json` → `pi.extensions` → `["./pi/extensions"]`

---

## Skills (synced from loki-skills repo)

### Full list (31 skills)
From `inceptionstack/loki-skills` (synced from upstream `kirodotdev/powers`):
- arm-soc-migration, aws-agentcore, aws-amplify, aws-devops-agent
- aws-graviton-migration, aws-healthomics, aws-infrastructure-as-code
- aws-mcp, aws-observability, aws-sam, aws-step-functions, aws-transform
- checkout, claude-agent-sdk, cloud-architect, cloudwatch-application-signals
- cross-agent-test, datadog, dynatrace, gcp-aws-migrate, lambda-durable
- mcporter, neon, postman, power-builder, saas-builder
- spark-troubleshooting-agent, stackgen, strands, stripe, terraform

### MCPorter skill (primary MCP interface)
Teaches agent how to discover and call MCP servers via CLI.
Located at `~/.pi/agent/skills/mcporter/SKILL.md`.

---

## Implementation plan

1. ✅ Create `pi/extensions/web-search.ts` in roundhouse repo
2. ✅ Add `"pi"` key to package.json (`extensions: ["./pi/extensions"]`)
3. ✅ Add `"pi/"` to `files` array in package.json
4. ✅ Skill format converted in loki-skills repo (SKILL.md + refs/)
5. ✅ mcporter skill included in loki-skills (syncs with all other skills)
6. ✅ playwright-cli tested and validated (direct CLI, no MCP needed)
7. ✅ Create `playwright-cli` skill in loki-skills (SKILL.md with command reference)
8. [ ] Add `syncSkills()` function to `setup.ts` (git clone + copy)
9. [ ] Call `syncSkills()` in setup flow (after package install, before pi install)
10. [ ] Add skill sync to `roundhouse update` flow
11. [ ] Install CLI tools during setup (`npm install -g mcporter @playwright/cli`)
12. [ ] Run `playwright-cli install` during setup (downloads Chromium)
13. [ ] Copy static `mcporter.json` to `~/.mcporter/mcporter.json`
14. [ ] Install uv/uvx during setup (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
15. [ ] Handle pi-hard-no chat conflict (disable push-guard in chat mode)
16. [ ] Publish as next minor version

---

## Open questions

1. **pi-hard-no in chat mode**: Code review fires every turn — too noisy for quick chat. Options:
   - Disable by default, let user enable via /command
   - Only activate when `cwd` is inside a git repo
2. **uvx cold start**: Some MCP servers (aws-iac) take 30-45s on first call. Document this.
3. **Offline installs**: `git clone` requires network. Fail gracefully with warning if offline.
4. **Chromium size**: playwright-cli install downloads ~186MB Chromium. Worth it for browser automation,
   but document the disk requirement. Consider making it optional (`--no-browser` flag).

---

## Status: IN PROGRESS (feat/bundle branch)
