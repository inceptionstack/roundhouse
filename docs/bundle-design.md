# roundhouse-bundle — Revised Design

Ship roundhouse with a pre-configured extension/skill/MCP stack as part of the roundhouse package itself.

---

## Goal

A user runs `roundhouse setup` and ends up with:

- pi installed and runnable
- Automatic code review (pi-hard-no) active
- MCP servers (AWS, Playwright) wired via pi-mcp-adapter
- AWS skills loaded (cloud architect, infrastructure, observability)
- Roundhouse-specific skills and prompt templates loaded
- All managed by roundhouse's own version — no separate "bundle" package to maintain

---

## Key Decision: No Separate npm Package

Pi is an internal implementation detail of roundhouse. The "bundle" is roundhouse itself.

**Why not a separate `@inceptionstack/roundhouse-bundle` package:**
- Adds a publish/version/repo to maintain for no user benefit
- "Non-roundhouse pi users" is not a real use case
- Roundhouse already has the machinery to install pi packages during setup
- Custom extensions/skills can live inside the roundhouse repo directly

**Instead:** Expand roundhouse's setup to install the required packages directly, and ship custom extensions/prompts as files within the roundhouse npm package.

---

## Architecture

```
@inceptionstack/roundhouse (npm -g)
├── src/                          # gateway, adapters, CLI
├── pi/                           # NEW: bundled pi extensions & prompts
│   ├── extensions/
│   │   └── gateway-context/      # injects platform/thread metadata
│   ├── skills/
│   │   ├── roundhouse-operator/  # chat etiquette, brevity, commands
│   │   ├── aws-mcp/              # AWS MCP power skill
│   │   ├── cloud-architect/      # AWS architecture patterns
│   │   ├── aws-infrastructure-as-code/  # CDK/CFN/Terraform
│   │   └── aws-observability/    # CloudWatch, X-Ray, monitoring
│   ├── prompts/
│   │   └── chat-default.md       # chat-aware prompt template
│   └── mcp.json                  # MCP server definitions
└── package.json
    pi: { extensions: ["./pi/extensions"], skills: ["./pi/skills"], prompts: ["./pi/prompts"] }
```

---

## Install flow

```
roundhouse setup
  1. Install pi globally (if missing)
  2. Install uv/uvx (if missing): curl | sh
  3. Install mcporter globally: npm install -g mcporter
  4. Write ~/.mcporter/mcporter.json with MCP server definitions
  5. Write ~/.pi/agent/settings.json:
     - provider, model
     - packages: [
         "npm:@inceptionstack/pi-hard-no",
         "npm:@inceptionstack/roundhouse"   ← self-reference for pi/ dir
       ]
  6. Copy skills to ~/.pi/agent/skills/ (mcporter skill)
  7. Run `pi install` on each package (eager, not lazy)
  8. Install systemd unit, start daemon
```

The self-reference (`npm:@inceptionstack/roundhouse`) lets pi discover the `pi/` directory
via the `pi` key in roundhouse's package.json — no separate package needed.

---

## Packages installed during setup

| Package | Role |
|---|---|
| `@inceptionstack/pi-hard-no` | Auto code review after every turn |
| `mcporter` | MCP CLI runtime (bridges MCP servers into pi via bash) |
| `@inceptionstack/roundhouse` (self) | Gateway-context extension, chat skills, prompts |

### System dependencies (installed during setup)
| Dependency | Install method | Purpose |
|---|---|---|
| `uv` / `uvx` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | Run AWS MCP servers |
| Node.js (via mise) | Already present from roundhouse install | Run playwright MCP |

---

## MCP Servers (via mcporter CLI skill)

MCPorter is installed globally and configured at `~/.mcporter/mcporter.json`.
Pi accesses MCP tools via the `mcporter` skill (bash calls to `mcporter call`).

### Tier 1 — Essential for any AWS builder

| Server | Type | Purpose |
|---|---|---|
| `aws-mcp` | Local (uvx) | Execute 15K+ AWS APIs with SigV4 auth, SOPs, troubleshooting |
| `aws-knowledge` | Remote HTTP | AWS best practices, documentation search, regional availability, agent skills |
| `aws-documentation` | Local (uvx) | Deeper doc reading, works offline, broader content parsing |
| `aws-iac` | Local (uvx) | CloudFormation docs, CDK best practices, security validation, IaC troubleshooting |
| `aws-pricing` | Local (uvx) | Real-time pricing data, cost estimation, CDK/Terraform project analysis |
| `playwright` | Local (npx) | Browser automation: navigate, screenshot, click, fill forms |

### Why mcporter skill (not pi-mcp-adapter extension)?
- Pi explicitly says "No MCP. Build CLI tools with READMEs (see Skills)"
- mcporter is a CLI tool — agent calls `mcporter call <server>.<tool> ...` via bash
- Zero token overhead (skill loaded on-demand, no tool registration in context)
- Lazy server startup — uvx servers start on first call
- Config lives in standard `~/.mcporter/mcporter.json`

### Dependencies
- `mcporter` (npm global): MCP CLI runtime
- `uv` / `uvx` (astral.sh): Python package runner for AWS MCP servers
- Playwright chromium: auto-downloaded by npx on first use

---

## Skills (shipped in roundhouse repo)

### MCPorter skill (primary MCP interface)
| Skill | Location | Purpose |
|---|---|---|
| `mcporter` | `~/.pi/agent/skills/mcporter/` | Teaches agent how to discover and call MCP servers via CLI |

### Roundhouse-specific
| Skill | Purpose |
|---|---|
| `roundhouse-operator` | Chat etiquette, brevity, message splitting (4096 char limit), voice-friendly formatting |
| `gateway-context` (extension) | Injects platform/thread metadata at session start |

---

## Custom extensions (shipped in roundhouse repo)

### `pi/extensions/gateway-context/`
Injects a `<gateway>` block at session start: platform (telegram/slack), thread ID,
voice STT status, available commands (/new, /compact, /stop, /update). Lets the agent tailor responses.

---

## Implementation plan

1. Create `pi/` directory structure in roundhouse repo
2. Add `"pi"` key to package.json pointing to extensions/skills/prompts
3. Copy + adapt skills from openclaw (aws-mcp, cloud-architect, aws-infra, aws-observability)
4. Create `pi/mcp.json` with the 5 MCP server definitions
5. Create `pi/extensions/gateway-context/` extension
6. Create `pi/skills/roundhouse-operator/` skill
7. Update `setup.ts` to:
   - Add pi-hard-no, pi-mcp-adapter, self to settings.packages
   - Copy/symlink mcp.json to pi agent dir
   - Run `pi install` eagerly
8. Handle pi-hard-no chat conflict (may need config to disable push-guard in chat mode)
9. Publish as next minor version

---

## Open questions

1. **pi-hard-no in chat mode**: Code review fires every turn — may be too noisy for quick chat. Options:
   - Disable by default, let user enable via /command
   - Ship but configure with higher threshold
   - Only activate when `cwd` is inside a git repo
2. **uvx cold start**: Some MCP servers (aws-iac) take 30-45s on first call due to Python env setup. Subsequent calls are fast (cached). Document this.
3. **MCP config location**: `~/.mcporter/mcporter.json` (user-global, standard mcporter path)
4. **Additional MCP servers**: Users can add more by editing `~/.mcporter/mcporter.json` — the skill documents how
5. **Skill shipping**: Copy `mcporter/SKILL.md` to `~/.pi/agent/skills/mcporter/` during setup, OR ship in roundhouse's `pi/skills/` dir (self-reference approach)

---

## Status: READY TO IMPLEMENT
