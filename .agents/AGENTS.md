# `.agents/`

Agent-agnostic configuration following the [Agent Skills](https://agentskills.io)
open standard and [AGENTS.md](https://agents.md) conventions.

Every piece of agent configuration is one of three things:

| Category | Strategy |
|---|---|
| **Portable** — same format everywhere | Store once here, symlink into agent directories |
| **Generated** — same data, different format | Canonical source here, sync script renders each adapter |
| **Agent-specific** — no cross-agent equivalent | Leave it in the agent's own directory |

Portable things get symlinks, generated things get a sync script, agent-specific
things stay put.

## Layout

- `skills/` — Shared skills. Each is a directory with `SKILL.md`.
- `mcp/servers.json` — Canonical MCP server configuration.
- `scripts/` — Portable environment setup, synchronization, and validation.

## Adding a skill

1. Create `.agents/skills/<name>/SKILL.md` with `name` and `description`
   frontmatter, where `name` matches the directory.
2. Run `.agents/scripts/link-skills.sh` and `.agents/scripts/check-skills.py --update`.
3. Commit the skill directory, the generated symlinks, and `skills-lock.json`.

## Installing a third-party skill

```bash
npx skills add <repo>@<skill> -y
```

## Adding an MCP server

1. Edit `.agents/mcp/servers.json`.
2. Run `.agents/scripts/sync-mcp.sh`.
3. Commit the canonical file and all generated adapters.

An optional `tools` array on a server is a read-only allowlist. It renders as
`enabled_tools` for Codex and `includeTools` for Gemini; Claude Code and Cursor
have no equivalent and receive the server's whole tool surface.

## Rules

- Edit skills in `.agents/skills/`, never through `.claude/skills/` or
  `.cursor/skills/`.
- Edit MCP definitions in `.agents/mcp/servers.json`, never in `.mcp.json`,
  `.cursor/mcp.json`, `.codex/config.toml`, or `.gemini/settings.json`.
- `.claude/settings.json` and `.gemini/settings.json` are hand-owned except for
  their `enabledMcpjsonServers` and `mcpServers` keys, which the sync rewrites.
- Agent-specific configuration stays put. `.cursor/rules/*.mdc` and
  `.github/instructions/*.instructions.md` use glob scoping and conditional
  loading with no equivalent elsewhere — do not convert them into skills.
  Knowledge every agent needs belongs in `AGENTS.md`.
- Keep secrets and machine-local configuration out of committed files.
- Run the pre-commit hooks or their underlying scripts before committing. GitHub
  Actions enforces the same checks for pull requests and `main`.
