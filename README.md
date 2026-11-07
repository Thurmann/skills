# Skills and tools

This repository is the source of truth for personal skills and related tools.

- `skills/<skill-name>/` contains portable agent skills.
- `bridge/` contains the fix-code Slack bridge application.
- `scripts/install-skills.py` installs the skills to Codex and, when present, Claude Code.

## Skills

- [`fix-code`](skills/fix-code/SKILL.md) — fix bugs, implement features, or build repositories with isolated Git branches and pull requests.
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
