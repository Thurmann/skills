# Skills

A collection of self-contained Codex skills. Each skill lives under `skills/<skill-name>/` and can be copied into a Codex skills directory on its own.

## Skills

- [`travel-vlog`](skills/travel-vlog/SKILL.md) — plan, edit, render, and verify chronological travel vlogs made from real footage.

## Install a skill

Copy the skill folder into your Codex skills directory, then restart the Codex session so it can discover the new skill:

```bash
mkdir -p ~/.codex/skills
cp -R skills/travel-vlog ~/.codex/skills/
```

For multiple skills, copy each selected folder from `skills/`. Keep project footage, proxies, render outputs, and personal production records out of this repository.

## Validate

Run `scripts/validate-skills.sh`. It uses Codex's `skill-creator` validator when Python with PyYAML is available, and otherwise checks skill frontmatter with Ruby's standard YAML parser.

## Licensing

No repository license has been selected yet. Choose one before publishing if you want to grant reuse rights.
