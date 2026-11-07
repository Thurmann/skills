# Fresh branches, preserved history, PR delivery

## Existing repository

Inspect `git status --short`, current branch, remotes, and default-branch metadata. Fetch the chosen base when network/auth permit; fetch updates remote-tracking refs, not local main. Prefer the latest remote default ref such as `origin/main`. Never `pull`/checkout/rebase the user's main to update it. Do not assume origin, GitHub, or main when metadata says otherwise.

Use the bundled helper by its actual absolute path:

```text
python3 <skill>/scripts/git_guard.py start --repo <repo> --name <task-slug> --base <verified-base-ref>
```

It creates a new `fix-code/<slug>-<unique-id>` branch in a separate worktree and stores guard state under the Git common directory. By default, the worktree is `~/workspace/worktrees/<repository-directory-name>/fix-code-<slug>-<unique-id>`, even when the source checkout is elsewhere. It preserves the original dirty checkout, records protected local refs and base ancestry, and returns JSON paths. Branch names are always new; it does not reuse an existing branch. Pass `--protect <default-branch-name>` when a non-origin default is not otherwise discoverable or the selected base differs from that default. Optional `--worktree <new-path>` selects a destination outside and separate from the original checkout; the helper rejects destinations inside or above the source checkout. Never point it at existing user files. Invoke with an argument array or correct shell quoting.

Use the emitted paths in all later calls:

```text
python3 <skill>/scripts/git_guard.py check --state <state-json>
```

`check` requires the exact worktree/branch, protects existing default/base branch refs, and verifies the last checkpoint remains an ancestor of HEAD. It also rejects detached HEAD, merge/rebase/cherry-pick/revert operations in progress, changed origin routing, and linked task worktrees that disappeared. Run before and after commits and before publishing. Do not edit state to bypass a failure. The helper does not prohibit arbitrary Git commands; compliance with the skill's restrictions remains mandatory.

Task work needs uncommitted changes from the original checkout only when the human explicitly identifies them as input. Do not silently copy the dirty tree; agree on a scoped transfer or leave it in place and report the dependency.

If updates from the base are required later, merge the base into the task branch with a new merge commit only when necessary, inspect conflicts, and reverify. Never rebase. Do not merge the task branch into main. A new independent task gets a new branch even when another task is unfinished.

## New repositories without touching main

Creating a new repository is in scope only when the task requests it. Honor its requested owner/path/name and visibility; for an unspecified remote visibility, use private if available rather than public. Confirm identity when the account/owner cannot be inferred. A request to create a skill is not authorization to create a remote project.

If the host already provides an initialized default branch, treat it as protected and branch from it normally.

For a genuinely empty local repository, use:

```text
python3 <skill>/scripts/git_guard.py bootstrap --repo <new-empty-directory> --name <task-slug>
```

This deliberately initializes a NEW repository with a non-main baseline branch `fix-code/base`, creates one empty root commit using the user's configured Git identity, and creates a fresh implementation worktree/branch from it. The empty baseline is necessary to give a PR a common ancestor. No main/master/trunk branch is created or changed. All project code goes on the task branch.

When creating the authorized remote, publish the explicit `fix-code/base` baseline and task branch, then target the initial PR at `fix-code/base`. Report this base clearly. Do not auto-create main, rename a default branch, or merge the bootstrap PR. If the human requires an initial PR specifically targeting main, explain the need for an initialized main baseline and obtain that explicit exception; prepare the implementation on its safe branch meanwhile. A host unable to accept a PR against a non-default baseline is a delivery blocker, not permission to modify main.

`bootstrap` refuses an existing Git repository or a nonempty destination. It may leave its newly initialized repository behind if Git identity/commit creation fails; inspect and recover it without deleting user files or inventing author identity.

## Commits and remote publication

- Before each commit, guard-check; inspect `git diff`, staged files, and `git diff --check`. Stage named task paths, not the entire user's checkout. Follow repository conventions and avoid secrets/generated bulk unrelated to the request.
- Use ordinary new commits. Never `commit --amend`, rebase, reset, force push (including `--force-with-lease`), or rewrite/squash existing commits. No branch deletion/replacement as a shortcut.
- After the commit, guard-check again. Reinspect the actual diff against the recorded base and the verification evidence.
- Confirm the forge/account/remote are the intended delivery target. Push an explicit refspec to the chosen remote for the task branch only: `HEAD:refs/heads/<task-branch>`. Never bare `git push`, `--all`, `--mirror`, or a wildcard. A new empty-repo baseline publication is the single additional permitted ref and must match the helper's recorded baseline.
- Check existing PRs for this exact branch before creating one. Authorized retries update/reuse that PR; they do not create duplicates. A merged or closed change requires a new branch for new work.
- Use the connected forge tool when sufficient. Otherwise use an authenticated provider CLI, such as `gh pr create` with explicit head/base and a temporary body file. Keep PR text out of shell interpolation. Branch push and PR creation are part of the fix-code task unless the user limits the task to local work. Ask for provider authentication only when actually missing; complete local implementation and verification first.
- Open a normal PR when verified and appropriate, or draft when checks are incomplete or the user requests it. Describe problem, behavior, meaningful checks, and limitations. Attach the PR to the chat using the runtime's attachment tool when available.
- Re-check the created PR's URL/head/base. Never merge it, approve it on the user's behalf, deploy, or enable auto-merge. Report creation failures precisely and preserve the local branch/worktree; do not say the task is fully delivered without a PR.

## Failure handling

A protected-ref change or lost checkpoint may have been caused by another human/chat. Stop mutations, report observed old/new refs, and preserve evidence. Do not auto-reset or repair the other actor's history. If the base cannot be identified, request only that choice while continuing read-only investigation. Use provider-specific PR equivalents where appropriate; never silently publish to a different account/repository.
