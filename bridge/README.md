# Fix Code Slack Bridge

Send a task from Slack on your phone, let a local coding runner use `fix-code`, and receive a pull request in the same Slack thread (ready for review when verification is complete, otherwise a draft).

This bridge uses Slack Socket Mode, a durable SQLite queue, and a local coding CLI: Claude Code, Codex, Gemini CLI, or opencode (see [Providers](#providers)). It creates an isolated branch/worktree before coding and orchestrates a read-only precheck that classifies each task as simple, medium, or advanced → implementation → independent review only where the mode requires it (advanced always adds architecture first) → controlled branch push → PR (ready for review only when verified, otherwise draft).

**Status:** implementation and local fixture tests are complete. Live Slack delivery, model execution, and GitHub publication require your configuration and have not been exercised by the offline test suite. No background service is enabled automatically.

## Requirements

- macOS or Linux, Node.js **22.13+** (Node 24 LTS recommended), Python 3, and Git.
- At least one supported coding CLI installed and authenticated: Claude Code, Codex (`codex login status`), Gemini CLI, or opencode.
- GitHub CLI authenticated (`gh auth status`) with access to the repositories you want the bridge to use. Channel routing requires push permission for the selected repository.
- A Slack workspace where the app can read public/private channel metadata, plus your allowed user/channel/workspace IDs.

The bridge reads the `fix-code` skill from this repository (`../skills/fix-code`, the same source that `scripts/install-skills.py` installs), so it never runs a stale private copy and does not depend on a user-global installation. Point `skillPath` at another reviewed installation if desired.

## 1. Install dependencies and initialize private configuration

In this project directory:

```bash
npm ci
node src/cli.js init
```

`init` creates `config.json` and `.env` in `~/.config/fix-code-bridge/` (or `$XDG_CONFIG_HOME/fix-code-bridge/`) with private permissions and preserves existing files. They live outside the repository, so updates and worktrees never touch them. Edit them locally; never paste tokens into a chat or commit them. `init --config /some/dir/config.json` creates them in another directory instead.

Every command finds its configuration in this order: `--config <path>`, `FIX_CODE_CONFIG`, `./config.json` in the current directory (older setups), then `~/.config/fix-code-bridge/config.json`. The `.env` next to the chosen `config.json` is loaded automatically; variables already set in the environment win. Relative paths in `config.json`, such as `stateDir: "./state"`, resolve against the config file's directory, so state also lives in `~/.config/fix-code-bridge/state` by default. Without `skillPath`, the bridge uses the repository's `skills/fix-code` next to the code it runs from; set it (absolute, or relative to the config file) only to use another reviewed installation.

## 2. Create the Slack app

1. Open [Slack app management](https://api.slack.com/apps) and create an app **from a manifest** in your workspace.
2. Paste/import `slack-app-manifest.json` from this project.
3. Check that Socket Mode is enabled. Under **Basic Information → App-Level Tokens**, generate an app token with `connections:write`.
4. Install the app into the workspace and copy its Bot User OAuth Token from **OAuth & Permissions**.
5. Put the app token (`xapp-...`) and bot token (`xoxb-...`) into `~/.config/fix-code-bridge/.env` locally:

   ```dotenv
   SLACK_BOT_TOKEN=your-local-bot-token
   SLACK_APP_TOKEN=your-local-app-token
   ```

6. Invite the bot to a dedicated test channel. Select the actual bot when mentioning it, rather than typing an unlinked display name.

The manifest requests `app_mentions:read`, `chat:write`, `channels:read`, and `groups:read`, and subscribes only to `app_mention`. If the app already exists, reinstall/reapprove it after updating the manifest so Slack grants the new scopes. Users must be explicitly allowlisted. By default, channels are explicitly allowlisted too; see the optional wildcard setting below to accept mentions in any valid channel in the configured workspace. The bridge does not monitor every channel message, download attachments, or fetch unrelated thread history. Include relevant reproduction text in your mention; every follow-up must mention the bot again.

Socket Mode uses an outbound connection and needs no public HTTP endpoint. See [Slack's Socket Mode documentation](https://docs.slack.dev/apis/events-api/using-socket-mode/).

## 3. Fill `config.json`

Replace every placeholder in the generated configuration:

- `teamId`: your Slack workspace ID.
- `allowedUsers`: explicit human member IDs allowed to start work.
- `allowedChannels`: explicit channel IDs where commands are accepted. To accept app mentions in all valid channels in this workspace, set this to `"*"` as the sole array entry:

  ```json
  "allowedChannels": ["*"]
  ```

  This is opt-in; the generated example keeps an explicit channel ID. Even with the wildcard, only invited channels can deliver mentions to the app, the workspace and allowed-user checks still apply, and shared Slack Connect channels remain rejected.
- `operators` (optional): allowed users who may control other users' tasks. Otherwise only the task owner can follow up or cancel.
- `repositoryRouting`: normally `mode: "channel"`; the repository is selected from the Slack channel name and discovered through the authenticated `gh` account. `cloneRoot` is where managed clones are kept. Optional `localRoot` points to an existing directory (for example `~/workspace`) whose direct child directories may be reused as working repositories.
- `repositoryRouting.allowedOwners` (optional): GitHub owners the channel resolver may select. An empty list allows any matching repository the `gh` account can access.
- `repositoryRouting.channelOwners` (optional): channel ID to owner hints, for example `{"C123": "example-org"}`, to disambiguate same-named repositories.
- `repositories`: used only in explicit `aliases` mode for older configurations.
- `runtimes`: one entry per provider you use, see [Providers](#providers). The older top-level `models`/`allowedModels`/`codexPath`/`claudePath` keys still work.
- `models`: precheck/architecture/implementation/review defaults for the selected runtime. `precheck` is optional and defaults to the implementer model; every value must be in `allowedModels`.
- `allowedModels`: explicit override allowlists, validated against the models you can actually run.
- `statusIntervalMs` (optional): how often a running task posts a status update in its thread. Default `300000` (5 minutes).

The generated example uses channel routing and does not need a `repositories` alias map. The default clone root is `<stateDir>/repositories`. A channel name such as `billing-service` selects only a repository whose GitHub repository name matches `billing-service`, ignoring case. The bridge gets the channel's authoritative name and ID from Slack `conversations.info` and searches all accessible GitHub repositories using paginated `gh` results, including repositories owned by you, shared with you, or visible through an organization. It requires push permission before starting work.

If multiple accessible repositories have the same name, use `allowedOwners` to narrow the candidate set or set a `channelOwners` hint for that channel. A hint must also be allowed when `allowedOwners` is nonempty. The bridge never picks a default owner and never guesses by converting dots, hyphens, or other punctuation. Missing, ambiguous, read-only, archived, or changed repository identity blocks the task before coding. An empty or unknown remote does not cause a repository to be created automatically.

When `repositoryRouting.localRoot` is set, a validated direct child named exactly for the GitHub repository is reused if it is an ordinary Git checkout with matching origin fetch and push URLs. A missing child falls back to the managed clone flow. An existing but invalid child blocks routing; it is never silently bypassed. Tasks record whether they use local or managed storage, so retries remain pinned to the same path and block if that path or its configuration changes. Local checkouts are fetched for their bound base branch, while task edits happen in a separate guarded worktree. Without `localRoot`, the existing managed behavior is unchanged.

Managed clones are stored under `repositoryRouting.cloneRoot`, keyed by GitHub's numeric repository ID. No repository path or owner can be supplied in Slack. Each new task records the repository ID, full name, and default branch from the initial lookup before cloning. Retries and follow-ups stay pinned to that identity if the Slack channel is renamed; a new task resolves the channel's current name again.

For an older configuration with a nonempty `repositories` map and no `repositoryRouting`, the bridge infers `mode: "aliases"` and preserves the existing alias behavior. Configurations without an alias map infer channel mode. Migration is explicit: stop the old service, back up and retain its state, then update configuration and review the managed clone root before restarting. Existing alias-bound tasks are not automatically converted to channel context; preserve the old configuration/state for those tasks and complete or explicitly retire them before migrating.

In aliases mode, an entry maps an alias to an exact local Git root, base refs, target base branch, push remote, and GitHub `owner/repository`:

```json
{
  "app": {
    "path": "/absolute/path/to/app",
    "base": "origin/main",
    "baseBranch": "main",
    "remote": "origin",
    "github": "your-account/app"
  }
}
```

`base` and `baseBranch` must describe the same base. The bridge verifies the repository's push URL against the configured GitHub owner/repo. GitHub.com repositories are supported; GitLab/enterprise-hosted forges require another publisher adapter.

The example selects GPT-6.1 Sol for architecture/review, and GPT-6 Luna for precheck and implementation. Those are candidates, not a guarantee of your account's access. Update the defaults and the allowlist to your supported models. Claude candidates are `opus` for architecture/review and `haiku` for precheck and implementation, also subject to your installed CLI/account. A rejected model stops the run; it is never silently replaced with a more expensive model.

`allowNetwork: true` permits configured Codex workspace networking and bridge fetch/push/PR operations. With it false, the bridge cannot finish PR delivery. Claude's network policy is an instruction here, not an enforced network sandbox. No runtime is launched with approval/sandbox bypass flags. CLI actions requiring an unavailable interactive approval fail and preserve the task.

Keep `stateDir` private and outside the configured source repositories. It contains the task database, private evidence, and runner session IDs. Task worktrees are stored separately under `~/workspace/worktrees/<repository-directory-name>/<worktree-name>`. Do not delete state while tasks exist. Use a dedicated coding account/container if you need stronger separation: removing Slack tokens from child environments does not prevent processes under the same OS user from reading accessible files.

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

## 4. Run diagnostics, then connect

```bash
npm run doctor
npm start
node src/cli.js start --runtime gemini   # optional: override the default runtime for this run
```

`doctor` checks local tools/authentication and reports which default runtime would be selected. Only **one** configured provider needs to be usable (its CLI answers `--version`, plus `login status` for Codex); missing ones are reported as `unavailable` and do not fail the check. With `doctor --runtime <name>`, that provider must be usable. If an explicit `"runtime"` in `config.json` is not usable, doctor shows a warning, because `start` would then need `--runtime`. It also checks the skill/helper, repository routing, and presence of token-shaped values. It makes no model calls and sends no Slack messages. Actual token validity/workspace binding is checked at connection time. Actual model availability is checked when a phase is invoked.

Leave the terminal open and keep the host awake/online. To keep a plugged-in Mac available for a supervised session, you can run the start command under `caffeinate`:

```bash
caffeinate -i npm start
```

No login agent, cron job, or system service is installed. First test in a dedicated channel with a harmless known bug.

## Slack commands

Start each independent task with a **new top-level mention**. `--`, `—` and `–` are also accepted, because Slack and phone keyboards often autocorrect `--` into a dash.

In the default channel mode, no repository option is needed:

```text
@Fix Code run | Fix the duplicate retry bug. Reproduce it first and verify the fix.
```

For example, a mention in `#billing-service` resolves the exact case-insensitive repository name `billing-service`. `repo=<alias>` is rejected in channel mode; it remains available only with `repositoryRouting.mode: "aliases"`. Neither mode accepts an arbitrary repository path from Slack or automatically creates a GitHub repository. An unknown or empty remote is a blocking error. New features and fixes in the selected repository use the same command.

Older configurations that remain in aliases mode continue to use commands such as `@Fix Code run repo=app | Add CSV export.`

A plain mention without `run` also works. At top level it starts a task with default models and the automatic precheck; in a task's thread it is a followup on that task:

```text
@Fix Code can you fix this small error: blabla
```

Plain mentions carry no options, so `key=value` text stays part of the request. Use the `run … |` or `followup … |` form to set options, for example `@Fix Code run mode=simple | Fix the typo.` Text after `run`/`followup` is read as options only when its first word looks like `key=value` (or it starts with the separator); otherwise the whole message, such as `run the linter and fix warnings`, is a plain request. Bare `status`, `cancel`, `retry` and `help` remain commands. In alias mode, start with `run repo=<alias> | <request>`.

Override models **before** the separator (`|`):

```text
@Fix Code run architect_model=gpt-6.1-sol implementer_model=gpt-6-luna | Add pagination.
```

`model=<id>` overrides every role; a role-specific option takes precedence. `precheck_model=<id>` overrides only the precheck role. Models must be in the configured runtime allowlist.

Complexity modes are selected before the separator too:

```text
@Fix Code run mode=advanced | Refactor the auth module.
```

- Without `mode=`, a read-only precheck classifies the task as `simple`, `medium`, or `advanced`. Unreadable precheck output falls back to `medium` with mandatory review. Missing confidence counts as `medium`. `risk_flags` hold only security, auth, data/migration, and concurrency; other context (public API, build/deploy) goes to `notes` and never affects the mode. Any risk flag forbids `simple`, two distinct risk categories make `advanced`, and low confidence together with a risk flag bumps one mode. Otherwise the model's mode is kept.
- `mode=simple|medium|advanced` skips the precheck and sets the mode directly. It can lower the mode the precheck would choose. An explicit `simple` can still escalate to `medium` (more than 3 logic files changed or `SCOPE_EXCEEDED`), and an explicit `medium` always runs independent review because there is no file prediction. Escalation and prediction checks count only the current job's commits. `retry` keeps the previous explicit `mode=`.
- Followups without `mode=` never drop below the task's previous mode.
- `simple`: implementer only, with no architect and no independent reviewer; escalates to `medium` as above.
- `medium`: no architect; independent review only when the bridge's review rules (below) require it.
- `advanced`: architect → implementer → mandatory independent review with bounded repair rounds.

The mode definitions, classification rules and review rules live in [`skills/fix-code/references/modes.md`](../skills/fix-code/references/modes.md), the single source of truth; the bridge implements them in code and the details above describe only what the bridge itself enforces. Change `modes.md` first and keep the bridge in line with it.

The implementer must end its output with exactly one line, `VERIFICATION: complete` (every check, including the complete test suite, ran and passed) or `VERIFICATION: incomplete: <reason>`. When that line says complete (and any required independent review passed), the bridge publishes a PR ready for review; if the line says incomplete or is missing, it publishes a draft PR and states the reason in the PR body and outcome line. Followups on an existing PR post the new job's outcome as a PR comment and move the PR between draft and ready to match (`gh pr ready`, with `--undo` to return it to draft). The final Slack message and the PR body state the mode, whether independent review ran, and the draft/ready decision. **Trade-off:** `simple` jobs, and `medium` jobs whose changes stay within the prediction, publish **without** independent review (a ready PR if verification is complete). Use `mode=advanced` when you want the full pipeline for a change. Logic files are changed files excluding tests, docs (`.md`/`.rst`/`.txt`, `docs/`) and lockfiles; predictions use the same definition. Each job records a calibration record (`calibration.json` in its artifact directory and on the job: the model's raw mode, mode after adjustment, final mode, predicted vs. changed/logic file counts, escalation, review) and the outcome line states predicted/actual logic files. Skill reading is per phase: precheck reads only the "Precheck" section of `modes.md`; architect, implementer and reviewer read only the references they need and never `model-policy.md` or `integrations.md`. Text after the separator is request data and cannot set runner flags or model options. Model selection uses explicit phase-level CLI invocations, rather than relying on nested model delegation.

In that task's thread:

```text
@Fix Code followup | Also cover an empty result set.
@Fix Code followup implementer_model=gpt-6.1-sol | Diagnose the unresolved race.
@Fix Code status
@Fix Code cancel
@Fix Code retry
```

- `followup` queues a correction to the same change, branch, and task. The selected runtime/repository cannot change mid-thread; channel repository identity is pinned during its first repository lookup, before cloning.
- `retry` explicitly requeues the last failed, interrupted, or canceled request after you inspect preserved work. It does not roll back effects.
- `cancel` stops the active process group and cancels queued follow-ups for that task. Existing commits/pushes are preserved.
- `status` reports the saved task state; it is not a fresh forge/CI audit.
- `help` returns command guidance.
- `runtime=<claude|codex|gemini|opencode>` can be supplied on a new `run` when that provider is configured and its CLI is available on the host; otherwise the bridge replies that it is unavailable. The adapters are fixture-tested; verify each real CLI in a test channel before relying on it.

Every PR the bridge creates or reuses gets the `AI`, `fix-code` and `slack-bridge` labels (`slack-bridge` marks PRs created through the bridge; created in the repository only if missing); if they cannot be applied, the PR is still created and its body says so.

A merged/closed PR needs a new top-level task and a new branch. A PR that is already ready for review is reused: the bridge returns it to draft if the new job's verification is incomplete, and keeps (or promotes a draft to) ready when it is complete.

## Execution and Git behavior

One global worker runs at a time. Independent Slack tasks are queued, preventing simultaneous writers even across repositories. Each accepted task gets a unique isolated worktree using `../skills/fix-code/scripts/git_guard.py`.

The original checkout, its dirty files, and protected branches remain outside the coding worktree. The guard checks the task branch, protected refs, base ancestry, remote routing, and history checkpoints. It detects violations; it is not a Git hook or a complete shell-security boundary. Do not authorize untrusted people to operate this local coding account.

Each attempt uses fresh precheck/architecture/implementation/review phase sessions as its mode requires, with persisted task context, plan, result, and artifacts. It does **not** attach to or resume an arbitrary desktop/mobile chat. Session IDs are saved for audit. The bridge explicitly tells the skill to use the worktree it already prepared rather than creating a second one. The bridge always prepares a separate worktree in every mode, because it runs unattended and may reuse local checkouts; the skill's in-place option is not used by the bridge.

Implementation must leave ordinary commits and a clean worktree. In `advanced` mode, and in `medium` or escalated `simple` cases that meet the review rules above, the independent reviewer reads the real patch and checks evidence. Other `simple` and in-prediction `medium` jobs skip it, and the bridge's own verification is the only check before the PR. Requests for changes get at most the configured repair rounds. Blocked, malformed, or contradictory review verdicts prevent publication.

Only the bridge publisher pushes the explicit task branch and creates/reuses a PR (ready for review when verified, otherwise draft) for that exact head/base. It checks the GitHub remote and existing PR state first. No merges, force pushes, rebases, amends, resets, or deployments are part of the workflow. Model calls remain responsible for following the skill's restrictions inside their available permissions.

## Recovery and reply delivery

The SQLite queue records event IDs and jobs transactionally before acknowledging Slack. Duplicate deliveries do not create duplicate jobs. Bot messages, other workspaces, shared-external channels, and unauthorized users/channels are ignored.

A restart marks in-flight attempts interrupted rather than automatically running them again. If the recorded runner still appears alive, startup stops for local inspection. A crash after worktree creation is reconciled against the Git guard checkpoint; unknown existing directories are not overwritten.

Each run posts a queued reply as soon as the request is accepted (task ID, provider, and the repository and requested mode when already known), an acknowledgement once the precheck has finished that adds only what was learned since (the repository in channel mode, the precheck's mode and its time estimate), a status update every 5 minutes (current phase, elapsed time, estimate) while the task runs, and a final result with the precheck decision, mode, review outcome and the implementer's summary. A run that fails before the precheck completes posts the failure without an acknowledgement. Set `statusIntervalMs` in `config.json` to change the status interval. A run that ends with no commits and a clean worktree (a question, or nothing to change) succeeds with the implementer's answer and publishes no PR.

The final result carries a clickable "Open pull request" link above the message, while the body stays plain text (model output is never sent as mrkdwn).

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

## Tests and development

```bash
npm test
npm run check
python3 ../skills/fix-code/scripts/test_git_guard.py
```

Tests use fake Slack transports/model executables and disposable Git repositories. GitHub publication is replaced with a local fixture. No live Slack messages, model inference, or real PRs are needed for these checks. The Git integration fixture verifies the explicit push refspec and PR reuse, not a network push.

See [architecture and limitations](docs/architecture.md) for component boundaries and deployment considerations.
