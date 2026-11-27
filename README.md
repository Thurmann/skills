# Skills and tools

This repository is the source of truth for personal skills and related tools.

- `skills/<skill-name>/` contains portable agent skills.
- `bridge/slack-bridge-core/` — the shared fix-code Slack bridge code (protocol, queue, runner, Git, routing, config, CLI) and cloud deployment scripts in `deploy/`; see [`deploy/README.md`](bridge/slack-bridge-core/deploy/README.md) for the cloud setup.
- `bridge/slack-fix-code-personal-bridge/` — the personal variant: runs locally with your authenticated `gh` account.
- `bridge/slack-fix-code-personal-cloud-bridge/` — the personal variant on an unattended cloud VM, with a personal GitHub token file.
- `bridge/slack-fix-code-company-bridge/` — the company variant: GitHub App installation tokens via a token file, and Claude via Vertex AI or Microsoft Foundry.
- `scripts/install-skills.py` installs the skills to Codex and, when present, Claude Code, and copies the helper scripts below into `$WORKSPACE`.
- `scripts/clean-worktrees.sh` removes fix-code worktrees under `$WORKSPACE/worktrees` (default `~/workspace/worktrees`), showing each worktree's branch, status, and added/last-changed dates. Run it with `--help` for options.
- `scripts/open-prs.sh [dir ...]` lists the open GitHub pull requests of every repository found recursively under the given folders (default: the current directory), grouped by repository, with each `PR#N` as a clickable terminal link. Requires an authenticated `gh` CLI.

## Skills

- [`fix-code`](skills/fix-code/SKILL.md) — fix bugs, implement features, or build repositories in Simple, Medium, or Advanced mode (chosen by a cheap precheck), with isolated Git branches and pull requests.
- [`travel-vlog`](skills/travel-vlog/SKILL.md) — plan, edit, render, and verify chronological travel vlogs made from real footage.

## Install the skills

Run the installer after changing the source skills:

```bash
./scripts/install-skills.py
```

It updates matching skill folders in `~/.agents/skills`, where Codex reads user skills. It also updates `~/.claude/skills` when Claude Code is present. It keeps unrelated installed skills and supports `--dry-run`.

It also copies `clean-worktrees.sh` to `$WORKSPACE/worktrees/` and `open-prs.sh` to `$WORKSPACE/` (default `~/workspace`), so `~/workspace/open-prs.sh` checks every repository in the workspace.

Start a new agent session after installation so it discovers the updated skills. Keep project footage, proxies, render outputs, and personal production records out of this repository.

## Validate

Run `scripts/validate-skills.sh`. It uses Codex's `skill-creator` validator when Python with PyYAML is available, and otherwise checks skill frontmatter with Ruby's standard YAML parser.

## Licensing

No repository license has been selected yet. Choose one before publishing if you want to grant reuse rights.
