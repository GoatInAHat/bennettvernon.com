# bennettvernon.com

Bennett Vernon's personal portfolio site: a single-page React + Vite +
TypeScript app whose background is a fullscreen particle physics simulation
built on [`@cazala/party`](https://github.com/cazala/party) (WebGPU with CPU
fallback). The visual baseline is the https://caza.la/party/ landing page —
white background, inverted-canvas particle rendering, rotating demo presets —
extended with pinned-particle typography and DOM-anchored force effectors.

## Repository layout

| Path | Purpose |
|---|---|
| `src/` | Application code. `src/party/` holds the engine wiring, demo presets, and the custom multi-effector force module. |
| `vendor/party/` | Vendored fork of the `@cazala/party` engine core; imports keep the upstream package name via aliases. Every divergence from upstream is listed in `vendor/party/README.md`. Kept in upstream code style (exempt from repo ESLint and the trailing-whitespace check, still typechecked). |
| `public/` | Static files served verbatim; currently the Pages `CNAME` and the favicon. |
| `.agents/` | Canonical shared skills, MCP definitions, and adapter scripts. |
| `.claude/`, `.cursor/`, `.codex/`, `.gemini/`, `.github/`, `.mcp.json` | Agent adapters. Generated files must not be edited directly. |
| `.devcontainer/` | Container definition for Codespaces and local devcontainers. |

## Working conventions

- Keep the repo as small as possible. Prefer deleting code to adding it; no
  speculative abstractions or unused scaffolding.
- The demo preset JSONs under `src/party/sessions/` are adapted from the
  upstream Party playground (MIT). Keep them byte-stable unless intentionally
  retuning a preset.
- Front-end changes must be verified end-to-end in a real browser (dev server
  or preview build), including the WebGPU path when available.

## Code quality

- Prefer correct, complete implementations over minimal ones. Complete means
  every path the requested behaviour needs actually works — not extra paths
  nobody asked for. Speculative generality is a defect, not thoroughness.
- **Never write a second implementation of something this repo already does.**
  Look for the existing helper, type, or pattern before writing a new one. If it
  doesn't fit, change it where it lives so every caller gets the fix.
- Use appropriate data structures and algorithms; don't brute-force what has a
  known better solution.
- When fixing a bug, fix the root cause, not the symptom. Check every caller of
  the function you are about to change; one guard in the shared path beats a
  guard in each caller, and patching only the reported path leaves its siblings
  broken.
- If something requires or could use error handling or validation to work
  reliably, include it without asking. Never simplify away validation at trust
  boundaries, error handling that prevents data loss, security controls, or
  accessibility basics.

## Dispatching work

Whenever work leaves your own context — dynamic workflows, subagents, background
tasks, scheduled jobs, parallel fan-out, anything — balance the models used
across intelligence and speed rather than sending every step to one tier. Match
the model to the step: fast and cheap for mechanical scans, fan-out, and
summarisation; the strongest available for design, adversarial review, and final
synthesis. Prefer a mix over a single tier by default, and say which tier a step
is using when it matters.

## Skills and MCP

- **Ponytail is always on**, at `ultra` intensity, for every coding task here.
  Read `.agents/skills/ponytail/SKILL.md` and apply it on every response; keep
  it active unless the user explicitly changes intensity or turns it off.
  `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`, and
  `ponytail-review` are pinned beside it.
- **find-skills** covers skill discovery — reach for it when a task looks like
  something an installable skill already does.
- **party**, **vite**, and **vercel-react-best-practices** are pinned for this
  repo's stack: the particle engine, the build tool, and the React surface.
- **Context7** is registered for library documentation: `resolve-library-id`
  then `query-docs`, rather than recalling an API from memory. It works
  unauthenticated at a lower rate limit; set `CONTEXT7_API_KEY` and add the
  `Authorization: Bearer` header for your harness to raise it.

## Agent configuration

- Run `.agents/scripts/bootstrap.sh` once per fresh checkout. It is idempotent
  and is what every cloud environment runs on startup.
- Edit shared skills only in `.agents/skills/`, then run
  `.agents/scripts/link-skills.sh`.
- Edit MCP servers only in `.agents/mcp/servers.json`, then run
  `.agents/scripts/sync-mcp.sh`.
- Repo-local `.codex/config.toml` is generated for parity but is not loaded
  automatically by the Codex CLI. Run `.agents/scripts/sync-mcp.sh install-codex`
  only when the user wants this repo's MCP servers in their user config.
- Never commit credentials. Secrets come from the environment or an ignored
  `.env`; `.env.example` documents the variables.

## Documentation

- Keep `README.md` minimal and honest. Update it in the same change that makes
  it wrong, not later.
- Keep this file current as the project changes, and keep it small. It loads into
  every agent's context on every session, so it pays rent: record only what
  changes an agent's behaviour, drop anything the code or `--help` already says,
  and prefer one precise line to a paragraph.

## Validation

Run the checks relevant to the files changed:

```bash
npm run lint
npm run build
npm run check:force
npm run check:density
.agents/scripts/link-skills.sh
.agents/scripts/sync-mcp.sh check
.agents/scripts/check-skills.py
git diff --check
pre-commit run --all-files
```

Verify that every committed symlink resolves and review the final diff before
committing. Use focused, imperative commit messages and avoid combining
unrelated changes. GitHub Actions lints, builds, and runs the
physics checks on pull requests, validates agent configuration when it
changes, and deploys every push to `main`; treat those workflows as the
enforcement layer. Pushes to `main` deploy straight to
https://bennettvernon.com via GitHub Pages. Don't leave work finished but not
synced with remote, don't wait for user confirmation before syncing your work.
Once work is finished and synced, don't leave stale worktrees and branches
behind.
