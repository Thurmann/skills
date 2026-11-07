# Contributing

- Keep each skill self-contained under `skills/<skill-name>/`, with its own `SKILL.md`.
- Use lowercase letters, digits, and hyphens in skill directory names.
- Keep the frontmatter `name` equal to the directory name and make `description` specific enough to help Codex select the skill correctly.
- Add `references/`, `scripts/`, or `assets/` only when the skill needs them. Link references from `SKILL.md`; avoid duplicating their content in multiple files.
- Keep examples generic or clearly labeled as project-specific. Remove private paths, itineraries, media, and personal information before publishing publicly.
- Validate all skill directories with `scripts/validate-skills.sh` before opening a pull request.
