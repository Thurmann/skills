# Skills and tools

This repository is the source of truth for personal skills and related tools.

- `skills/<skill-name>/` contains portable agent skills.
- `bridge/slack-fix-code-personal-bridge/` — the fix-code Slack bridge for personal use (uses your authenticated `gh` account).
- `bridge/slack-fix-code-company-bridge/` — the company variant: GitHub App installation tokens via a token file, and Claude via Vertex AI or Microsoft Foundry.
- `scripts/install-skills.py` installs the skills to Codex and, when present, Claude Code.
- `scripts/clean-worktrees.sh` removes fix-code worktrees under `$WORKSPACE/worktrees` (default `~/workspace/worktrees`), showing each worktree's branch, status, and added/last-changed dates. Run it with `--help` for options.

## Skills

- [`fix-code`](skills/fix-code/SKILL.md) — fix bugs, implement features, or build repositories in Simple, Medium, or Advanced mode (chosen by a cheap precheck) or an explicitly requested Fast mode for tiny changes, with isolated Git branches and pull requests.
- [`travel-vlog`](skills/travel-vlog/SKILL.md) — plan, edit, render, and verify chronological travel vlogs made from real footage.

## Install the skills

Run the installer after changing the source skills:

```bash
./scripts/install-skills.py
```

It updates matching skill folders in the active Codex home, `~/.agents/skills`, and `~/.codex/skills`. It also updates `~/.claude/skills` when Claude Code is present. It keeps unrelated installed skills and supports `--dry-run`.

Start a new agent session after installation so it discovers the updated skills. Keep project footage, proxies, render outputs, and personal production records out of this repository.

## Validate

Run `scripts/validate-skills.sh`. It uses Codex's `skill-creator` validator when Python with PyYAML is available, and otherwise checks skill frontmatter with Ruby's standard YAML parser.

## Licensing

No repository license has been selected yet. Choose one before publishing if you want to grant reuse rights.
