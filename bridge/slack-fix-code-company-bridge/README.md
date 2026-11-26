# Fix Code Slack Bridge (company)

This is the company variant of the Slack bridge, for a company-owned host. It is a thin package over [`../slack-bridge-core`](../slack-bridge-core/README.md), which holds the shared task flow, queue, runner, Git and routing code; the variant supplies its profile (`src/profile.js`) and Slack SDK wiring (`src/cli.js`). There are three variants:

- [`slack-fix-code-personal-bridge`](../slack-fix-code-personal-bridge/README.md): your local Mac or workstation, using your `gh` login.
- [`slack-fix-code-personal-cloud-bridge`](../slack-fix-code-personal-cloud-bridge/README.md): your personal GitHub token on an unattended cloud VM.
- `slack-fix-code-company-bridge` (this one): company GitHub App tokens and Vertex AI or Microsoft Foundry.

This variant's profile allows GitHub user mode and GitHub App mode (`githubAuth: "app"`, with a token file), and local checkout reuse (`repositoryRouting.localRoot`). Its configuration lives in `~/.config/fix-code-company-bridge` (`FIX_CODE_COMPANY_CONFIG` selects another file); it can run Claude through Vertex AI or Microsoft Foundry; and its Slack app is named "Fix Code (Company)". The task flow and safety rules are the same across variants. The [architecture notes](../slack-bridge-core/docs/architecture.md) cover the shared design.

Send a task from Slack on your phone, let a local coding runner use `fix-code`, and receive a pull request in the same Slack thread (ready for review when verification is complete, otherwise a draft).

This bridge uses Slack Socket Mode, a durable SQLite queue, and a local coding CLI: Claude Code, Codex, Gemini CLI, or opencode (see [Providers](#providers)). It creates an isolated branch/worktree before coding and orchestrates a read-only precheck that classifies each task as simple, medium, or advanced → implementation → independent review only where the mode requires it (advanced always adds architecture first) → controlled branch push → PR (ready for review only when verified, otherwise draft).

**Status:** implementation and local fixture tests are complete. Live Slack delivery, model execution, and GitHub publication require your configuration and have not been exercised by the offline test suite. No background service is enabled automatically.

## Requirements

- macOS or Linux, Node.js **22.13+** (Node 24 LTS recommended), Python 3, and Git.
- At least one supported coding CLI installed and authenticated: Claude Code, Codex (`codex login status`), Gemini CLI, or opencode.
- GitHub CLI (`gh`) with access to the repositories you want the bridge to use. In user mode (the default) it must be authenticated (`gh auth status`), and channel routing requires push permission for the selected repository. In app mode (`githubAuth: "app"`) there is no `gh auth login`: `gh` and `git` get a token from `githubTokenFile`, the bound repository must be in the GitHub App installation, and you run `gh auth setup-git` once with `GH_TOKEN` taken from that file (see below). See [GitHub App authentication](#github-app-authentication).
- A Slack workspace where the app can read public/private channel metadata, plus your allowed user/channel/workspace IDs.

The bridge reads the `fix-code` skill from this repository (`../../skills/fix-code`, the same source that `scripts/install-skills.py` installs), so it never runs a stale private copy and does not depend on a user-global installation. Point `skillPath` at another reviewed installation if desired.

## 1. Install dependencies and initialize private configuration

In this project directory:

```bash
npm ci
node src/cli.js init
```

`init` creates `config.json` and `.env` in `~/.config/fix-code-company-bridge/` (or `$XDG_CONFIG_HOME/fix-code-company-bridge/`) with private permissions and preserves existing files. They live outside the repository, so updates and worktrees never touch them. Edit them locally; never paste tokens into a chat or commit them. `init --config /some/dir/config.json` creates them in another directory instead.

Every command finds its configuration in this order: `--config <path>`, `FIX_CODE_COMPANY_CONFIG`, `./config.json` in the current directory (older setups), then `~/.config/fix-code-company-bridge/config.json`. The `.env` next to the chosen `config.json` is loaded automatically; variables already set in the environment win. Relative paths in `config.json`, such as `stateDir: "./state"`, resolve against the config file's directory, so state also lives in `~/.config/fix-code-company-bridge/state` by default. Without `skillPath`, the bridge uses the repository's `skills/fix-code` next to the code it runs from; set it (absolute, or relative to the config file) only to use another reviewed installation.

## 2. Create the Slack app

1. Open [Slack app management](https://api.slack.com/apps) and create an app **from a manifest** in your workspace.
2. Paste/import `slack-app-manifest.json` from this project.
3. Check that Socket Mode is enabled. Under **Basic Information → App-Level Tokens**, generate an app token with `connections:write`.
4. Install the app into the workspace and copy its Bot User OAuth Token from **OAuth & Permissions**.
5. Put the app token (`xapp-...`) and bot token (`xoxb-...`) into `~/.config/fix-code-company-bridge/.env` locally:

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
- `timeoutMs`, `maxRepairRounds`, `pythonPath`, `forwardGitHubAuth` (optional): defaults and meaning are in [Optional settings](../slack-bridge-core/docs/usage.md#optional-settings).

The generated example uses channel routing and does not need a `repositories` alias map. The default clone root is `<stateDir>/repositories`. A channel name such as `billing-service` selects only a repository whose GitHub repository name matches `billing-service`, ignoring case. The bridge gets the channel's authoritative name and ID from Slack `conversations.info` and searches all accessible GitHub repositories using paginated `gh` results, including repositories owned by you, shared with you, or visible through an organization. It requires push permission before starting work. In app mode, discovery lists the repositories in the GitHub App installation instead, and the write check is installation membership with Contents write.

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

Keep `stateDir` private and outside the configured source repositories. It contains the task database, private evidence, and runner session IDs. Task worktrees are stored separately under `~/workspace/worktrees/<repository-directory-name>/<worktree-name>`. The personal and company copies on one host share this root. An existing worktree directory without a matching guard checkpoint is refused, never reused. Do not delete state while tasks exist. Use a dedicated coding account/container if you need stronger separation: removing Slack tokens from child environments does not prevent processes under the same OS user from reading accessible files.

## Providers

The provider table, caveats, `runtimes` configuration and default runtime precedence are the same for every variant. See [Providers](../slack-bridge-core/docs/usage.md#providers).

In this variant, `env` additionally rejects `GH_TOKEN` and `GITHUB_TOKEN` in every runtime, as well as names starting with `SLACK_`.

## GitHub App authentication

Instead of a personal `gh` login or a bot account, the company copy can act as a GitHub App. Set these in `config.json`:

```json
"githubAuth": "app",
"githubTokenFile": "/run/fix-code-bridge/gh-token"
```

- `githubAuth` is `"user"` (default) or `"app"`. In app mode `githubTokenFile` is required, because installation tokens expire after one hour. The file must contain exactly one token.
- In user mode, `githubTokenFile` is optional and then holds a personal access token. The file is read the same way, but no age check applies.
- The bridge reads the token file on every `gh` and `git` spawn, so a refreshed token takes effect without a restart. In app mode a file older than 60 minutes fails the spawn with a message that names the path only and never the token. `doctor` fails its `GitHub token file` check once the file is older than 55 minutes, which leaves headroom before the 60-minute spawn limit.
- With a token file set, the `GH_TOKEN` and `GITHUB_TOKEN` environment variables are ignored. Only `gh` and `git` receive a token. The Python Git helper, the coding CLIs and every other subprocess get none.
- `forwardGitHubAuth` is rejected together with `githubTokenFile`. Coding runtimes never receive a GitHub token; only the bridge's publisher pushes and creates pull requests.
- Token refresh is outside the bridge. A root-run systemd timer mints an installation token every 30 minutes from the app's private key and writes the file atomically with mode `0640`, group-owned by the bridge user. The private key stays root-only and is never readable by the bridge user.
- Run this once as the bridge user, after the token timer has written the file, so `git` asks `gh` for credentials:

  ```bash
  GH_TOKEN="$(cat /run/fix-code-bridge/gh-token)" gh auth setup-git --hostname github.com
  ```

  This only writes git's credential helper (`!gh auth git-credential`) to the Git configuration. No token is stored there. At runtime `gh` reads the `GH_TOKEN` that the bridge supplies on each spawn, so no `gh` login is needed. Do not run `gh auth login` in app mode.
- App permissions: Contents (read and write), Pull requests (read and write), Issues (read and write), and Metadata (read). Workflows (read and write) is optional and needed only if tasks may edit `.github/workflows/*`. Disable the webhook, because the bridge uses Slack Socket Mode. Install the app on selected repositories only; adding a repository to the installation onboards it.
- Discovery and revalidation: in app mode, channel routing searches `/installation/repositories` rather than `/user/repos`. An installation token can read any public repository through `/repos/...`, so when a job is prepared the bridge also checks that the bound repository is in the installation. The archived, disabled, identity and default-branch checks are unchanged.
- Commits are attributed to `<app-slug>[bot]`, with the email `<bot-id>+<app-slug>[bot]@users.noreply.github.com`. Set it as `user.name` and `user.email` in the bridge user's Git configuration.

Setting `githubAuth` to `"user"` keeps the personal-account behavior from earlier sections, with no age check on the token file.

## Claude via Vertex AI or Microsoft Foundry

A company deployment can run Claude through its cloud provider. The bot then needs no model API key. Put the non-secret settings in the bridge's service environment (an `EnvironmentFile` read by systemd), and list their names under `runtimes.claude.env` so the bridge forwards them to the Claude CLI. Other variables are not forwarded.

For Vertex AI:

```dotenv
CLAUDE_CODE_USE_VERTEX=1
ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
# global, a multi-region such as eu or us, or a region such as europe-west1
CLOUD_ML_REGION=eu
```

For Microsoft Foundry:

```dotenv
CLAUDE_CODE_USE_FOUNDRY=1
# the resource name only, not a URL
ANTHROPIC_FOUNDRY_RESOURCE=your-foundry-resource
# only when the VM uses a user-assigned managed identity
AZURE_CLIENT_ID=your-identity-client-id
```

Both providers need the model pins below. On them the `opus`, `sonnet` and `haiku` aliases resolve to older models than on the Anthropic API. Keep the aliases in `models` and `allowedModels`, and pin the model each alias means:

```dotenv
ANTHROPIC_DEFAULT_OPUS_MODEL=...
ANTHROPIC_DEFAULT_SONNET_MODEL=...
ANTHROPIC_DEFAULT_HAIKU_MODEL=...
```

On Vertex AI, use the exact model versions that are enabled in your location. On Foundry, each value must be the deployment name you chose for that model.

Forward all nine names in `config.json`:

```json
"claude": {
  "path": "claude",
  "env": ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
          "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_RESOURCE", "AZURE_CLIENT_ID",
          "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]
}
```

Credentials come from the host's identity, never from key files. On Vertex AI the VM's service account is used through Application Default Credentials and needs `roles/aiplatform.user` on the project. On Foundry the VM's managed identity is used through Entra ID and needs Cognitive Services User or Foundry User on the resource. Do not set `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_FOUNDRY_API_KEY` or `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, and do not create a service-account key file.

`doctor` checks only that the CLI runs. Test a real task in a dedicated channel with `mode=simple`. A "model not found" error means the model is not enabled in that location (or, on Foundry, the deployment name does not match). For 429 errors, raise the Vertex quota or try `CLOUD_ML_REGION=global`.

## 4. Run diagnostics, then connect

```bash
npm run doctor
npm start
node src/cli.js start --runtime gemini   # optional: override the default runtime for this run
```

`doctor` checks local tools/authentication and reports which default runtime would be selected. Only **one** configured provider needs to be usable (its CLI answers `--version`, plus `login status` for Codex); missing ones are reported as `unavailable` and do not fail the check. With `doctor --runtime <name>`, that provider must be usable. If an explicit `"runtime"` in `config.json` is not usable, doctor shows a warning, because `start` would then need `--runtime`. It also checks the skill/helper, repository routing, and presence of token-shaped values. With `githubTokenFile` set, it checks that the file is present and, in app mode, no more than 55 minutes old (an older file fails). In app mode it then runs a GitHub App installation access check in place of `gh auth status`; in user mode `gh auth status` still runs, with the token file's value supplied as `GH_TOKEN`. It makes no model calls and sends no Slack messages. Actual token validity/workspace binding is checked at connection time. Actual model availability is checked when a phase is invoked.

Leave the terminal open and keep the host awake/online. To keep a plugged-in Mac available for a supervised session, you can run the start command under `caffeinate`:

```bash
caffeinate -i npm start
```

No login agent, cron job, or system service is installed. First test in a dedicated channel with a harmless known bug.

## Slack commands, execution and recovery

These are shared by all variants and documented once in [Using the bridge in Slack](../slack-bridge-core/docs/usage.md):

- [Slack commands](../slack-bridge-core/docs/usage.md#slack-commands)
- [Execution and Git behavior](../slack-bridge-core/docs/usage.md#execution-and-git-behavior)
- [Recovery and reply delivery](../slack-bridge-core/docs/usage.md#recovery-and-reply-delivery)

## Deploy to the cloud

For a Linux VM run by systemd (cloud-init, the Azure provisioning example, secret fetching), see [`../slack-bridge-core/deploy/README.md`](../slack-bridge-core/deploy/README.md). There the company variant takes its token from a GitHub App installation token that a root-run timer writes; no personal token is involved.

With the systemd template, keep the timer-owned token path `/run/fix-code-bridge/gh-token` in `githubTokenFile` (and in the `gh auth setup-git` command above), a directory owned by the refresh timer rather than by the unit (the unit's secrets directory `/run/fix-code-secrets/slack-fix-code-company-bridge/` is recreated on each start). Set `GITHUB_TOKEN_SOURCE=external` in `/etc/slack-fix-code-company-bridge/deploy.env` so `fetch-secrets.sh` never fetches or writes `gh-token`, and do not store a `github-pat` secret for this app-mode deployment.

## Tests and development

```bash
npm test
npm run check
python3 ../../skills/fix-code/scripts/test_git_guard.py
```

Tests use fake Slack transports/model executables and disposable Git repositories. GitHub publication is replaced with a local fixture. No live Slack messages, model inference, or real PRs are needed for these checks. The Git integration fixture verifies the explicit push refspec and PR reuse, not a network push.

Shared tests for the core live in `../slack-bridge-core`: `cd ../slack-bridge-core && npm test`. The commands above cover this variant's profile, configuration and wiring.

See [architecture and limitations](../slack-bridge-core/docs/architecture.md) for component boundaries and deployment considerations.
