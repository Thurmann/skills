# Skills and tools

This repository is the source of truth for personal skills and related tools.

- `skills/<skill-name>/` contains portable agent skills.
- `bridge/slack-bridge-core/` — the shared fix-code Slack bridge code (protocol, queue, runner, Git, routing, config, CLI) and cloud deployment scripts in `deploy/`; see its [`README.md`](bridge/slack-bridge-core/README.md), [`docs/architecture.md`](bridge/slack-bridge-core/docs/architecture.md), and [`deploy/README.md`](bridge/slack-bridge-core/deploy/README.md) for the cloud setup.
- `bridge/slack-fix-code-personal-bridge/` — the personal variant: runs locally with your authenticated `gh` account.
- `bridge/slack-fix-code-personal-cloud-bridge/` — the personal variant on an unattended cloud VM, with a personal GitHub token file; [`scripts/azure-up.sh`](bridge/slack-fix-code-personal-cloud-bridge/scripts/azure-up.sh) sets it up on Azure in one command.
- `bridge/slack-fix-code-company-bridge/` — the company variant: GitHub App installation tokens via a token file, and Claude via Vertex AI or Microsoft Foundry.
- `scripts/install-skills.py` installs the skills to Codex and, when present, Claude Code, and copies the helper scripts below into `$WORKSPACE`.
- `scripts/clean-worktrees.sh` removes fix-code worktrees under `$WORKSPACE/worktrees` (default `~/workspace/worktrees`), showing each worktree's branch, status, and added/last-changed dates. Run it with `--help` for options.
- `scripts/open-prs.sh [dir ...]` lists the open GitHub pull requests of every repository found recursively under the given folders (default: the current directory), grouped by repository, with each `PR#N` as a clickable terminal link. Requires an authenticated `gh` CLI.

## Skills

- [`fix-code`](skills/fix-code/SKILL.md) — fix bugs, implement features, or build repositories in Simple, Medium, or Advanced mode (chosen by a cheap precheck) or an explicitly requested Fast mode for tiny changes, with isolated Git branches and pull requests.
- [`quiz-gen`](skills/quiz-gen/SKILL.md) — create or improve quizzes in the PracticeCore JSON format for PracticeCLI and the browser, including MultiAnswer questions, with answer-choice cue review and a final wording cleanup.
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

CI runs, on every push and pull request: `npm run check` and `npm test` for the four bridge packages, `python skills/fix-code/scripts/test_git_guard.py`, `scripts/validate-skills.sh`, and shellcheck at warning severity on all `*.sh` files.

`scripts/validate-skills.sh` uses Codex's `skill-creator` validator when it is installed and Python has PyYAML, and otherwise checks skill frontmatter with Ruby's standard YAML parser. Run the bridge tests locally with `cd bridge/<package> && npm ci && npm test`.

## Licensing

No repository license has been selected yet. Choose one before publishing if you want to grant reuse rights.
