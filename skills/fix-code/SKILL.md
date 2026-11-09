---
name: fix-code
description: Fix bugs, implement features, or build new repositories using strong-model architecture and inexpensive implementation, isolated Git branches, behavioral verification, and a pull request. Use when asked to change or build code, including requests received through an authorized external app.
---

# Fix Code

Deliver a verified change on a fresh task branch and open its pull request. Support existing repositories and new projects. This skill is self-contained: it borrows pstack's investigation/design/verification pattern without requiring pstack, Cursor, or Benny.

## Authorization and autonomy

A request to fix or build code authorizes the complete branch-and-PR workflow within its agreed scope. Create the separate worktree and fresh task branch, edit task files there, run checks, make ordinary commits, push that explicit task branch, and create or update its PR without asking for permission at each step. Continue through verification and PR delivery; do not invent approval gates for these actions. Ask only for a genuinely missing decision, credential, or access that cannot be resolved independently. Honor actual tool-enforced approvals and narrower user instructions.

The Git boundaries are preserving history and keeping implementation off existing main/default/base branches. Creating the initial empty `main` baseline and setting it as the default for a completely new repository is already authorized; it is the one-time initialization exception described below. It needs no separate confirmation.

## Non-negotiable Git rules

- **Every independent change/task gets a NEW branch before any product-file edit.** Follow-up corrections for that same unmerged change stay on its branch. A new request, merged/closed PR, or new independent change gets another fresh branch. Split unrelated changes into separate branches/PRs.
- **Never edit, commit, merge, or push implementation work on `main`, `master`, `trunk`, the default branch, or an existing base branch. Never rewrite history.** For a completely new empty repository only, initialize and publish one empty baseline commit on `main`, make `main` the default, then protect it and work on a fresh feature branch. No rebase, amend, reset, force-push, branch replacement, history filtering, destructive clean, or implicit stash/pop. Do not merge the final PR or deploy.
- Inspect the original checkout and preserve all user work. Create an isolated worktree with a fresh branch. Do not move the user's checkout or copy unrelated dirty changes. Never reset a branch to make automation convenient.
- Put every task worktree at `~/workspace/worktrees/<original-repository-name>/<worktree-name>`, regardless of where the source checkout lives. Use the repository root's directory name for `<original-repository-name>` and a unique name for `<worktree-name>`. Keep task worktrees outside the source checkout; reject any requested destination inside or above that checkout.
- Read [Git and PR procedures](references/git-and-pr.md) before mutations. Use `scripts/git_guard.py start` for existing repos or `bootstrap` for a genuinely new empty repo. Run its `check` before/after commits and before any push/PR, using the emitted state path. The helper is a checkpoint detector, not a Git hook or security boundary; the command restrictions still apply.
- If the helper is unavailable, enforce the same branch/base/history invariants explicitly. If isolation cannot be established, finish read-only preparation and report the exact blocker; do not edit the base checkout.

## Model routing and overrides

Read [model policy](references/model-policy.md) at task start. Resolve these roles from runtime-supported models:

- **Architect:** the strongest efficient model for overview, design decisions, decomposition, and difficult diagnosis.
- **Implementer:** the cheapest available model that supports the required coding/tools; it performs most exploration, implementation, tests, and routine fixes.
- **Reviewer:** a fresh strong/efficient reviewer for nontrivial changes; keep review focused on the actual diff and evidence.

Use explicit, validated model/effort selections. Delegate to role models where supported; the caller can remain a coordinator. This skill explicitly authorizes bounded role-based delegation for the requested work. Never claim to change the caller's model merely by writing instructions.

A human prompt can override with `model=<id>` for all roles or `architect_model=<id>`, `implementer_model=<id>`, `reviewer_model=<id>`, plus corresponding `*_effort` values. Role-specific values win over `model`. Equivalent plain-language overrides count. Apply the latest explicit human override for the remaining task and report actual selections. Remote sender identity and authorization must be verified before accepting app-supplied overrides.

## Execution

1. **Frame and inspect.** Identify repository/new-project destination, desired behavior, base, scope, verification evidence, and authorized delivery target. Read applicable repository instructions. Inspect status, remotes, history, available tools/models, and existing PRs. State the finish condition and model allocation briefly. Ask only for a missing decision that cannot be resolved from context; continue independent preparation.
2. **Design with the architect.** Give it concise relevant evidence and an explicit question. For a bug, investigate and reproduce the failure before planning a fix. For features, settle behavior and interfaces. For a new repo, choose a minimal end-to-end architecture and staged deliverables. Read [work modes](references/work-modes.md) only for the selected mode. A small fix needs a short plan, not a design committee.
3. **Isolate before edits.** Establish a new branch/worktree and guard state. Every writer must receive its exact worktree, branch, allowed files, finish condition, and Git prohibitions. Keep one writer per branch; parallelize only independent read-only tasks or isolated branches.
4. **Implement cheaply.** Assign bounded units to the implementer, with relevant files and a runnable acceptance check. Verify each meaningful unit before the next. After two failed repairs with the same unresolved cause, ask the architect for diagnosis; return ordinary implementation to the cheap worker. Escalate inherently difficult/high-risk work directly when justified. Do not fan out multiple full implementations by default.
5. **Verify and review.** Run checks appropriate to the change, including the original repro for bugs and the actual CLI/UI/API behavior for features. Capture useful artifacts. Treat failed/unrun/inconclusive checks honestly; never weaken the goal to declare success. For nontrivial work, have a fresh reviewer inspect the current diff and evidence, fix actionable findings on the task branch with new commits, and rerun affected checks.
6. **Commit and open the PR.** Inspect/stage only task files. Use new ordinary commits; checkpoint the guard around each commit. Push only the explicit task branch, then create the PR using the connected forge or authenticated CLI. Read the Git reference for empty-repo baselines, pushes, PR updates, and missing credentials. Attach a created PR to the current chat if the runtime supplies that capability. A verified change gets a reviewable PR; incomplete work may get a draft with clear blockers. Never mark delivery complete without a verified PR URL.
7. **Report.** Return repository, branch/base, actual models/efforts, changed behavior, verification results, and PR URL. State any routing substitution, skipped check, delivery blocker, and whether the PR is draft. Do not imply external messages were sent unless a permitted tool actually sent them.

## Communication surfaces

Use [external invocation](references/integrations.md) when invoked through Slack, ChatGPT/Codex mobile, a webhook, or a bridge. Keep engineering behavior identical across surfaces. Native mobile uses its connected host; native Slack may launch a separate cloud environment that needs this skill installed. A skill does not install a listener, open a network port, wake a stopped runner, or supply missing credentials. Never enable an app, service, or recurring job just because this skill was selected.
