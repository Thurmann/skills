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
| `/etc/<variant>/deploy.env` | secret store settings (`AZURE_KEY_VAULT`, `AWS_SECRET_PREFIX`, `GCP_PROJECT`) |
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

Secret names are the same everywhere: `slack-bot-token`, `slack-app-token`, optional `github-pat`, optional `anthropic-api-key`. Select the provider with `FIX_CODE_SECRET_PROVIDER` (it is inherited by `ExecStartPre` from `/etc/<variant>/bridge.env`) or `--provider`; the default is `azure`.

## Azure worked example

Requirements: `az` logged in, and rights to create resources and role assignments.

```bash
cd bridge/slack-bridge-core/deploy
azure/provision.sh --variant slack-fix-code-personal-cloud-bridge \
  --resource-group rg-fix-code --location westeurope --vault kv-fix-code-123 \
  [--foundry-resource my-foundry] --dry-run   # drop --dry-run to run it
```

It creates the resource group, an RBAC-enabled Key Vault, the VM (cloud-init installs git, python3, gh, Node 22, clones the repo, runs `npm ci --omit=dev`, installs the unit, creates `/etc/<variant>/`) with a system-assigned identity, and grants it `Key Vault Secrets User` on the vault (plus `Cognitive Services User` on the Foundry resource if given). The service is not started.

Public IP choice: the VM keeps Azure's default public IP so it has outbound internet, but the NSG gets no inbound rules (`--nsg-rule NONE`). Use `az ssh vm` or Bastion for a shell (this needs a temporary SSH allow rule or Bastion). To avoid any public IP, add a NAT gateway and adapt the script.

Then:

1. Store secrets (you need Key Vault Secrets Officer). Read values from a file or stdin, never argv: `az keyvault secret set --vault-name <vault> --name slack-bot-token --file ./token.txt`. Repeat for `slack-app-token`, and optionally `github-pat`, `anthropic-api-key`. Delete the local files.
2. On the VM: `echo AZURE_KEY_VAULT=<vault> | sudo tee -a /etc/<variant>/deploy.env`, copy `bridge/<variant>/config.example.json` to `/etc/<variant>/config.json` and edit it (`stateDir` `/var/lib/<variant>`), add non-secret settings to `bridge.env`.
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

The CLI of the provider (`az`, `aws`, `gcloud`) must be installed on the VM and logged in via the machine identity.

## Per-variant notes

- personal-cloud: store a GitHub PAT as `github-pat`; it is written to `/run/<variant>/gh-token`. Set `githubTokenFile` to `/run/<variant>/gh-token` (the example config uses `/run/fix-code-personal-cloud-bridge/gh-token`, which matches this layout).
- company: uses a GitHub App (`githubAuth: "app"`). fetch-secrets does not mint App tokens. Run the token refresh timer described in the company README ("GitHub App authentication") separately, as root, writing the token file (mode 0640, group `fixcode`) to the path in `githubTokenFile`. Note `/run/fix-code-bridge/gh-token` in that README is an example; with this unit use a directory that is not recreated by the unit (the unit's `/run/<variant>` is owned by `fixcode` and shared with fetched secrets, so `/run/<variant>/gh-token` also works if the timer writes it after start). Claude via Vertex or Foundry: see the company README.

## Security notes

- Secrets live only in `/run` (tmpfs) and the secret store; never put them in `config.json`, `deploy.env` or cloud-init.
- No inbound ports; NSG/security groups should deny all inbound.
- Grant the identity read-only access to the specific vault or secrets (Key Vault Secrets User, not Officer).
- Secret files are 0600 owned by `fixcode`; `/run/<variant>` is 0750.
- `fetch-secrets.sh` never prints secret values and never passes them on command lines. `--dry-run` prints the commands only.
