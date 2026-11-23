#!/usr/bin/env bash
# Provision an outbound-only Azure VM for a fix-code bridge variant.
# Usage: provision.sh --variant <dir> [--resource-group RG] [--location LOC] [--name NAME]
#                     [--vault NAME] [--foundry-resource NAME] [--repo-url URL] [--dry-run]
# The VM keeps the default public IP (needed for outbound access) but the NSG has no inbound
# rules (--nsg-rule NONE); the bridge uses Slack Socket Mode. Reach the VM with `az ssh vm`
# or Azure Bastion after temporarily allowing SSH if you need a shell.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
variant=""; rg=""; location="westeurope"; name=""; vault=""; foundry=""; dry=0
repo_url="https://github.com/Thurmann/skills.git"
while [ $# -gt 0 ]; do
  case "$1" in
    --variant) variant="${2:-}"; shift 2 ;;
    --resource-group) rg="${2:-}"; shift 2 ;;
    --location) location="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --vault) vault="${2:-}"; shift 2 ;;
    --foundry-resource) foundry="${2:-}"; shift 2 ;;
    --repo-url) repo_url="${2:-}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$variant" ] || { echo "--variant is required" >&2; exit 2; }
[[ "$variant" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid variant name: $variant" >&2; exit 2; }
[[ "$repo_url" =~ ^https://[A-Za-z0-9._/@:-]+$ ]] || { echo "Invalid repo URL" >&2; exit 2; }
name="${name:-$variant}"
rg="${rg:-rg-$name}"
suffix="$(printf '%s' "$name" | tr -cd 'a-z0-9' | cut -c1-14)"
vault="${vault:-kv-${suffix}}"
[[ "$name$rg$vault$location" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid name, group, vault or location" >&2; exit 2; }

if [ "$dry" -eq 1 ]; then
  run() { echo "[dry-run] $*"; }
else
  run() { "$@"; }
fi

rendered="$(mktemp "${TMPDIR:-/tmp}/fix-code-cloud-init.XXXXXX")"
trap 'rm -f "$rendered"' EXIT
sed -e "s|REPO_URL|$repo_url|g" -e "s|VARIANT|$variant|g" "$here/../cloud-init/fix-code-bridge.yaml" > "$rendered"

run az group create --name "$rg" --location "$location"
run az keyvault create --name "$vault" --resource-group "$rg" --location "$location" --enable-rbac-authorization true
run az vm create --resource-group "$rg" --name "$name" --image Ubuntu2404 --size Standard_B2s \
  --assign-identity --custom-data "$rendered" --nsg-rule NONE \
  --admin-username azureuser --generate-ssh-keys

if [ "$dry" -eq 1 ]; then
  principal="<principalId>"
  vault_scope="<vault-resource-id>"
  foundry_scope="<foundry-resource-id>"
else
  principal="$(az vm show --resource-group "$rg" --name "$name" --query identity.principalId -o tsv)"
  vault_scope="$(az keyvault show --name "$vault" --query id -o tsv)"
  foundry_scope=""
  [ -z "$foundry" ] || foundry_scope="$(az cognitiveservices account show --name "$foundry" --resource-group "$rg" --query id -o tsv)"
fi
[ "$dry" -eq 0 ] || echo "[dry-run] principalId=\$(az vm show --resource-group $rg --name $name --query identity.principalId -o tsv)"
run az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$vault_scope"
if [ -n "$foundry" ]; then
  run az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
    --role "Cognitive Services User" --scope "$foundry_scope"
fi

cat <<NEXT

Next steps (values are read from stdin or a file, never from argv):
  az keyvault secret set --vault-name $vault --name slack-bot-token --file ./slack-bot-token.txt
  # repeat for slack-app-token, optionally github-pat and anthropic-api-key; then delete the local files.
  # (or pipe: printf %s "\$TOKEN" | az keyvault secret set --vault-name $vault --name NAME --file /dev/stdin)
  (You need the Key Vault Secrets Officer role on the vault to set secrets.)
On the VM (az ssh vm --resource-group $rg --name $name):
  echo 'AZURE_KEY_VAULT=$vault' | sudo tee -a /etc/$variant/deploy.env
  sudoedit /etc/$variant/config.json    # copy from $variant/config.example.json
  sudo systemctl enable --now fix-code-bridge@$variant
  journalctl -u fix-code-bridge@$variant -f
NEXT
