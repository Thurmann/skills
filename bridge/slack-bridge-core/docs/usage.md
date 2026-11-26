# Using the bridge in Slack

This page is shared by all bridge variants ([personal](../../slack-fix-code-personal-bridge/README.md), [personal cloud](../../slack-fix-code-personal-cloud-bridge/README.md) and [company](../../slack-fix-code-company-bridge/README.md)). It covers the providers, the Slack commands, how a task runs and how the bridge recovers and replies. Variant-specific setup (Slack app, configuration, GitHub access, deployment) stays in each variant's README. Commands such as `node src/cli.js` are run from the variant's directory.

## Providers

| Runtime | Read-only phases | Implementer | Notes |
| --- | --- | --- | --- |
| `claude` | `--permission-mode plan`, tools limited to Read/Glob/Grep | `acceptEdits` with an explicit tool allowlist | Network policy is an instruction only. |
| `codex` | `--sandbox read-only` | `workspace-write` sandbox plus the Git common dir | Honors `allowNetwork` in the sandbox. |
| `gemini` | `--approval-mode plan` plus a policy file denying `write_file`, `replace` and `run_shell_command` | `--approval-mode auto_edit` plus a policy allowing those tools, and `--skip-trust` | No effort flag (`effort` is ignored). Web tools are denied by policy when `allowNetwork` is false, but the implementer's shell can still reach the network, so this only blocks Gemini's built-in web tools. Skill and evidence directories are added with `--include-directories`. The policy file is written into the task's private artifact directory, outside the worktree. |
| `opencode` | `OPENCODE_CONFIG_CONTENT` permission rules deny everything except read/glob/grep | Rules also allow edit, shell, subagent and skill | Runs `opencode run --standalone --format json`, so this run's environment and config apply only to it. No effort flag. Web tools are allowed only when `allowNetwork` is true, but the implementer's shell can still reach the network, so `allowNetwork: false` only blocks opencode's built-in web tools. |

Caveats:

- Gemini's `--skip-trust` is folder trust, not an approval bypass. Without it, an untrusted folder forces `default` approval mode and the headless implementer could not edit or commit. The task worktree's project `.gemini/` settings are therefore honored, the same exposure as Claude's project settings.
- opencode rejects every permission request that is not pre-allowed (the bridge never passes `--auto`). Project config and Claude Code compatibility files are disabled via environment variables. Its permissions allow `external_directory` because the skill files and evidence live outside the worktree. Provider API keys are user-chosen variables: list their names under `runtimes.opencode.env`.
- No runtime is ever launched with yolo, `--auto`, `--dangerously-skip-permissions` or other approval-bypass flags; tests assert this.
- As defense in depth, the bridge itself checks `HEAD` and `git status` around every non-implementer phase and fails the job, preserving the worktree, if a read-only phase changed anything, whatever the provider. The snapshot includes a content digest of untracked, non-ignored files; ignored files are out of scope.

Configuration, with the `runtimes` layout:

```json
"runtimePriority": ["claude", "codex", "gemini", "opencode"],
"runtimes": {
  "gemini": { "path": "gemini", "models": { "architect": "gemini-2.5-pro", "implementer": "gemini-2.5-flash", "reviewer": "gemini-2.5-pro" }, "allowedModels": ["gemini-2.5-pro", "gemini-2.5-flash"], "env": ["GEMINI_API_KEY"] }
}
```

`env` lists extra environment variable names forwarded to that provider (uppercase names, never `SLACK_*`). Built-in provider variables (such as `OPENAI_API_KEY` or `GEMINI_API_KEY`) are always forwarded to their own provider only. The legacy layout (`codexPath`, `claudePath`, `models.<name>`, `allowedModels.<name>`) keeps working; `runtimes.<name>` overrides it. A provider counts as configured when it has models.

Default runtime precedence: `start --runtime <name>` (or `doctor --runtime`), then an explicit `"runtime"` in `config.json`, then the first configured provider in `runtimePriority` whose CLI answers `--version`. An explicit choice whose CLI is unavailable is an error; there is no silent fallback. Configured providers missing from `runtimePriority` are appended in registry order.

**Behavior change:** with both Claude and Codex configured and no explicit `runtime`, the default is now `claude` (it was `codex`). Set `"runtime": "codex"` to keep the old behavior. Tasks keep the runtime they started with.


## Slack commands

Start each independent task with a **new top-level mention**. `--`, `—` and `–` are also accepted, because Slack and phone keyboards often autocorrect `--` into a dash.

In the default channel mode, no repository option is needed:

```text
@Fix Code Fix the duplicate retry bug. Reproduce it first and verify the fix.
```

For example, a mention in `#billing-service` resolves the exact case-insensitive repository name `billing-service`. `repo=<alias>` is rejected in channel mode; it remains available only with `repositoryRouting.mode: "aliases"`. Neither mode accepts an arbitrary repository path from Slack or automatically creates a GitHub repository. An unknown or empty remote is a blocking error. New features and fixes in the selected repository use the same command.

Older configurations that remain in aliases mode continue to use commands such as `@Fix Code repo=app | Add CSV export.`

A plain mention with no options also works. At top level it starts a task with default models and the automatic precheck; in a task's thread it is a followup on that task:

```text
@Fix Code can you fix this small error: blabla
```

Plain mentions carry no options, so `key=value` text stays part of the request. To set options, put them before the separator (`|`); no keyword is needed. Options are read only when the first word looks like `key=value` and a separator follows; otherwise the whole message, such as `the linter reports key=value warnings`, is a plain request. For example, `@Fix Code mode=simple | Fix the typo.` starts a task at top level, or queues a followup in a task's thread. Bare `status`, `cancel`, `retry` and `help` remain commands. In alias mode, start with `repo=<alias> | <request>`.

`run` and `followup` remain accepted as optional aliases: `@Fix Code run mode=simple | Fix the typo.` behaves the same as the form above, and `run` or `followup` may be used with or without options. In a task's thread, options before `|` apply to that task's followup. `repo=` and `runtime=` are accepted only on a new top-level task; in a thread they are rejected (`followup does not accept repo` or `followup does not accept runtime`).

Override models **before** the separator (`|`):

```text
@Fix Code architect_model=gpt-6.1-sol implementer_model=gpt-6-luna | Add pagination.
```

`model=<id>` overrides every role; a role-specific option takes precedence. `precheck_model=<id>` overrides only the precheck role. Models must be in the configured runtime allowlist.

Complexity modes are selected before the separator too:

```text
@Fix Code mode=advanced | Refactor the auth module.
@Fix Code mode=fast | Change the retry limit from 3 to 5.
```

- Without `mode=`, a read-only precheck classifies the task as `simple`, `medium`, or `advanced`. Unreadable precheck output falls back to `medium` with mandatory review. Missing confidence counts as `medium`. `risk_flags` hold only security, auth, data/migration, and concurrency; other context (public API, build/deploy) goes to `notes` and never affects the mode. Any risk flag forbids `simple`, two distinct risk categories make `advanced`, and low confidence together with a risk flag bumps one mode. Otherwise the model's mode is kept.
- `mode=fast|simple|medium|advanced` skips the precheck and sets the mode directly. It can lower the mode the precheck would choose. An explicit `simple` can still escalate to `medium` (more than 6 logic files changed or `SCOPE_EXCEEDED`), and an explicit `medium` always runs independent review because there is no file prediction. Escalation and prediction checks count only the current job's commits. `retry` keeps the previous explicit `mode=`.
- Followups without `mode=` never drop below the task's previous mode.
- `fast` (explicit only; the precheck never selects it): implementer only, starting at once, for changes of at most 5 changed logic lines across at most 4 logic files (a modified line counts once). It runs no tests and verifies by compiling/building only; the PR's CI runs the tests, and the outcome line says so. Independent review runs only at 50% over that budget (8 or more logic lines, or 6 or more logic files). It never escalates.
- `simple`: implementer only, with no architect and no independent reviewer; escalates to `medium` as above.
- `medium`: no architect; independent review only when the bridge's review rules (below) require it.
- `advanced`: architect → implementer → mandatory independent review with bounded repair rounds.

The mode definitions, classification rules and review rules live in [`skills/fix-code/references/modes.md`](../../../skills/fix-code/references/modes.md), the single source of truth; the bridge implements them in code and the details above describe only what the bridge itself enforces. Change `modes.md` first and keep the bridge in line with it.

The implementer must end its output with exactly one line, `VERIFICATION: complete` (every check, including the complete test suite, ran and passed) or `VERIFICATION: incomplete: <reason>`. When that line says complete (and any required independent review passed), the bridge publishes a PR ready for review; if the line says incomplete or is missing, it publishes a draft PR and states the reason in the PR body and outcome line. Followups on an existing PR post the new job's outcome as a PR comment and move the PR between draft and ready to match (`gh pr ready`, with `--undo` to return it to draft). The final Slack message and the PR body state the mode, whether independent review ran, and the draft/ready decision. **Trade-off:** `fast` jobs under the review threshold, `simple` jobs, and `medium` jobs whose changes stay within the prediction, publish **without** independent review (a ready PR if verification is complete). Use `mode=advanced` when you want the full pipeline for a change. Logic files are changed files excluding tests, docs (`.md`/`.rst`/`.txt`, `docs/`) and lockfiles; predictions use the same definition. Each job records a calibration record (`calibration.json` in its artifact directory and on the job: the model's raw mode, mode after adjustment, final mode, predicted vs. changed/logic file counts, escalation, review) and the outcome line states predicted/actual logic files. Skill reading is per phase: precheck reads only the "Precheck" section of `modes.md`; architect, implementer and reviewer read only the references they need and never `model-policy.md` or `integrations.md`. Text after the separator is request data and cannot set runner flags or model options. Model selection uses explicit phase-level CLI invocations, rather than relying on nested model delegation.

In that task's thread:

```text
@Fix Code Also cover an empty result set.
@Fix Code implementer_model=gpt-6.1-sol | Diagnose the unresolved race.
@Fix Code followup | Also cover an empty result set.
@Fix Code status
@Fix Code cancel
@Fix Code retry
@Fix Code fix
```

- `followup` queues a correction to the same change, branch, and task. The selected runtime/repository cannot change mid-thread; channel repository identity is pinned during its first repository lookup, before cloning.
- `retry` explicitly requeues the last failed, interrupted, or canceled request after you inspect preserved work. It does not roll back effects.
- `fix` is offered when independent review still requests changes (or blocks publication) after the bounded repair rounds. The failure message lists the reviewer's summary and numbered findings. `fix` requeues the same request on the same branch with those findings passed to the implementer, in at least `medium` mode without a precheck, so a fresh independent review always runs before publication.
- `cancel` stops the active process group and cancels queued follow-ups for that task. Existing commits/pushes are preserved.
- `status` reports the saved task state; it is not a fresh forge/CI audit.
- `help` returns command guidance.
- `runtime=<claude|codex|gemini|opencode>` can be supplied on a new top-level task when that provider is configured and its CLI is available on the host; otherwise the bridge replies that it is unavailable. The adapters are fixture-tested; verify each real CLI in a test channel before relying on it.

Every PR the bridge creates or reuses gets the `AI`, `fix-code` and `slack-bridge` labels (`slack-bridge` marks PRs created through the bridge; created in the repository only if missing); if they cannot be applied, the PR is still created and its body says so.

A merged/closed PR needs a new top-level task and a new branch. A PR that is already ready for review is reused: the bridge returns it to draft if the new job's verification is incomplete, and keeps (or promotes a draft to) ready when it is complete.


## Execution and Git behavior

One global worker runs at a time. Independent Slack tasks are queued, preventing simultaneous writers even across repositories. Each accepted task gets a unique isolated worktree using `../../../skills/fix-code/scripts/git_guard.py`.

The original checkout, its dirty files, and protected branches remain outside the coding worktree. The guard checks the task branch, protected refs, base ancestry, remote routing, and history checkpoints. It detects violations; it is not a Git hook or a complete shell-security boundary. Do not authorize untrusted people to operate this local coding account.

Each attempt uses fresh precheck/architecture/implementation/review phase sessions as its mode requires, with persisted task context, plan, result, and artifacts. It does **not** attach to or resume an arbitrary desktop/mobile chat. Session IDs are saved for audit in `<stateDir>/artifacts/<task>/<job>/runner-*.json`. When a task fails or is interrupted, the Slack message lists that folder, each phase's session ID, and (for Claude and Codex) a command to open the last session locally from the task worktree, for example `cd <worktree> && claude --resume <session-id> --fork-session`. `--fork-session` leaves the bridge's transcript untouched. Claude transcripts are stored under `~/.claude/projects/<encoded worktree path>/<session-id>.jsonl`. The bridge explicitly tells the skill to use the worktree it already prepared rather than creating a second one. The bridge always prepares a separate worktree in every mode, because it runs unattended and may reuse local checkouts; the skill's in-place option is not used by the bridge.

Implementation must leave ordinary commits and a clean worktree. In `advanced` mode, and in `medium` or escalated `simple` cases that meet the review rules above, the independent reviewer reads the real patch and checks evidence. Other `simple` and in-prediction `medium` jobs skip it, and the bridge's own verification is the only check before the PR. Requests for changes get at most the configured repair rounds. Blocked, malformed, or contradictory review verdicts prevent publication.

Only the bridge publisher pushes the explicit task branch and creates/reuses a PR (ready for review when verified, otherwise draft) for that exact head/base. It checks the GitHub remote and existing PR state first. No merges, force pushes, rebases, amends, resets, or deployments are part of the workflow. Model calls remain responsible for following the skill's restrictions inside their available permissions.


## Recovery and reply delivery

The SQLite queue records event IDs and jobs transactionally before acknowledging Slack. Duplicate deliveries do not create duplicate jobs. Bot messages, other workspaces, shared-external channels, and unauthorized users/channels are ignored.

A restart marks in-flight attempts interrupted rather than automatically running them again. If the recorded runner still appears alive, startup stops for local inspection. A crash after worktree creation is reconciled against the Git guard checkpoint; unknown existing directories are not overwritten.

Each run posts a queued reply as soon as the request is accepted (task ID, provider, and the repository and requested mode when already known), an acknowledgement once the precheck has finished that adds only what was learned since (the repository in channel mode, the precheck's mode and its time estimate), a status update every 5 minutes (current phase, elapsed time, estimate) while the task runs, and a final result with the PR link, branch, mode, review outcome and the precheck's reason (the implementer's full summary is in the PR body). A run that fails before the precheck completes posts the failure without an acknowledgement. Set `statusIntervalMs` in `config.json` to change the status interval. A run that ends with no commits and a clean worktree (a question, or nothing to change) succeeds with the implementer's answer and publishes no PR.

Bridge-written replies use short Slack mrkdwn lines sized for narrow threads: a status icon (pending while queued or running, a green check on success, a red cross on failure), values such as branches in code, the pull request as a clickable `PR #<number>` link, and resume commands in a code block. Every interpolated value is escaped, and model or error output (precheck reasons, implementer answers, review findings, errors) is posted in separate plain-text blocks, so it is never rendered as mrkdwn. The message `text` stays a plain-text notification fallback.

Slack replies use a persistent outbox and original thread coordinates. Rate limits get bounded retries. A connection failure after a possible send is marked **uncertain** rather than blindly resent; exactly-once external delivery is not claimed.

Inspect local state:

```bash
node src/cli.js status
node src/cli.js outbox
```

For an uncertain reply, inspect Slack first. With the bridge stopped, explicitly retry only when it was not delivered:

```bash
node src/cli.js outbox retry OUTBOX_ID --confirmed-not-delivered
```

Ctrl+C sends a graceful shutdown/cancel request. Do not delete worktrees or state to resolve a failure. If publication had started, inspect the actual branch and PR before retrying. Existing PR lookup prevents normal retry duplication, but remote effects cannot be atomically committed with SQLite.


## Optional settings

These `config.json` keys are optional. Defaults are the ones `slack-bridge-core/src/config.js` applies when the key is absent.

| Key | Default | Meaning |
| --- | --- | --- |
| `pythonPath` | `python3` | Python executable used to run the skill's `git_guard.py`. An empty value also falls back to `python3`. |
| `maxRepairRounds` | `2` | Repair rounds allowed after an independent review requests changes. Integer from 0 to 3. |
| `timeoutMs` | `1800000` (30 minutes) | Time limit in milliseconds for each coding CLI run; the run is terminated with a timeout error when it is exceeded. Integer from 1000 to 86400000. |
| `statusIntervalMs` | `300000` (5 minutes) | How often a running task posts a status update. Integer from 60000 to 86400000. |
| `operators` | `[]` | Users who may control other users' tasks; every entry must also be in `allowedUsers`. Otherwise only the task owner can follow up or cancel. |
| `forwardGitHubAuth` | unset (not forwarded) | When `true`, the runner also passes `GH_TOKEN`, `GITHUB_TOKEN` and `SSH_AUTH_SOCK` from the bridge's environment to the coding CLI. Rejected together with `githubTokenFile`. Without it, only `SSH_AUTH_SOCK` is passed, if set. |
