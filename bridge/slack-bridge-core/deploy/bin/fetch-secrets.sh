#!/usr/bin/env bash
# Fetch bridge secrets from a cloud secret store into /run/<variant> (tmpfs).
# Usage: fetch-secrets.sh <variant> [--provider azure|aws|gcp|none] [--dry-run]
# Non-secret settings come from /etc/<variant>/deploy.env:
#   AZURE_KEY_VAULT=<vault>   AWS_SECRET_PREFIX=<prefix>   GCP_PROJECT=<project>
# Files written (owner fixcode, mode 0600):
#   /run/<variant>/secrets.env   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, optional ANTHROPIC_API_KEY
#   /run/<variant>/gh-token      optional github-pat (personal-cloud token file)
set -euo pipefail

usage() { echo "Usage: $0 <variant> [--provider azure|aws|gcp|none] [--dry-run]" >&2; exit 2; }

variant=""
provider="${FIX_CODE_SECRET_PROVIDER:-azure}"
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --provider) [ $# -ge 2 ] || usage; provider="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) [ -z "$variant" ] || usage; variant="$1"; shift ;;
  esac
done
[ -n "$variant" ] || usage
[[ "$variant" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid variant name: $variant" >&2; exit 2; }
case "$provider" in azure|aws|gcp|none) ;; *) echo "Invalid provider: $provider" >&2; exit 2 ;; esac

if [ "$provider" = none ]; then
  echo "provider none: nothing to fetch for $variant"
  exit 0
fi

etc_root="${FIX_CODE_DEPLOY_ETC:-/etc}"
run_root="${FIX_CODE_DEPLOY_RUN:-/run}"
service_user="${FIX_CODE_USER:-fixcode}"
deploy_env="$etc_root/$variant/deploy.env"
run_dir="$run_root/$variant"

if [ -f "$deploy_env" ]; then
  # shellcheck disable=SC1090
  . "$deploy_env"
fi

umask 077
tmp_dir=""
cleanup() { [ -z "$tmp_dir" ] || rm -rf "$tmp_dir"; }
trap cleanup EXIT

# get_secret <name>: print value on stdout (never echoed elsewhere); in dry-run print the command only.
get_secret() {
  local name="$1"
  case "$provider" in
    azure)
      [ -n "${AZURE_KEY_VAULT:-}" ] || { echo "AZURE_KEY_VAULT is not set in $deploy_env" >&2; return 2; }
      az keyvault secret show --vault-name "$AZURE_KEY_VAULT" --name "$name" --query value -o tsv ;;
    aws)
      [ -n "${AWS_SECRET_PREFIX:-}" ] || { echo "AWS_SECRET_PREFIX is not set in $deploy_env" >&2; return 2; }
      aws secretsmanager get-secret-value --secret-id "$AWS_SECRET_PREFIX/$name" --query SecretString --output text ;;
    gcp)
      [ -n "${GCP_PROJECT:-}" ] || { echo "GCP_PROJECT is not set in $deploy_env" >&2; return 2; }
      gcloud secrets versions access latest --secret="$name" --project="$GCP_PROJECT" ;;
  esac
}

describe() {
  local name="$1"
  case "$provider" in
    azure) echo "az keyvault secret show --vault-name ${AZURE_KEY_VAULT:-<AZURE_KEY_VAULT>} --name $name --query value -o tsv" ;;
    aws) echo "aws secretsmanager get-secret-value --secret-id ${AWS_SECRET_PREFIX:-<AWS_SECRET_PREFIX>}/$name --query SecretString --output text" ;;
    gcp) echo "gcloud secrets versions access latest --secret=$name --project=${GCP_PROJECT:-<GCP_PROJECT>}" ;;
  esac
}

if [ "$dry" -eq 1 ]; then
  echo "[dry-run] provider=$provider variant=$variant target=$run_dir (nothing is written)"
  [ "$provider" != azure ] || echo "[dry-run] az login --identity --output none"
  for name in slack-bot-token slack-app-token github-pat anthropic-api-key; do
    echo "[dry-run] $(describe "$name")"
  done
  echo "[dry-run] write $run_dir/secrets.env and $run_dir/gh-token atomically (mode 0600, owner $service_user)"
  exit 0
fi

command -v "$(case $provider in azure) echo az;; aws) echo aws;; gcp) echo gcloud;; esac)" >/dev/null \
  || { echo "CLI for provider $provider is not installed" >&2; exit 1; }

mkdir -p "$run_dir"
tmp_dir="$(mktemp -d "$run_dir/.fetch.XXXXXX")"

[ "$provider" != azure ] || az login --identity --output none

# Required secrets: a failure aborts before anything is replaced.
bot="$(get_secret slack-bot-token)"
app="$(get_secret slack-app-token)"
[ -n "$bot" ] && [ -n "$app" ] || { echo "Slack token secrets are empty" >&2; exit 1; }

# Optional secrets: a missing secret is skipped.
pat="$(get_secret github-pat 2>/dev/null || true)"
key="$(get_secret anthropic-api-key 2>/dev/null || true)"

{
  printf 'SLACK_BOT_TOKEN=%s\n' "$bot"
  printf 'SLACK_APP_TOKEN=%s\n' "$app"
  if [ -n "$key" ]; then printf 'ANTHROPIC_API_KEY=%s\n' "$key"; fi
} > "$tmp_dir/secrets.env"
if [ -n "$pat" ]; then printf '%s\n' "$pat" > "$tmp_dir/gh-token"; fi

for f in secrets.env gh-token; do
  [ -f "$tmp_dir/$f" ] || continue
  chmod 0600 "$tmp_dir/$f"
  if [ "$(id -u)" -eq 0 ]; then chown "$service_user:$service_user" "$tmp_dir/$f"; fi
  mv -f "$tmp_dir/$f" "$run_dir/$f"
done
echo "Fetched secrets for $variant from $provider into $run_dir"
