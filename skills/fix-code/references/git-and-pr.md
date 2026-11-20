# Fresh branches, preserved history, PR delivery

## Existing repository

Inspect `git status --short`, current branch, remotes, and default-branch metadata. Fetch the chosen base when network/auth permit; fetch updates remote-tracking refs, not local main. Prefer the latest remote default ref such as `origin/main`. Never `pull`/checkout/rebase the user's main to update it. Do not assume origin, GitHub, or main when metadata says otherwise.

Use the bundled helper by its actual absolute path:

```text
python3 <skill>/scripts/git_guard.py start --repo <repo> --name <task-slug> --base <verified-base-ref>
```

Two forms, chosen by the workspace rule in SKILL.md. Both create a new `fix-code/<slug>-<unique-id>` branch, record protected local refs and base ancestry, store guard state under the Git common directory, and return JSON paths. Branch names are always new; no existing branch is reused. Pass `--protect <default-branch-name>` when a non-origin default is not otherwise discoverable or the selected base differs from that default. Never point the helper at existing user files.

Separate worktree (Advanced, or a bridge-prepared task):

```text
python3 <skill>/scripts/git_guard.py start --repo <repo> --name <task-slug> --base <verified-base-ref>
```

By default the worktree is `~/workspace/worktrees/<repository-directory-name>/fix-code-<slug>-<unique-id>`, even when the source checkout is elsewhere. Optional `--worktree <new-path>` selects a destination outside and separate from the original checkout; the helper rejects destinations inside or above the source checkout. The original checkout is not touched.

In place (Simple, or Medium before growth):

```text
python3 <skill>/scripts/git_guard.py start --repo <repo> --name <task-slug> --base <verified-base-ref> --in-place
```

Runs `git switch -c` in the existing main checkout. Preconditions: run from the main checkout root (not a linked worktree), tracked files clean, and no merge/rebase/cherry-pick/revert in progress. Otherwise it refuses; use the worktree form instead. Untracked files are left alone, but it also refuses when the switch to the base would overwrite or remove an untracked or ignored file (any file that differs between HEAD and the base, or a path under or above one). Move such files aside or use the worktree form. It records the original branch/head and the pre-existing untracked files in state.

Medium growth, relocating an in-place task to a worktree after committing:

```text
python3 <skill>/scripts/git_guard.py relocate --state <state-json> [--worktree <new-path>]
```

Requires tracked files clean (commit first). Moves the task branch to a separate worktree and returns the original checkout to its original branch/head. Same destination rules as `start`. It refuses if new untracked, non-ignored files appeared since the task started ("commit or remove new task files first"), if the switch back would overwrite or remove untracked or ignored files, or if the original branch no longer exists; nothing is switched in these cases.

After an in-place task's PR is created:

```text
python3 <skill>/scripts/git_guard.py restore --state <state-json>
```

Returns the checkout to its original branch/head and keeps the task branch. Same preconditions and refusals as `relocate`.

If the task later needs a worktree (for example, follow-up work after `restore`), run `relocate` on the restored state: it leaves the checkout alone, creates the worktree for the task branch, and updates the state. Then work in that worktree.

Use the emitted paths in all later calls:

```text
python3 <skill>/scripts/git_guard.py check --state <state-json>
```

`check` is used the same way for in-place and worktree tasks. It requires the exact task branch in the recorded workspace, protects existing default/base branch refs, and verifies the last checkpoint remains an ancestor of HEAD. It also rejects detached HEAD, merge/rebase/cherry-pick/revert operations in progress, changed origin routing, and linked task worktrees that disappeared. Run before and after commits and before publishing. Do not edit state to bypass a failure. The helper does not prohibit arbitrary Git commands; compliance with the skill's restrictions remains mandatory.

Task work needs uncommitted changes from the original checkout only when the human explicitly identifies them as input. Do not silently copy the dirty tree; agree on a scoped transfer or leave it in place and report the dependency.

If updates from the base are required later, merge the base into the task branch with a new merge commit only when necessary, inspect conflicts, and reverify. Never rebase. Do not merge the task branch into main. A new independent task gets a new branch even when another task is unfinished.

## New repositories start with main as the default

Creating a new repository is in scope only when the task requests it. Honor its requested owner/path/name and visibility; for an unspecified remote visibility, use private if available rather than public. Confirm identity when the account/owner cannot be inferred. A request to create a skill is not authorization to create a remote project.

If the host already provides an initialized default branch, treat it as an existing repository: protect that branch and branch from it normally. Do not replace its history or bypass existing protections.

For a genuinely empty local repository, use:

```text
python3 <skill>/scripts/git_guard.py bootstrap --repo <new-empty-directory> --name <task-slug>
```

This initializes a completely NEW repository with `main` as its default branch, creates one empty root commit using the user's configured Git identity, then creates a fresh implementation branch in a separate worktree from `main`. The empty baseline gives the first PR a common ancestor. This one-time initialization is authorized without an additional permission prompt. After that baseline exists, `main` is protected: all project files, implementation commits, fixes, and tests belong on the task branch.

When creating the authorized remote, publish the recorded empty `main` baseline first using the explicit refspec `refs/heads/main:refs/heads/main`, then publish the explicit task branch. Set the hosted repository's default branch to `main` and verify it before opening the first PR against `main`. Do not ask for additional permission to initialize the new repository, publish these branches, set the initial default, or open the PR. The baseline push is allowed only to initialize a genuinely empty remote; never advance or overwrite an existing remote `main`. Do not merge the PR or add implementation commits to `main`. If registering a remote would change recorded guard routing, publish to the verified explicit remote URL instead of modifying guard state.

After creating the authorized remote repository, create the `AI` and `fix-code` labels in it (same commands and colors as in the PR bullet below) before opening the first PR.

`bootstrap` refuses an existing Git repository or a nonempty destination. It may leave its newly initialized repository behind if Git identity/commit creation fails; inspect and recover it without deleting user files or inventing author identity.

## Commits and remote publication

- Before each commit, guard-check; inspect `git diff`, staged files, and `git diff --check`. Stage named task paths, not the entire user's checkout. Follow repository conventions and avoid secrets/generated bulk unrelated to the request.
- Use ordinary new commits. Never `commit --amend`, rebase, reset, force push (including `--force-with-lease`), or rewrite/squash existing commits. No branch deletion/replacement as a shortcut.
- After the commit, guard-check again. Reinspect the actual diff against the recorded base and the verification evidence.
- Confirm the forge/account/remote are the intended delivery target. Push an explicit refspec to the chosen remote for the task branch only, with `-u` so the local task branch tracks the PR branch: `git push -u <remote> HEAD:refs/heads/<task-branch>`. The upstream is for status only (ahead/behind, no-upstream checks); never pull through it, and keep naming the explicit refspec on every push. Never bare `git push`, `--all`, `--mirror`, or a wildcard. The one-time initial publication of `refs/heads/main` to a new empty remote is the single additional permitted ref and must match the helper's recorded empty baseline; it does not authorize later pushes to main.
- Check existing PRs for this exact branch before creating one. Authorized retries update/reuse that PR; they do not create duplicates. A merged or closed change requires a new branch for new work.
- Use the connected forge tool when sufficient. Otherwise use an authenticated provider CLI, such as `gh pr create` with explicit head/base and a temporary body file. Keep PR text out of shell interpolation. Worktree edits, ordinary commits, task-branch pushes, and PR creation/updates are already authorized by the fix-code task unless the user limits its scope; do not pause for additional permission for them. Ask for provider authentication only when actually missing; complete local implementation and verification first.
- Label every PR the skill creates with `AI` and `fix-code`. Before creating the PR, list the target repo's labels (`gh label list --repo <owner/repo> --json name --limit 1000`) and create only the missing ones with `gh label create <name> --repo <owner/repo> --color <hex> --description <text>` (`AI`: `5319e7`, "Created with AI assistance"; `fix-code`: `0e8a16`, "Created by the fix-code skill"). Never use `--force`; never edit or delete existing labels. Pass `--label AI --label fix-code` to `gh pr create`. When reusing an existing PR for the task branch, add any missing labels with `gh pr edit <pr> --repo <owner/repo> --add-label AI --add-label fix-code`. If labels cannot be created or applied (for example, missing permission), still create or keep the PR and report that it is unlabeled. With a non-GitHub forge, use its equivalent or report that labels were not applied.
- Open a normal PR when verified and appropriate, or draft when checks are incomplete or the user requests it. Describe problem, behavior, meaningful checks, and limitations. Attach the PR to the chat using the runtime's attachment tool when available.
- Re-check the created PR's URL/head/base. Never merge it, approve it on the user's behalf, deploy, or enable auto-merge. Report creation failures precisely and preserve the local branch/worktree; do not say the task is fully delivered without a PR.

## Failure handling

A protected-ref change or lost checkpoint may have been caused by another human/chat. Stop mutations, report observed old/new refs, and preserve evidence. Do not auto-reset or repair the other actor's history. If the base cannot be identified, request only that choice while continuing read-only investigation. Use provider-specific PR equivalents where appropriate; never silently publish to a different account/repository.
