# Fix Code Slack Bridge (personal cloud)

This is the personal copy of the Slack bridge for an unattended cloud VM. It acts as **your** GitHub identity and uses **your** model credentials, so pull requests come from your account and runs continue while your laptop is off. It is a thin variant of [`../slack-bridge-core`](../slack-bridge-core/README.md), whose profile allows only GitHub user mode with a token file and managed clones. The [local personal bridge](../slack-fix-code-personal-bridge/README.md) and the [company bridge](../slack-fix-code-company-bridge/README.md) are separate variants with their own config homes, state and Slack apps.

| Bridge | GitHub identity | Model credentials | Where it runs |
| --- | --- | --- | --- |
| [Local personal](../slack-fix-code-personal-bridge/README.md) | Your `gh` login | Your local CLI login | Your Mac or workstation |
| [Company](../slack-fix-code-company-bridge/README.md) | GitHub App installation token file | Vertex AI or Foundry via the host identity | A company-owned host |
| **Personal cloud** (this one) | Personal access token file | Anthropic API key, or Foundry via the VM managed identity | A cloud VM, unattended |

The task flow, Slack commands and safety rules are the same as in the other copies. This copy differs in four ways: its configuration lives in `/etc/slack-fix-code-personal-cloud-bridge/config.json` when deployed (`--config`; `~/.config/fix-code-personal-cloud-bridge` and `FIX_CODE_PERSONAL_CLOUD_CONFIG` are for local trials); it authenticates with a fine-grained token from a file that the VM refreshes, so no `gh auth login` is needed; it only works on managed clones (no local checkouts); and its Slack app is named "Fix Code (Cloud)".

## Requirements

- A Linux VM with Node.js **22.13+**, Python 3, Git, and the `gh` CLI.
- At least one coding CLI installed on the VM and configured with model credentials (see [Model credentials](#model-credentials)).
- A fine-grained personal access token for the repositories you want the bridge to change (see [GitHub token file](#github-token-file)).
- A Slack workspace where you can create an app from a manifest, and your user, channel and workspace IDs.

The bridge reads the `fix-code` skill from this repository (`../../skills/fix-code`), like the other copies.

## 1. Deploy layout and configuration

The supported setup is the systemd deployment in [`../slack-bridge-core/deploy/README.md`](../slack-bridge-core/deploy/README.md). There the bridge runs from `/opt/fix-code/bridge/slack-fix-code-personal-cloud-bridge` (cloud-init runs `npm ci --omit=dev`) and uses:

| Path | Purpose |
| --- | --- |
| `/etc/slack-fix-code-personal-cloud-bridge/config.json` | the config, passed with `--config` by the unit (no secrets) |
| `/etc/slack-fix-code-personal-cloud-bridge/deploy.env` | secret store settings; set `REQUIRED_SECRETS="github-pat"` here |
| `/run/fix-code-secrets/slack-fix-code-personal-cloud-bridge/` | root-owned: fetched `secrets.env` (Slack tokens, root only) and `gh-token` (root:bridge user, 0640), recreated on every start |
| `/var/lib/slack-fix-code-personal-cloud-bridge` | state, clones and the service user's `HOME` (with the cloud-init `.gitconfig`) |

Every command also accepts `--config <path>`. The Slack tokens come from the service environment (`secrets.env`), so no `.env` file is needed. `gh auth setup-git` is not needed either: cloud-init writes the equivalent credential helper to the service user's `.gitconfig`; set your name and GitHub noreply email in it (see the deploy README).

This variant **requires** `githubTokenFile` and works only on managed clones: a missing token file setting, `repositoryRouting.mode: "aliases"` or a `repositories` map is rejected at load.

Trying it locally first (optional, not for production): `npm ci && node src/cli.js init` creates `config.json` and `.env` in `~/.config/fix-code-personal-cloud-bridge/` (or `$XDG_CONFIG_HOME/...`). Without `--config`, lookup is `FIX_CODE_PERSONAL_CLOUD_CONFIG`, `./config.json`, then that directory. A `.env` beside the config is loaded; variables already in the environment win. You still need a `githubTokenFile`.

## 2. Create the Slack app

Follow the Slack app steps in the [local personal bridge README](../slack-fix-code-personal-bridge/README.md). Use `slack-app-manifest.json` from this project; its app is named "Fix Code (Cloud)", so it can coexist with your other bridges. Store the `xapp-` and `xoxb-` tokens as the `slack-app-token` and `slack-bot-token` secrets in your secret store (when trying locally, in the `.env` beside `config.json`), never in chat or Git.

## 3. Fill `config.json`

Start from `config.example.json` (created by `init`; on the VM copy it to `/etc/slack-fix-code-personal-cloud-bridge/config.json`). Replace `teamId`, `allowedUsers` and `allowedChannels` with your IDs. The loader stops at the first placeholder it finds, so it reports these one at a time. The config differs from the other copies here:

- **No `githubAuth`.** User mode is the default, and this profile rejects `"app"`.
- **`githubTokenFile`** is required and points at the token file described below. The file is read on every `gh` and `git` spawn, so a refreshed token takes effect without a restart.
- **`stateDir`** is `/var/lib/slack-fix-code-personal-cloud-bridge`. The state holds the task database and runner session IDs, so keep it on the VM only.
- **`repositoryRouting`** uses `mode: "channel"` and managed clones under `cloneRoot`. There is no `localRoot`, because the VM does not keep your working checkouts. Set `allowedOwners` to your GitHub user (and any organizations you want to allow) so the channel resolver cannot pick a same-named repository elsewhere.
- **`runtimes.<name>.env`** lists the only extra variables forwarded to each CLI. Names such as `GH_TOKEN`, `GITHUB_TOKEN` and `SLACK_*` are rejected.

Other keys (`timeoutMs`, `maxRepairRounds`, `allowNetwork`, `models`, `allowedModels`, `operators`, `statusIntervalMs`) work as described in the [local personal bridge README](../slack-fix-code-personal-bridge/README.md#3-fill-configjson).

## GitHub token file

The VM needs one file that contains exactly one fine-grained personal access token. Keep it outside the repository, for example `/run/fix-code-secrets/slack-fix-code-personal-cloud-bridge/gh-token`, readable by the bridge user but not writable by it. With the [cloud deployment](../slack-bridge-core/deploy/README.md), set `REQUIRED_SECRETS="github-pat"` in `deploy.env`; `fetch-secrets.sh` then fails the start if the secret is missing, and writes this file from the `github-pat` secret before every start; to rotate the token, update the secret and restart the service.

Grant the token access to only the repositories the bridge should change, with these permissions:

- **Contents:** read and write (push task branches)
- **Pull requests:** read and write (open PRs)
- **Issues:** read and write
- **Metadata:** read (required)
- **Workflows:** read and write, optional, only if tasks may edit `.github/workflows/*`

In user mode the file has no age limit. `doctor` checks that it exists and contains a token, then runs `gh auth status` with the token supplied as `GH_TOKEN`. Only `gh` and `git` ever receive the token; coding runtimes, the Git helper and other subprocesses get none, and `GH_TOKEN`/`GITHUB_TOKEN` from the environment are ignored when the file is set. Do not run `gh auth login` on this VM.

## Model credentials

Coding runtimes run on the VM with their own credentials. Pick one provider path per runtime.

**Anthropic API key (simplest).** Put `ANTHROPIC_API_KEY` in the service environment (an `EnvironmentFile` readable only by the bridge user). It is already in the `claude.env` list in the example, so the bridge forwards it to the Claude CLI.

**Microsoft Foundry via the VM's managed identity (the Azure default).** Set these in the service environment, and keep the names listed under `runtimes.claude.env`:

```dotenv
CLAUDE_CODE_USE_FOUNDRY=1
# the resource name only, not a URL
ANTHROPIC_FOUNDRY_RESOURCE=your-foundry-resource
# only when the VM uses a user-assigned managed identity
AZURE_CLIENT_ID=your-identity-client-id
ANTHROPIC_DEFAULT_OPUS_MODEL=...
ANTHROPIC_DEFAULT_SONNET_MODEL=...
ANTHROPIC_DEFAULT_HAIKU_MODEL=...
```

The VM's managed identity is used through Entra ID, so it needs the Cognitive Services User or Foundry User role on the resource. Do not create API key files or set `ANTHROPIC_FOUNDRY_API_KEY`. Each `ANTHROPIC_DEFAULT_*` value must be the deployment name you chose for that model, because the `opus`, `sonnet` and `haiku` aliases resolve differently there.

Vertex AI and Bedrock work the same way with their own non-secret settings (`CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION` for Vertex; `CLAUDE_CODE_USE_BEDROCK` and `AWS_REGION` for Bedrock) forwarded through `runtimes.claude.env`, with credentials from the VM's service account or instance role. The [company bridge README](../slack-fix-code-company-bridge/README.md#claude-via-vertex-ai-or-microsoft-foundry) has the Vertex details.

For Codex, put `OPENAI_API_KEY` in the service environment. The example also lists it under `runtimes.codex.env`; the bridge always forwards built-in provider variables to their own provider, so that entry is optional.

## Deploy to the cloud

See [`../slack-bridge-core/deploy/README.md`](../slack-bridge-core/deploy/README.md) (section 1 above has the layout) for the VM setup: a generic Linux VM run by systemd, with Azure as the default worked example. It covers the bridge user, the token file refresh, the `EnvironmentFile`, the state directory and the unit file.

## 4. Run diagnostics, then connect

```bash
npm run doctor
npm start
```

`doctor` makes no model calls and sends no Slack messages. It checks the skill and Git helper, the token file, `gh auth status` with the injected token, and which default runtime would be selected. Run `npm start` under systemd on the VM rather than in an interactive shell. First test in a dedicated channel with a harmless known bug.

## Slack commands, execution and recovery

These behave the same as in the local personal bridge. See its sections for the details:

- [Slack commands](../slack-fix-code-personal-bridge/README.md#slack-commands)
- [Execution and Git behavior](../slack-fix-code-personal-bridge/README.md#execution-and-git-behavior)
- [Recovery and reply delivery](../slack-fix-code-personal-bridge/README.md#recovery-and-reply-delivery)

## Architecture and tests

The architecture notes are in [`../slack-bridge-core/docs/architecture.md`](../slack-bridge-core/docs/architecture.md), which applies to all variants. Shared tests live in `../slack-bridge-core` (`cd ../slack-bridge-core && npm test`). Run the checks with:

```bash
npm run check
npm test
```
