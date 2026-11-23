# Cloud deployment for the fix-code bridges

The model is cloud-generic: any Linux VM, a machine identity, a secret store and systemd. Azure is the default and has a worked example (`azure/provision.sh`); AWS, GCP and plain VMs differ only in the provider flag and IAM.

- The bridge uses Slack Socket Mode: it only makes outbound connections. Open no inbound ports.
- The whole repository is deployed to `/opt/fix-code` (the bridge reads the skill from `/opt/fix-code/skills/fix-code`). Node >= 22.13 is required.
- One systemd template unit, `fix-code-bridge@<variant>.service`, runs a variant (for example `slack-fix-code-personal-cloud-bridge` or `slack-fix-code-company-bridge`).
- Before each start, `bin/fetch-secrets.sh` (run as root by `ExecStartPre=+`) pulls secrets with the machine identity into `/run/<variant>/` (tmpfs). It writes `secrets.env` (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, optional `ANTHROPIC_API_KEY`) and an optional `gh-token`, atomically, mode 0600, owned by `fixcode`. systemd loads `secrets.env` as an `EnvironmentFile`, and the bridge's own `.env`-beside-config loading is not needed (variables already in the environment win).

## Layout on the VM

| Path | Purpose |
| --- | --- |
| `/opt/fix-code` | repository clone (root-owned, read by `fixcode`) |
| `/etc/<variant>/config.json` | bridge config, no secrets |
| `/etc/<variant>/bridge.env` | non-secret environment (`CLAUDE_CODE_USE_FOUNDRY=1`, ...) |
| `/etc/<variant>/deploy.env` | secret store settings (`FIX_CODE_SECRET_PROVIDER`, `AZURE_KEY_VAULT`, `AWS_SECRET_PREFIX`, `GCP_PROJECT`, `REQUIRED_SECRETS`, `GITHUB_TOKEN_SOURCE`); sourced by root, so it must be root-owned and not group/world-writable |
| `/var/lib/<variant>/.gitconfig` | git setup for `fixcode` (gh credential helper, identity placeholders) |
| `/run/<variant>/` | fetched secrets (tmpfs, recreated on every start) |
| `/var/lib/<variant>` | state directory and `HOME` of `fixcode` |

## Mapping across platforms

| Piece | Azure (default) | AWS | GCP | Plain VM |
| --- | --- | --- | --- | --- |
| Compute | Linux VM (Ubuntu 24.04) | EC2 | Compute Engine | any Linux with systemd |
| Machine identity | system-assigned managed identity | instance profile (IAM role) | attached service account | none |
| Secret store | Key Vault (RBAC) | Secrets Manager | Secret Manager | files you place yourself |
| Claude via | Microsoft Foundry | Bedrock | Vertex AI | `ANTHROPIC_API_KEY` |
| fetch-secrets provider | `azure` | `aws` | `gcp` | `none` |

Secret names are the same everywhere: `slack-bot-token`, `slack-app-token`, optional `github-pat`, optional `anthropic-api-key`. The provider is resolved as: `--provider` flag, then `FIX_CODE_SECRET_PROVIDER` (from the environment or from `deploy.env`, which is sourced first), then `azure`. `none` still reads `deploy.env` and then does nothing.

`slack-bot-token` and `slack-app-token` are always required. Add more with `REQUIRED_SECRETS="github-pat"` in `deploy.env` (space-separated). An optional secret is treated as absent only when the CLI confirms not-found (az `SecretNotFound`, aws `ResourceNotFoundException`, gcloud `NOT_FOUND`); any other error (for example `AuthorizationFailed`) fails the start for every secret. A confirmed-absent `github-pat` removes a stale `gh-token`; a missing `anthropic-api-key` is simply left out of `secrets.env`. Files are replaced only after every fetch succeeded.

The cloud CLIs run as root but in a scrubbed environment (`env -i`, `HOME=/var/lib/fix-code-secrets`, mode 0700): the unit's `HOME` is writable by `fixcode` and the coding agents, and a planted `~/.aws/config` (`credential_process`) or az/gcloud config must never run as root.

## Azure worked example

Requirements: `az` logged in, and rights to create resources and role assignments.

```bash
cd bridge/slack-bridge-core/deploy
azure/provision.sh --variant slack-fix-code-personal-cloud-bridge \
  --resource-group rg-fix-code --location westeurope --vault kv-fix-code-123   # 3-24 chars, letters/digits/hyphens, starts with a letter; default is kv-<name>-<4 hex> \
  [--foundry-resource-id /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<name>] --dry-run   # drop --dry-run to run it
```

It creates the resource group, an RBAC-enabled Key Vault, the VM (cloud-init installs git, python3, gh, Node 22, clones the repo, runs `npm ci --omit=dev`, installs the unit, creates `/etc/<variant>/`) with a system-assigned identity, and grants it `Key Vault Secrets User` on the vault first, then `Cognitive Services User` on the Foundry resource if `--foundry-resource-id` (the full ARM id) is given. The cloud-init also installs the Azure CLI (`curl -sL https://aka.ms/InstallAzureCLIDeb | bash`), keeps the default admin user and writes `/var/lib/<variant>/.gitconfig`. The service is not started.

Public IP choice: the VM keeps Azure's default public IP so it has outbound internet, but the NSG gets no inbound rules (`--nsg-rule NONE`). With no inbound SSH rule you cannot SSH in by default. Options: (1) recommended for the few setup steps: `az vm run-command invoke --resource-group <rg> --name <vm> --command-id RunShellScript --scripts 'echo AZURE_KEY_VAULT=<vault> >> /etc/<variant>/deploy.env'`; (2) temporarily `az vm open-port --resource-group <rg> --name <vm> --port 22` restricted to your IP (then remove the rule), then `ssh azureuser@<ip>` using the admin key that `az vm create --generate-ssh-keys` put in `~/.ssh` (the user is `azureuser`, in cloud-init's `- default` user); (3) Azure Bastion. To avoid any public IP, add a NAT gateway and adapt the script.

Then:

1. Store secrets (you need Key Vault Secrets Officer). Read values from a file or stdin, never argv: `az keyvault secret set --vault-name <vault> --name slack-bot-token --file ./token.txt`. Repeat for `slack-app-token`, and optionally `github-pat`, `anthropic-api-key`. Delete the local files.
2. On the VM (run-command or SSH as above): `echo AZURE_KEY_VAULT=<vault> | sudo tee -a /etc/<variant>/deploy.env` (keep it root-owned, mode 0640), copy `bridge/<variant>/config.example.json` to `/etc/<variant>/config.json` and edit it (`stateDir` `/var/lib/<variant>`), add non-secret settings to `bridge.env`.
3. Optional coding CLI: `sudo npm install -g @anthropic-ai/claude-code`.
4. Start: `sudo systemctl enable --now fix-code-bridge@<variant>`.
5. Logs: `journalctl -u fix-code-bridge@<variant> -f`.
6. Update (your choice when to pull): `sudo git -C /opt/fix-code pull --ff-only && (cd /opt/fix-code/bridge/<variant> && sudo npm ci --omit=dev) && sudo systemctl restart fix-code-bridge@<variant>`.
7. Rotate a secret: update it in the store, then `sudo systemctl restart fix-code-bridge@<variant>`.

## AWS, GCP and other platforms

Create the VM yourself and use `cloud-init/fix-code-bridge.yaml` as user data after replacing `REPO_URL` and `VARIANT` (`sed`). Then:

- AWS: `FIX_CODE_SECRET_PROVIDER=aws`, `AWS_SECRET_PREFIX=fix-code/<variant>` in `deploy.env`; secrets are `<prefix>/<name>` plain-string secrets. Grant the instance role `secretsmanager:GetSecretValue` on them. Claude via Bedrock: set `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION` in `bridge.env` and allow those variables in the runtime `env` list in config.json.
- GCP: `FIX_CODE_SECRET_PROVIDER=gcp`, `GCP_PROJECT=<project>`; grant the service account `roles/secretmanager.secretAccessor`. Vertex: `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`.
- Other: `FIX_CODE_SECRET_PROVIDER=none`; create `/run/<variant>/secrets.env` (0600, owner `fixcode`) by your own means, or put `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` in a root-managed `bridge.env` (mode 0640, group `fixcode`).

The CLI of the provider must be installed on the VM; the machine identity is used automatically (`az login --identity` is run by the script). Cloud-init installs only the Azure CLI. On AWS install AWS CLI v2 (`curl https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip -o awscliv2.zip && unzip awscliv2.zip && sudo ./aws/install`); on GCP the Google Cloud CLI (`sudo snap install google-cloud-cli --classic`, or Google's apt repository). Remove the Azure CLI line from cloud-init if unused.

## git for the service user

Cloud-init writes `/var/lib/<variant>/.gitconfig` (owner `fixcode`, 0644) with the same credential helper that `gh auth setup-git` writes (an empty `helper =` line, then `helper = !/usr/bin/gh auth git-credential`) and placeholder `[user] name`/`email`. Edit it:

- personal-cloud: your GitHub name and noreply email (`<id>+<login>@users.noreply.github.com`).
- company: `<app-slug>[bot]` and the app's noreply email (`<app-id>+<app-slug>[bot]@users.noreply.github.com`).

## Per-variant notes

- personal-cloud: store a GitHub PAT as `github-pat` and set `REQUIRED_SECRETS="github-pat"` in `deploy.env`; it is written to `/run/<variant>/gh-token`. Set `githubTokenFile` to that path (the example config already does), `stateDir` is the unit's `StateDirectory`, `/var/lib/slack-fix-code-personal-cloud-bridge`. See the variant README.
- company: uses a GitHub App (`githubAuth: "app"`). Keep the timer-owned token path `/run/fix-code-bridge/gh-token` (the directory belongs to the token timer, not to the unit), set `GITHUB_TOKEN_SOURCE=external` in `deploy.env` so `fetch-secrets.sh` never fetches or writes `gh-token`, and do NOT store `github-pat` for app-mode deployments. fetch-secrets does not mint App tokens: run the refresh timer from the company README ("GitHub App authentication") as root.

## Security notes

- Secrets live only in `/run` (tmpfs) and the secret store; never put them in `config.json`, `deploy.env` or cloud-init.
- No inbound ports; NSG/security groups should deny all inbound.
- Grant the identity read-only access to the specific vault or secrets (Key Vault Secrets User, not Officer).
- Secret files are 0600 owned by `fixcode`; `/run/<variant>` is 0750.
- `fetch-secrets.sh` never prints secret values and never passes them on command lines. `--dry-run` prints the commands only.
