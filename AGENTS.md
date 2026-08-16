# bennettvernon.com

Bennett Vernon's personal portfolio site: a single-page React + Vite +
TypeScript app whose background is a fullscreen particle physics simulation
built on [`@cazala/party`](https://github.com/cazala/party) (WebGPU with CPU
fallback). The visual baseline is the https://caza.la/party/ landing page —
white background, inverted-canvas particle rendering, rotating demo presets —
extended with pinned-particle typography and DOM-anchored force effectors.

## Repository layout

- `src/` — Application code. `src/party/` holds the engine wiring, demo
  presets, and the custom multi-effector force module.
- `vendor/party/` — Vendored fork of the `@cazala/party` engine core;
  imports keep the upstream package name via aliases. Every divergence from
  upstream is listed in `vendor/party/README.md`. Kept in upstream code
  style (exempt from repo ESLint, still typechecked).
- `public/` — Static assets, `CNAME`, and site content JSON.
- `.agents/` — Canonical shared skills, MCP definitions, and adapter scripts.
- `.claude/`, `.cursor/`, `.codex/`, `.mcp.json` — Agent-specific adapters;
  generated files must not be edited directly.

## Working conventions

- Keep the repo as small as possible. Prefer deleting code to adding it; no
  speculative abstractions or unused scaffolding.
- The demo preset JSONs under `src/party/sessions/` are adapted from the
  upstream Party playground (MIT). Keep them byte-stable unless intentionally
  retuning a preset.
- Front-end changes must be verified end-to-end in a real browser (dev server
  or preview build), including the WebGPU path when available.

## Agent configuration

- Use the `ponytail` skill at `ultra` intensity for every coding task in this
  repository. Treat it as the repo default for each session and keep it active
  unless the user explicitly selects another intensity or turns it off.
- Run `.agents/scripts/bootstrap.sh` to install development tooling and refresh
  shared agent configuration in local or cloud environments.
- Edit shared skills only in `.agents/skills/`, then run
  `.agents/scripts/link-skills.sh`.
- Edit MCP servers only in `.agents/mcp/servers.json`, then run
  `.agents/scripts/sync-mcp.sh`.
- Check generated MCP adapters with `.agents/scripts/sync-mcp.sh check`.
- Repo-local `.codex/config.toml` is generated for parity but is not loaded
  automatically by Codex. Run `.agents/scripts/sync-mcp.sh install-codex` only
  when the user wants this repo's MCP servers installed in their user config.
- When dispatching subagents or dynamic workflows, use a sensible distribution
  of models across speed, intelligence, and cost. Not everything needs the most
  expensive model.

## Validation

Run the checks relevant to the files changed:

```bash
npm run lint
npm run build
.agents/scripts/link-skills.sh
.agents/scripts/sync-mcp.sh check
git diff --check
pre-commit run --all-files  # when pre-commit is installed
```

Verify that every committed symlink resolves and review the final diff before
committing. Use focused, imperative commit messages and avoid combining
unrelated changes. GitHub Actions runs the agent-configuration checks and the
site build on pull requests and pushes to `particles`; treat those workflows as
the enforcement layer. Pushes to `particles` deploy straight to
https://bennettvernon.com via GitHub Pages. Don't leave work finished but not
synced with remote, don't wait for user confirmation before syncing your work.
Once work is finished and synced, don't leave stale worktrees and branches
behind.
