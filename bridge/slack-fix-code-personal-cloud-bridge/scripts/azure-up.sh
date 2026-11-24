#!/usr/bin/env bash
# Sets up the personal cloud bridge on Azure end to end: resource group, Key Vault with the
# secrets, an outbound-only VM (cloud-init from slack-bridge-core/deploy), the VM's config files,
# and the running systemd service. Slack IDs and tokens are reused from the local bridge
# (~/.config/fix-code-bridge/config.json and .env). Safe to rerun.
# Bash 3.2 compatible (macOS): no associative arrays, no ${x,,}, no mapfile.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
BRIDGE_DIR="$(cd -- "${PACKAGE_DIR}/.." && pwd)"
DEPLOY_DIR="${BRIDGE_DIR}/slack-bridge-core/deploy"
VARIANT="slack-fix-code-personal-cloud-bridge"

CONFIG_FILE="${SCRIPT_DIR}/azure.env"
CONFIG_FILE_SET=false
LOCAL_CONFIG="${HOME}/.config/fix-code-bridge/config.json"
SLACK_ENV="${HOME}/.config/fix-code-bridge/.env"
ASSUME_YES=false
DRY_RUN=false
PRINT_CONFIG=false
SKIP_SECRETS=false
START_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

CONFIG_KEYS="AZ_SUBSCRIPTION LOCATION RESOURCE_GROUP VM_NAME VM_SIZE KEY_VAULT REPO_URL \
GITHUB_OWNERS GIT_USER_NAME GIT_USER_EMAIL FOUNDRY_RESOURCE_ID ANTHROPIC_DEFAULT_OPUS_MODEL \
ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL INSTALL_CLAUDE_CLI"
SECRET_KEYS="SLACK_BOT_TOKEN SLACK_APP_TOKEN GITHUB_PAT ANTHROPIC_API_KEY"
TAG_PROJECT="project=fix-code-bridge"
TAG_MANAGED="managed-by=fix-code-azure-up"

CURRENT_STEP=""
MUTATION_STARTED=false
WORK_DIR=""

usage() {
  cat <<'EOF'
Usage: scripts/azure-up.sh [options]

Creates the personal cloud bridge on Azure: a resource group with an RBAC Key Vault
(slack-bot-token, slack-app-token, github-pat, optional anthropic-api-key) and an
outbound-only Ubuntu VM with a system-assigned identity. It then writes the bridge
config on the VM, installs the Claude CLI and starts fix-code-bridge@slack-fix-code-personal-cloud-bridge.

Reused from the local bridge:
  ~/.config/fix-code-bridge/config.json  teamId, allowedUsers, allowedChannels, operators,
                                         timeoutMs, maxRepairRounds, statusIntervalMs,
                                         repositoryRouting.allowedOwners/channelOwners
  ~/.config/fix-code-bridge/.env         SLACK_BOT_TOKEN, SLACK_APP_TOKEN
Optional settings come from scripts/azure.env (see scripts/azure.env.example).
Secrets never go there: GITHUB_PAT and ANTHROPIC_API_KEY come from the environment, or the
script asks for the PAT (hidden input). Secrets are piped to Key Vault, never put on argv.

Before anything is created, the script prints what it will create and what it costs, then
asks twice: "Continue? [y/N]" and the resource group name.

Options:
  --config FILE          Use FILE instead of scripts/azure.env (optional file).
  --bridge-config FILE   Local bridge config.json to reuse (default: ~/.config/fix-code-bridge/config.json).
  --slack-env FILE       .env with SLACK_BOT_TOKEN/SLACK_APP_TOKEN (default: ~/.config/fix-code-bridge/.env).
  --skip-secrets         Keep the secrets already in Key Vault; do not read or write them.
  --print-config         Print the config.json the VM will get and exit (no Azure calls).
  --dry-run              Run the read-only checks, print the plan and exit.
  --yes-i-understand     Skip both confirmations (automation only).
  -h, --help             Show this help.
EOF
}

log() { printf '%s\n' "$*" >&2; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}
section() {
  CURRENT_STEP="$*"
  printf '\n==> %s\n' "$*" >&2
}

on_exit() {
  local rc="$1"
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
  if ((rc != 0)) && [[ -n "$CURRENT_STEP" ]]; then
    printf '\nStopped during: %s (exit %s)\n' "$CURRENT_STEP" "$rc" >&2
    if "$MUTATION_STARTED"; then
      printf 'Azure resources may already exist and are billed until deleted.\n' >&2
      printf 'Fix the problem and rerun (the script is safe to rerun), or remove everything with: az group delete --name %s\n' "$RESOURCE_GROUP" >&2
    fi
  fi
}
on_interrupt() {
  printf '\nInterrupted. Operations already sent to Azure keep running on the Azure side.\n' >&2
  exit 130
}

while (($# > 0)); do
  case "$1" in
    --config)
      (($# > 1)) || fail "--config requires a file"
      CONFIG_FILE="$2"; CONFIG_FILE_SET=true; shift ;;
    --bridge-config)
      (($# > 1)) || fail "--bridge-config requires a file"
      LOCAL_CONFIG="$2"; shift ;;
    --slack-env)
      (($# > 1)) || fail "--slack-env requires a file"
      SLACK_ENV="$2"; shift ;;
    --skip-secrets) SKIP_SECRETS=true ;;
    --print-config) PRINT_CONFIG=true ;;
    --dry-run) DRY_RUN=true ;;
    --yes-i-understand) ASSUME_YES=true ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done

trap 'on_exit $?' EXIT
trap on_interrupt INT TERM
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fix-code-azure-up.XXXXXX")"

# --- configuration --------------------------------------------------------------------------

# Parses KEY=value lines without evaluating them. Variables already set in the environment win.
# With secrets_ok, only the secret keys are read (for the Slack .env); otherwise secrets are rejected.
parse_env_file() {
  local file="$1" mode="$2" line key value rest lineno=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    line="${line#export }"
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || fail "$file:$lineno: expected KEY=value"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$mode" == config ]]; then
      case " $SECRET_KEYS " in
        *" $key "*) fail "$file:$lineno: $key is a secret and must not be stored in the config file; export it instead" ;;
      esac
      case " $CONFIG_KEYS " in
        *" $key "*) ;;
        *) fail "$file:$lineno: unknown key $key" ;;
      esac
    else
      case "$key" in
        SLACK_BOT_TOKEN | SLACK_APP_TOKEN) ;;
        *) continue ;;
      esac
    fi
    case "$value" in
      \"*)
        rest="${value#\"}"
        [[ "$rest" == *\"* ]] || fail "$file:$lineno: unterminated quote"
        value="${rest%%\"*}" ;;
      \'*)
        rest="${value#\'}"
        [[ "$rest" == *\'* ]] || fail "$file:$lineno: unterminated quote"
        value="${rest%%\'*}" ;;
      *)
        value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')" ;;
    esac
    if [[ -n "${!key+x}" ]]; then
      if [[ "$mode" == config && "${!key}" != "$value" ]]; then
        warn "$key is set in the environment and overrides the config file; unset it to use the file"
      fi
      continue
    fi
    printf -v "$key" '%s' "$value"
  done <"$file"
}

load_config() {
  if [[ -f "$CONFIG_FILE" ]]; then
    parse_env_file "$CONFIG_FILE" config
    log "Settings: $CONFIG_FILE"
  elif "$CONFIG_FILE_SET"; then
    fail "config file not found: $CONFIG_FILE"
  else
    log "Settings: defaults ($CONFIG_FILE does not exist; see scripts/azure.env.example)"
  fi
  : "${LOCATION:=swedencentral}"
  : "${RESOURCE_GROUP:=rg-fix-code-cloud}"
  : "${VM_NAME:=vm-fix-code-cloud}"
  : "${VM_SIZE:=Standard_B2s}"
  : "${REPO_URL:=https://github.com/Thurmann/skills.git}"
  : "${INSTALL_CLAUDE_CLI:=true}"
  : "${AZ_SUBSCRIPTION:=}" "${KEY_VAULT:=}" "${GITHUB_OWNERS:=}" "${GIT_USER_NAME:=}" "${GIT_USER_EMAIL:=}"
  : "${FOUNDRY_RESOURCE_ID:=}" "${ANTHROPIC_DEFAULT_OPUS_MODEL:=}" "${ANTHROPIC_DEFAULT_SONNET_MODEL:=}" "${ANTHROPIC_DEFAULT_HAIKU_MODEL:=}"

  [[ "$LOCATION" =~ ^[a-z0-9]{2,30}$ ]] || fail "invalid LOCATION: $LOCATION"
  [[ "$RESOURCE_GROUP" =~ ^[A-Za-z0-9._()-]{1,90}$ ]] || fail "invalid RESOURCE_GROUP: $RESOURCE_GROUP"
  [[ "$VM_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,62}$ ]] || fail "invalid VM_NAME: $VM_NAME"
  [[ "$VM_SIZE" =~ ^[A-Za-z0-9_]{3,64}$ ]] || fail "invalid VM_SIZE: $VM_SIZE"
  [[ "$REPO_URL" =~ ^https://[A-Za-z0-9._/@:-]+$ ]] || fail "invalid REPO_URL (https only): $REPO_URL"
  [[ "$INSTALL_CLAUDE_CLI" == true || "$INSTALL_CLAUDE_CLI" == false ]] || fail "INSTALL_CLAUDE_CLI must be true or false"
  if [[ -n "$KEY_VAULT" ]]; then
    [[ "$KEY_VAULT" =~ ^[A-Za-z][A-Za-z0-9-]{2,23}$ ]] || fail "invalid KEY_VAULT (3-24 chars, letters, digits and hyphens, starting with a letter): $KEY_VAULT"
  fi
  if [[ -n "$FOUNDRY_RESOURCE_ID" ]]; then
    [[ "$FOUNDRY_RESOURCE_ID" =~ ^/subscriptions/[A-Za-z0-9-]+/resourceGroups/[A-Za-z0-9._()-]+/providers/Microsoft\.CognitiveServices/accounts/([A-Za-z0-9._-]+)$ ]] ||
      fail "invalid FOUNDRY_RESOURCE_ID (expected the full ARM id of a Microsoft.CognitiveServices account)"
    FOUNDRY_RESOURCE="${BASH_REMATCH[1]}"
  fi
  local v
  for v in ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL; do
    [[ -z "${!v}" || "${!v}" =~ ^[A-Za-z0-9._:/-]{1,100}$ ]] || fail "invalid $v"
  done
  [[ "$GIT_USER_NAME" != *$'\n'* && "$GIT_USER_EMAIL" =~ ^[^[:space:]]*$ ]] || fail "invalid GIT_USER_NAME or GIT_USER_EMAIL"
}

# Fills GITHUB_OWNERS, GIT_USER_NAME and GIT_USER_EMAIL from the local config or `gh api user`.
resolve_github_identity() {
  local owners login="" id="" name="" out
  if [[ -z "$GITHUB_OWNERS" ]]; then
    owners="$(python3 -I -c 'import json,sys; print(",".join(json.load(open(sys.argv[1])).get("repositoryRouting",{}).get("allowedOwners",[])))' "$LOCAL_CONFIG")"
    GITHUB_OWNERS="$owners"
  fi
  if [[ -z "$GITHUB_OWNERS" || -z "$GIT_USER_NAME" || -z "$GIT_USER_EMAIL" ]]; then
    command -v gh >/dev/null 2>&1 || fail "set GITHUB_OWNERS, GIT_USER_NAME and GIT_USER_EMAIL, or install and log in to gh so they can be detected"
    out="$(gh api user --jq '[.login, (.id|tostring), (.name // "")] | @tsv' 2>/dev/null)" ||
      fail "could not read your GitHub user with gh; run gh auth login, or set GITHUB_OWNERS, GIT_USER_NAME and GIT_USER_EMAIL"
    IFS=$'\t' read -r login id name <<<"$out"
    [[ -n "$GITHUB_OWNERS" ]] || GITHUB_OWNERS="$login"
    [[ -n "$GIT_USER_NAME" ]] || GIT_USER_NAME="${name:-$login}"
    [[ -n "$GIT_USER_EMAIL" ]] || GIT_USER_EMAIL="${id}+${login}@users.noreply.github.com"
  fi
  GITHUB_OWNERS="$(printf '%s' "$GITHUB_OWNERS" | tr -d '[:space:]')"
  [[ "$GITHUB_OWNERS" =~ ^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$ ]] || fail "invalid GITHUB_OWNERS: $GITHUB_OWNERS"
}

# Writes $WORK_DIR/config.json: config.example.json with the local bridge's Slack settings.
render_bridge_config() {
  [[ -f "$LOCAL_CONFIG" ]] || fail "local bridge config not found: $LOCAL_CONFIG (use --bridge-config)"
  resolve_github_identity
  python3 -I - "$PACKAGE_DIR/config.example.json" "$LOCAL_CONFIG" "$GITHUB_OWNERS" >"$WORK_DIR/config.json" <<'PY'
import json, re, sys
example, local_path, owners = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(example))
local = json.load(open(local_path))
def need(cond, msg):
    if not cond:
        sys.exit("Error: " + local_path + ": " + msg)
need(isinstance(local.get("teamId"), str) and re.fullmatch(r"T[A-Z0-9]+", local["teamId"]), "teamId must be a Slack team id (T...)")
need(isinstance(local.get("allowedUsers"), list) and local["allowedUsers"], "allowedUsers must be a nonempty list")
need(isinstance(local.get("allowedChannels"), list) and local["allowedChannels"], "allowedChannels must be a nonempty list")
for key in ("teamId", "allowedUsers", "allowedChannels", "operators", "timeoutMs", "maxRepairRounds", "statusIntervalMs"):
    if key in local:
        cfg[key] = local[key]
routing = cfg["repositoryRouting"]
routing["allowedOwners"] = [o for o in owners.split(",") if o]
channel_owners = (local.get("repositoryRouting") or {}).get("channelOwners") or {}
if channel_owners:
    routing["channelOwners"] = channel_owners
text = json.dumps(cfg, indent=2) + "\n"
need("REPLACE" not in text and "your-github-user" not in text, "a placeholder is left in the rendered config")
sys.stdout.write(text)
PY
  # Validate with the bridge's own loader (pure checks, no files written).
  node --input-type=module -e '
    const [core, profile, file] = process.argv.slice(1);
    const { createConfigApi } = await import(core);
    createConfigApi((await import(profile)).default).loadConfig(file);
  ' "$BRIDGE_DIR/slack-bridge-core/src/config.js" "$PACKAGE_DIR/src/profile.js" "$WORK_DIR/config.json" ||
    fail "the rendered config.json is rejected by the bridge (see the message above)"
}

read_slack_tokens() {
  if [[ -z "${SLACK_BOT_TOKEN:-}" || -z "${SLACK_APP_TOKEN:-}" ]]; then
    [[ -f "$SLACK_ENV" ]] || fail "Slack tokens not found: $SLACK_ENV does not exist and SLACK_BOT_TOKEN/SLACK_APP_TOKEN are not set (use --slack-env)"
    parse_env_file "$SLACK_ENV" slack
  fi
  [[ "${SLACK_BOT_TOKEN:-}" == xoxb-* ]] || fail "SLACK_BOT_TOKEN in $SLACK_ENV is missing or not a bot token (xoxb-...)"
  [[ "${SLACK_APP_TOKEN:-}" == xapp-* ]] || fail "SLACK_APP_TOKEN in $SLACK_ENV is missing or not an app-level token (xapp-...)"
}

read_github_pat() {
  if [[ -z "${GITHUB_PAT:-}" ]]; then
    [[ -t 0 ]] || fail "GITHUB_PAT is not set and there is no terminal to ask for it; export it or use --skip-secrets"
    printf 'Fine-grained GitHub token for the bridge (input hidden): ' >&2
    IFS= read -r -s GITHUB_PAT || GITHUB_PAT=""
    printf '\n' >&2
  fi
  [[ -n "$GITHUB_PAT" && "$GITHUB_PAT" != *[[:space:]]* ]] || fail "GITHUB_PAT must be a single token without spaces"
  [[ "$GITHUB_PAT" == github_pat_* ]] || warn "GITHUB_PAT is not a fine-grained token (github_pat_...); the README recommends one limited to the bridge's repositories"
}

# --- Azure ----------------------------------------------------------------------------------

interactive_ok() { [[ -t 0 || "${AZURE_SCRIPTS_ALLOW_NON_TTY:-}" == 1 ]]; }

confirm_double() {
  local expected="$1" answer typed
  if "$ASSUME_YES"; then
    log "Confirmation skipped by --yes-i-understand."
    return 0
  fi
  interactive_ok || fail "confirmation requires a terminal; use --yes-i-understand for automation"
  printf '\nContinue? [y/N] ' >&2
  IFS= read -r answer || answer=""
  [[ "$answer" =~ ^[Yy]$ ]] || { log "Cancelled. Nothing was changed."; exit 0; }
  printf 'Type the resource group name (%s) to confirm: ' "$expected" >&2
  IFS= read -r typed || typed=""
  [[ "$typed" == "$expected" ]] || { log "Name did not match. Cancelled. Nothing was changed."; exit 1; }
}

lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

sha_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-6
}

# Fails early when the VM size is blocked for this subscription in the region or the quota is full.
check_vm_size() {
  local out family restricted cpus usage free
  log "Checking that $VM_SIZE is available in $LOCATION (can take a minute)"
  out="$(az vm list-skus --location "$LOCATION" --size "$VM_SIZE" --all \
    --query "[?name=='${VM_SIZE}'] | [0].[family, length(restrictions[?type=='Location']), capabilities[?name=='vCPUs'].value | [0]]" \
    --output tsv 2>/dev/null || true)"
  IFS=$'\t' read -r family restricted cpus <<<"$out" || true
  if [[ -z "$family" ]]; then
    warn "could not look up $VM_SIZE in $LOCATION; check the size name and region"
    return 0
  fi
  if [[ "$restricted" =~ ^[0-9]+$ ]] && ((restricted > 0)); then
    fail "$VM_SIZE is not available for this subscription in $LOCATION; choose another LOCATION or VM_SIZE"
  fi
  [[ "$cpus" =~ ^[0-9]+$ ]] || cpus=2
  usage="$(az vm list-usage --location "$LOCATION" --query '[].[name.value,currentValue,limit]' --output tsv 2>/dev/null || true)"
  if [[ -z "$usage" ]]; then
    warn "could not read the vCPU quota in $LOCATION; $cpus vCPU of $family are needed"
    return 0
  fi
  free="$(awk -v f="$family" 'tolower($1) == tolower(f) { print $3 - $2; exit }' <<<"$usage")"
  if [[ "$free" =~ ^-?[0-9]+$ ]] && ((free < cpus)); then
    fail "only $free free vCPU in the $family quota in $LOCATION; $cpus are needed. Request more quota, or choose another VM_SIZE or LOCATION"
  fi
}

exists_label() { if [[ "$1" == true ]]; then printf '[exists, reused]'; else printf '[new]'; fi; }

preflight() {
  local out state tag
  section "Checking the Azure account and existing resources (read-only)"
  out="$(az account show --query '[id,name,tenantId,user.name]' --output tsv 2>/dev/null)" || fail "not logged in to Azure; run: az login"
  { IFS= read -r SUB_ID; IFS= read -r SUB_NAME; IFS= read -r TENANT_ID; IFS= read -r AZ_USER; } <<<"$out"
  if [[ -n "$AZ_SUBSCRIPTION" && "$AZ_SUBSCRIPTION" != "$SUB_NAME" && "$(lowercase "$AZ_SUBSCRIPTION")" != "$(lowercase "$SUB_ID")" ]]; then
    fail "the selected subscription is '$SUB_NAME' ($SUB_ID), not '$AZ_SUBSCRIPTION'; run: az account set --subscription \"$AZ_SUBSCRIPTION\""
  fi
  # A stable default vault name, so reruns find the same vault.
  [[ -n "$KEY_VAULT" ]] || KEY_VAULT="kv-fixcode-$(printf '%s/%s' "$SUB_ID" "$RESOURCE_GROUP" | sha_hex)"

  RG_EXISTS="$(az group exists --name "$RESOURCE_GROUP" --output tsv 2>/dev/null || true)"
  [[ "$RG_EXISTS" == true ]] || RG_EXISTS=false
  VAULT_EXISTS=false
  VM_EXISTS=false
  if "$RG_EXISTS"; then
    state="$(az group show --name "$RESOURCE_GROUP" --query 'properties.provisioningState' --output tsv 2>/dev/null || true)"
    [[ "$state" != Deleting ]] || fail "a previous deletion of $RESOURCE_GROUP is still running; wait until it finishes, then rerun"
    tag="$(az group show --name "$RESOURCE_GROUP" --query 'tags."managed-by"' --output tsv 2>/dev/null || true)"
    [[ "$tag" == "${TAG_MANAGED#managed-by=}" ]] ||
      fail "resource group $RESOURCE_GROUP exists but was not created by this script (tag managed-by is '${tag:-missing}'); choose another RESOURCE_GROUP"
    if az keyvault show --name "$KEY_VAULT" --resource-group "$RESOURCE_GROUP" --query id --output tsv >/dev/null 2>&1; then VAULT_EXISTS=true; fi
    if az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --query id --output tsv >/dev/null 2>&1; then VM_EXISTS=true; fi
  fi
  "$VM_EXISTS" || check_vm_size
  if ! "$VAULT_EXISTS"; then
    out="$(az keyvault list-deleted --query "[?name=='$KEY_VAULT'].name" --output tsv 2>/dev/null || true)"
    [[ -z "$out" ]] || fail "Key Vault $KEY_VAULT is soft-deleted; recover it (az keyvault recover --name $KEY_VAULT) or purge it, or set KEY_VAULT to another name"
  fi
  if [[ -n "$FOUNDRY_RESOURCE_ID" ]]; then
    az resource show --ids "$FOUNDRY_RESOURCE_ID" --query id --output tsv >/dev/null 2>&1 ||
      fail "FOUNDRY_RESOURCE_ID not found or not readable: $FOUNDRY_RESOURCE_ID"
  fi
  # cloud-init clones the repository without credentials.
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote "$REPO_URL" HEAD >/dev/null 2>&1 ||
    fail "$REPO_URL cannot be cloned anonymously; the VM's cloud-init needs a public repository URL (REPO_URL)"
}

print_summary() {
  local channels secrets
  channels="$(python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); print(", ".join(c["allowedChannels"]))' "$WORK_DIR/config.json")"
  if "$SKIP_SECRETS"; then
    secrets="kept as they are (--skip-secrets)"
  else
    secrets="slack-bot-token, slack-app-token, github-pat"
    [[ -z "${ANTHROPIC_API_KEY:-}" ]] || secrets="$secrets, anthropic-api-key"
  fi
  log ""
  log "================================================================================"
  log "WHAT THIS WILL CREATE"
  log "================================================================================"
  log "Subscription : $SUB_NAME ($SUB_ID)"
  log "Tenant       : $TENANT_ID"
  log "Signed in as : $AZ_USER"
  log "Region       : $LOCATION"
  log "Slack        : team $(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["teamId"])' "$WORK_DIR/config.json"), channels $channels"
  log "               (from $LOCAL_CONFIG; tokens from $SLACK_ENV)"
  log "GitHub       : owners $GITHUB_OWNERS, commits as $GIT_USER_NAME <$GIT_USER_EMAIL>"
  log "Repository   : $REPO_URL (cloned to /opt/fix-code on the VM)"
  log ""
  log "Resource group $RESOURCE_GROUP  $(exists_label "$RG_EXISTS")"
  log "  - Key Vault $KEY_VAULT  $(exists_label "$VAULT_EXISTS")"
  log "      RBAC authorization; you get Key Vault Secrets Officer on it to write the secrets"
  log "      Secrets: $secrets"
  log "  - VM $VM_NAME  $(exists_label "$VM_EXISTS")"
  log "      $VM_SIZE, Ubuntu 24.04, system-assigned identity, public IP for outbound only,"
  log "      NSG without inbound rules; cloud-init from slack-bridge-core/deploy/cloud-init"
  log "      Role: Key Vault Secrets User on $KEY_VAULT"
  if [[ -n "$FOUNDRY_RESOURCE_ID" ]]; then
    log "      Role: Cognitive Services User on Foundry resource $FOUNDRY_RESOURCE (Claude via Foundry)"
  elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    log "      Claude via ANTHROPIC_API_KEY (stored as anthropic-api-key)"
  else
    log "      Claude credentials: none given (set FOUNDRY_RESOURCE_ID or export ANTHROPIC_API_KEY);"
    log "      tasks fail until an anthropic-api-key secret exists or Foundry is configured"
  fi
  log "  - On the VM: /etc/$VARIANT/{config.json,deploy.env,bridge.env}, git identity,"
  log "    $("$INSTALL_CLAUDE_CLI" && printf 'the Claude CLI, ')and the service fix-code-bridge@$VARIANT (enabled and started)"
  if "$VM_EXISTS"; then
    log "    The existing VM is reconfigured; cloud-init is not run again."
  fi
  log ""
  log "SLACK: the tokens belong to the app your local bridge uses. Socket Mode spreads events"
  log "  over all connections of an app, so stop the local bridge while the cloud bridge runs,"
  log "  or create a separate app from $VARIANT/slack-app-manifest.json and pass its"
  log "  tokens with --slack-env."
  log ""
  log "COST (approximate list prices; check the Azure pricing calculator for your region)"
  log "  About \$40 per month (\$1.30 per day) while the VM exists: $VM_SIZE about \$30,"
  log "  OS disk about \$5, public IP about \$3.60, Key Vault a few cents. Model usage is billed"
  log "  separately. Deallocating the VM (az vm deallocate) stops the compute cost."
  log "  Remove everything with: az group delete --name $RESOURCE_GROUP"
  log ""
  log "TIME: about 10-15 minutes for a new VM."
  log "================================================================================"
}

tags() { printf '%s %s' "$TAG_PROJECT" "$TAG_MANAGED"; }

# Creates a role assignment unless the same one already exists.
ensure_role() {
  local assignee="$1" type="$2" role="$3" scope="$4" count
  count="$(az role assignment list --assignee "$assignee" --role "$role" --scope "$scope" --query 'length(@)' --output tsv 2>/dev/null || echo 0)"
  if [[ "$count" != 0 ]]; then
    log "Role '$role' already assigned."
    return 0
  fi
  az role assignment create --assignee-object-id "$assignee" --assignee-principal-type "$type" \
    --role "$role" --scope "$scope" --output none
}

# Pipes a secret value to Key Vault (never on argv). Retries while a new role assignment propagates.
set_secret() {
  local name="$1" value="$2" attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if printf '%s' "$value" | az keyvault secret set --vault-name "$KEY_VAULT" --name "$name" --file /dev/stdin --output none 2>"$WORK_DIR/kv.err"; then
      log "Stored $name."
      return 0
    fi
    if grep -Eq 'Forbidden|not authorized' "$WORK_DIR/kv.err" && ((attempt < 12)); then
      log "Waiting for the Key Vault role to take effect ($attempt/12)..."
      sleep 15
      continue
    fi
    cat "$WORK_DIR/kv.err" >&2
    fail "could not store $name in $KEY_VAULT"
  done
}

create_group_and_vault() {
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags $(tags) --output none
  if ! "$VAULT_EXISTS"; then
    az keyvault create --name "$KEY_VAULT" --resource-group "$RESOURCE_GROUP" --location "$LOCATION" \
      --enable-rbac-authorization true --tags $(tags) --output none
  fi
  VAULT_ID="$(az keyvault show --name "$KEY_VAULT" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
}

store_secrets() {
  local me
  me="$(az ad signed-in-user show --query id --output tsv 2>/dev/null)" ||
    fail "could not read your Entra object id (az ad signed-in-user show); service principal logins must grant themselves Key Vault Secrets Officer on $KEY_VAULT"
  ensure_role "$me" User "Key Vault Secrets Officer" "$VAULT_ID"
  set_secret slack-bot-token "$SLACK_BOT_TOKEN"
  set_secret slack-app-token "$SLACK_APP_TOKEN"
  set_secret github-pat "$GITHUB_PAT"
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    set_secret anthropic-api-key "$ANTHROPIC_API_KEY"
  fi
}

create_vm() {
  if "$VM_EXISTS"; then
    log "VM $VM_NAME exists; reusing it."
  else
    sed -e "s|REPO_URL|$REPO_URL|g" -e "s|VARIANT|$VARIANT|g" "$DEPLOY_DIR/cloud-init/fix-code-bridge.yaml" >"$WORK_DIR/cloud-init.yaml"
    az vm create --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --location "$LOCATION" \
      --image Ubuntu2404 --size "$VM_SIZE" --assign-identity --custom-data "$WORK_DIR/cloud-init.yaml" \
      --nsg-rule NONE --admin-username azureuser --generate-ssh-keys --tags $(tags) --output none
  fi
  PRINCIPAL_ID="$(az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --query identity.principalId --output tsv)"
  [[ -n "$PRINCIPAL_ID" ]] || fail "VM $VM_NAME has no system-assigned identity; run: az vm identity assign --resource-group $RESOURCE_GROUP --name $VM_NAME"
  ensure_role "$PRINCIPAL_ID" ServicePrincipal "Key Vault Secrets User" "$VAULT_ID"
  if [[ -n "$FOUNDRY_RESOURCE_ID" ]]; then
    ensure_role "$PRINCIPAL_ID" ServicePrincipal "Cognitive Services User" "$FOUNDRY_RESOURCE_ID"
  fi
}

# Runs a local script file on the VM as root and prints its output (run-command hides the exit code).
vm_run() {
  az vm run-command invoke --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --command-id RunShellScript \
    --scripts "@$1" --query 'value[0].message' --output tsv
}

wait_cloud_init() {
  local out
  printf '%s\n' '#!/bin/bash' 'cloud-init status --wait >/dev/null 2>&1 || true' 'cloud-init status' >"$WORK_DIR/wait.sh"
  out="$(vm_run "$WORK_DIR/wait.sh")"
  if [[ "$out" != *"status: done"* ]]; then
    printf '%s\n' "$out" >&2
    fail "cloud-init did not finish cleanly; inspect /var/log/cloud-init-output.log on the VM (az vm run-command invoke ... --scripts 'tail -n 100 /var/log/cloud-init-output.log')"
  fi
  log "cloud-init finished."
}

b64() { base64 <"$1" | tr -d '\n'; }

# Writes the VM-side setup script. It embeds only non-secret values, base64-encoded so nothing
# is interpreted by the shell.
render_setup_script() {
  printf 'AZURE_KEY_VAULT=%s\nFIX_CODE_SECRET_PROVIDER=azure\nREQUIRED_SECRETS="github-pat"\n' "$KEY_VAULT" >"$WORK_DIR/deploy.env"
  {
    printf '# Written by scripts/azure-up.sh. Non-secret settings only.\n'
    if [[ -n "$FOUNDRY_RESOURCE_ID" ]]; then
      printf 'CLAUDE_CODE_USE_FOUNDRY=1\nANTHROPIC_FOUNDRY_RESOURCE=%s\n' "$FOUNDRY_RESOURCE"
      [[ -z "$ANTHROPIC_DEFAULT_OPUS_MODEL" ]] || printf 'ANTHROPIC_DEFAULT_OPUS_MODEL=%s\n' "$ANTHROPIC_DEFAULT_OPUS_MODEL"
      [[ -z "$ANTHROPIC_DEFAULT_SONNET_MODEL" ]] || printf 'ANTHROPIC_DEFAULT_SONNET_MODEL=%s\n' "$ANTHROPIC_DEFAULT_SONNET_MODEL"
      [[ -z "$ANTHROPIC_DEFAULT_HAIKU_MODEL" ]] || printf 'ANTHROPIC_DEFAULT_HAIKU_MODEL=%s\n' "$ANTHROPIC_DEFAULT_HAIKU_MODEL"
    fi
  } >"$WORK_DIR/bridge.env"
  printf '%s' "$GIT_USER_NAME" >"$WORK_DIR/git-name"
  printf '%s' "$GIT_USER_EMAIL" >"$WORK_DIR/git-email"
  cat >"$WORK_DIR/setup.sh" <<EOF
#!/bin/bash
set -euo pipefail
export HOME=/root
v=$VARIANT
put() { printf '%s' "\$2" | base64 -d >"/etc/\$v/\$1.new"; chown root:fixcode "/etc/\$v/\$1.new"; chmod 0640 "/etc/\$v/\$1.new"; mv "/etc/\$v/\$1.new" "/etc/\$v/\$1"; }
put config.json '$(b64 "$WORK_DIR/config.json")'
put deploy.env '$(b64 "$WORK_DIR/deploy.env")'
put bridge.env '$(b64 "$WORK_DIR/bridge.env")'
gc=/var/lib/\$v/.gitconfig
git config --file "\$gc" user.name "\$(printf '%s' '$(b64 "$WORK_DIR/git-name")' | base64 -d)"
git config --file "\$gc" user.email "\$(printf '%s' '$(b64 "$WORK_DIR/git-email")' | base64 -d)"
chown fixcode:fixcode "\$gc"
if [ "$INSTALL_CLAUDE_CLI" = true ] && ! command -v claude >/dev/null 2>&1; then
  npm install -g --silent @anthropic-ai/claude-code >/dev/null
fi
systemctl enable "fix-code-bridge@\$v" >/dev/null 2>&1
systemctl restart "fix-code-bridge@\$v" || true
# A new identity's Key Vault role can take minutes to apply; the unit restarts until then.
for i in \$(seq 1 18); do
  sleep 10
  state=\$(systemctl is-active "fix-code-bridge@\$v" || true)
  [ "\$state" = active ] && [ "\$i" -ge 2 ] && break
done
echo "SERVICE_STATE=\$state"
journalctl -u "fix-code-bridge@\$v" -n 15 --no-pager -o cat || true
[ "\$state" = active ] && echo FIX_CODE_SETUP_OK
EOF
}

configure_vm() {
  local out
  render_setup_script
  out="$(vm_run "$WORK_DIR/setup.sh")"
  printf '%s\n' "$out" >&2
  [[ "$out" == *FIX_CODE_SETUP_OK* ]] || fail "the bridge service is not running on the VM; see the log lines above"
}

print_result() {
  log ""
  log "================================================================================"
  log "DONE. Started $START_TIME, finished $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  log "  Service : fix-code-bridge@$VARIANT on $VM_NAME is running"
  log "  Vault   : $KEY_VAULT"
  log "  Logs    : az vm run-command invoke -g $RESOURCE_GROUP -n $VM_NAME --command-id RunShellScript \\"
  log "              --scripts 'journalctl -u fix-code-bridge@$VARIANT -n 50 --no-pager' --query 'value[0].message' -o tsv"
  log "  Test    : mention the bot in an allowed Slack channel with a harmless task"
  log "  Rerun this script after changing the local config or tokens; it updates the VM in place."
  log "  Cost    : about \$40 per month. Remove everything with: az group delete --name $RESOURCE_GROUP"
  log "================================================================================"
}

# --- main -------------------------------------------------------------------------------------

section "Reading configuration"
for tool in python3 node git; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done
load_config
render_bridge_config

if "$PRINT_CONFIG"; then
  cat "$WORK_DIR/config.json"
  CURRENT_STEP=""
  exit 0
fi

command -v az >/dev/null 2>&1 || fail "missing required tool: az (Azure CLI)"
if ! "$SKIP_SECRETS"; then
  read_slack_tokens
fi
if ! "$DRY_RUN" && ! "$ASSUME_YES"; then
  interactive_ok || fail "confirmation requires a terminal; use --yes-i-understand for automation"
fi

preflight
print_summary
if "$DRY_RUN"; then
  log "Dry run: nothing was changed."
  CURRENT_STEP=""
  exit 0
fi

section "Confirmation"
confirm_double "$RESOURCE_GROUP"
if ! "$SKIP_SECRETS"; then
  section "Reading the GitHub token"
  read_github_pat
fi

MUTATION_STARTED=true
section "Creating the resource group and Key Vault"
create_group_and_vault
if ! "$SKIP_SECRETS"; then
  section "Storing the secrets in Key Vault"
  store_secrets
fi
section "Creating the VM and its role assignments"
create_vm
section "Waiting for cloud-init on the VM (installs git, gh, Node, the repository)"
wait_cloud_init
section "Configuring and starting the bridge on the VM"
configure_vm
CURRENT_STEP=""
print_result
