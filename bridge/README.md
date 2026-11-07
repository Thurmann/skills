# Fix Code Slack Bridge

Send a task from Slack on your phone, let a local coding runner use `fix-code`, and receive a draft pull request in the same Slack thread.

This bridge uses Slack Socket Mode, a durable SQLite queue, and the Codex CLI by default. It includes a Claude Code adapter. It creates an isolated branch/worktree before coding and orchestrates architecture → implementation → independent review → controlled branch push → draft PR.

**Status:** implementation and local fixture tests are complete. Live Slack delivery, model execution, and GitHub publication require your configuration and have not been exercised by the offline test suite. No background service is enabled automatically.

## Requirements

- macOS or Linux, Node.js **22.13+** (Node 24 LTS recommended), Python 3, and Git.
- Codex CLI installed and authenticated (`codex login status`), or Claude Code installed/authenticated if you select that runtime.
- GitHub CLI authenticated (`gh auth status`) with access to the repositories you want the bridge to use. Channel routing requires push permission for the selected repository.
- A Slack workspace where the app can read public/private channel metadata, plus your allowed user/channel/workspace IDs.

A snapshot of the `fix-code` skill is bundled under `skills/fix-code`. The runner reads it directly, so the bridge does not depend on a user-global skill installation. Point `skillPath` at another reviewed installation if desired. Changes to a global skill are not automatically synchronized into this snapshot.

## 1. Install dependencies and initialize private configuration

In this project directory:

```bash
npm ci
node src/cli.js init
```

`init` creates `.env` and `config.json` with private file permissions and preserves existing files. Both are Git-ignored. Edit them locally; never paste tokens into a chat or commit them.

## 2. Create the Slack app

1. Open [Slack app management](https://api.slack.com/apps) and create an app **from a manifest** in your workspace.
2. Paste/import `slack-app-manifest.json` from this project.
3. Check that Socket Mode is enabled. Under **Basic Information → App-Level Tokens**, generate an app token with `connections:write`.
4. Install the app into the workspace and copy its Bot User OAuth Token from **OAuth & Permissions**.
5. Put the app token (`xapp-...`) and bot token (`xoxb-...`) into `.env` locally:

   ```dotenv
   SLACK_BOT_TOKEN=your-local-bot-token
   SLACK_APP_TOKEN=your-local-app-token
   FIX_CODE_CONFIG=./config.json
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
- `models`: architecture/implementation/review defaults for the selected runtime.
- `allowedModels`: explicit override allowlists, validated against the models you can actually run.

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

The example selects GPT-6.1 Sol for architecture/review and GPT-6 Luna for implementation. Those are candidates, not a guarantee of your account's access. Update both defaults and the allowlist to your supported models. Claude candidates are `opus`/`haiku`, also subject to your installed CLI/account. A rejected model stops the run; it is never silently replaced with a more expensive model.

`allowNetwork: true` permits configured Codex workspace networking and bridge fetch/push/PR operations. With it false, the bridge cannot finish PR delivery. Claude's network policy is an instruction here, not an enforced network sandbox. No runtime is launched with approval/sandbox bypass flags. CLI actions requiring an unavailable interactive approval fail and preserve the task.

Keep `stateDir` private and outside the configured source repositories. It contains the task database, private evidence, and runner session IDs. Task worktrees are stored separately under `~/workspace/worktrees/<repository-directory-name>/<worktree-name>`. Do not delete state while tasks exist. Use a dedicated coding account/container if you need stronger separation: removing Slack tokens from child environments does not prevent processes under the same OS user from reading accessible files.

## 4. Run diagnostics, then connect

```bash
npm run doctor
npm start
```

`doctor` checks local tools/authentication, the skill/helper, repository routing, and presence of token-shaped values. It makes no model calls and sends no Slack messages. Actual token validity/workspace binding is checked at connection time. Actual model availability is checked when a phase is invoked.

Leave the terminal open and keep the host awake/online. To keep a plugged-in Mac available for a supervised session, you can run the start command under `caffeinate`:

```bash
caffeinate -i npm start
```

No login agent, cron job, or system service is installed. First test in a dedicated channel with a harmless known bug.

## Slack commands

Start each independent task with a **new top-level mention**. In the default channel mode, no repository option is needed:

```text
@Fix Code run -- Fix the duplicate retry bug. Reproduce it first and verify the fix.
```

For example, a mention in `#billing-service` resolves the exact case-insensitive repository name `billing-service`. `repo=<alias>` is rejected in channel mode; it remains available only with `repositoryRouting.mode: "aliases"`. Neither mode accepts an arbitrary repository path from Slack or automatically creates a GitHub repository. An unknown or empty remote is a blocking error. New features and fixes in the selected repository use the same command.

Older configurations that remain in aliases mode continue to use commands such as `@Fix Code run repo=app -- Add CSV export.`

Override models **before** the separator:

```text
@Fix Code run architect_model=gpt-6.1-sol implementer_model=gpt-6-luna -- Add pagination.
```

`model=<id>` overrides every role; a role-specific option takes precedence. Models must be in the configured runtime allowlist. Text after `--` is request data and cannot set runner flags or model options. Model selection uses explicit phase-level CLI invocations, rather than relying on nested model delegation.

In that task's thread:

```text
@Fix Code followup -- Also cover an empty result set.
@Fix Code followup implementer_model=gpt-6.1-sol -- Diagnose the unresolved race.
@Fix Code status
@Fix Code cancel
@Fix Code retry
```

- `followup` queues a correction to the same change, branch, and task. The selected runtime/repository cannot change mid-thread; channel repository identity is pinned during its first repository lookup, before cloning.
- `retry` explicitly requeues the last failed, interrupted, or canceled request after you inspect preserved work. It does not roll back effects.
- `cancel` stops the active process group and cancels queued follow-ups for that task. Existing commits/pushes are preserved.
- `status` reports the saved task state; it is not a fresh forge/CI audit.
- `help` returns command guidance.
- `runtime=claude` can be supplied on a new `run` when Claude is installed/configured. This adapter is fixture-tested; verify the real CLI in a test channel before relying on it.

A merged/closed PR needs a new top-level task and a new branch. A PR marked ready for review must be returned to draft manually before this draft-only bridge edits it again.

## Execution and Git behavior

One global worker runs at a time. Independent Slack tasks are queued, preventing simultaneous writers even across repositories. Each accepted task gets a unique isolated worktree using `skills/fix-code/scripts/git_guard.py`.

The original checkout, its dirty files, and protected branches remain outside the coding worktree. The guard checks the task branch, protected refs, base ancestry, remote routing, and history checkpoints. It detects violations; it is not a Git hook or a complete shell-security boundary. Do not authorize untrusted people to operate this local coding account.

Each attempt uses fresh architecture/implementation/review phase sessions, with persisted task context, plan, result, and artifacts. It does **not** attach to or resume an arbitrary desktop/mobile chat. Session IDs are saved for audit. The bridge explicitly tells the skill to use the worktree it already prepared rather than creating a second one.

Implementation must leave ordinary commits and a clean worktree. The independent reviewer reads the real patch and checks evidence. Requests for changes get at most the configured repair rounds. Blocked, malformed, or contradictory review verdicts prevent publication.

Only the bridge publisher pushes the explicit task branch and creates/reuses a draft PR for that exact head/base. It checks the GitHub remote and existing PR state first. No merges, force pushes, rebases, amends, resets, or deployments are part of the workflow. Model calls remain responsible for following the skill's restrictions inside their available permissions.

## Recovery and reply delivery

The SQLite queue records event IDs and jobs transactionally before acknowledging Slack. Duplicate deliveries do not create duplicate jobs. Bot messages, other workspaces, shared-external channels, and unauthorized users/channels are ignored.

A restart marks in-flight attempts interrupted rather than automatically running them again. If the recorded runner still appears alive, startup stops for local inspection. A crash after worktree creation is reconciled against the Git guard checkpoint; unknown existing directories are not overwritten.

Slack replies use a persistent outbox and original thread coordinates. Rate limits get bounded retries. A connection failure after a possible send is marked **uncertain** rather than blindly resent; exactly-once external delivery is not claimed.

Inspect local state:

```bash
node --env-file-if-exists=.env src/cli.js status
node --env-file-if-exists=.env src/cli.js outbox
```

For an uncertain reply, inspect Slack first. With the bridge stopped, explicitly retry only when it was not delivered:

```bash
node --env-file-if-exists=.env src/cli.js outbox retry OUTBOX_ID --confirmed-not-delivered
```

Ctrl+C sends a graceful shutdown/cancel request. Do not delete worktrees or state to resolve a failure. If publication had started, inspect the actual branch and PR before retrying. Existing PR lookup prevents normal retry duplication, but remote effects cannot be atomically committed with SQLite.

## Tests and development

```bash
npm test
npm run check
python3 skills/fix-code/scripts/test_git_guard.py
```

Tests use fake Slack transports/model executables and disposable Git repositories. GitHub publication is replaced with a local fixture. No live Slack messages, model inference, or real PRs are needed for these checks. The Git integration fixture verifies the explicit push refspec and PR reuse, not a network push.

See [architecture and limitations](docs/architecture.md) for component boundaries and deployment considerations.
