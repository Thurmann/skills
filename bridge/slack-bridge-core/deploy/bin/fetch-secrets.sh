#!/bin/bash
# Fetch bridge secrets from a cloud secret store into /run/fix-code-secrets/<variant> (tmpfs).
# Usage: fetch-secrets.sh <variant> [--provider azure|aws|gcp|none] [--dry-run]
# Settings come from /etc/<variant>/deploy.env (root-owned, sourced):
#   FIX_CODE_SECRET_PROVIDER=azure|aws|gcp|none   (--provider flag wins; default azure)
#   AZURE_KEY_VAULT=<vault>   AWS_SECRET_PREFIX=<prefix>   GCP_PROJECT=<project>
#   REQUIRED_SECRETS="github-pat ..."   extra secrets that must exist (slack tokens always are)
#   GITHUB_TOKEN_SOURCE=external        a timer owns gh-token (company/app mode): never fetch or write it
# Layout (all root-owned so the unprivileged service user, and the coding agents it runs, cannot
# replace the files systemd loads as root):
#   /run/fix-code-secrets/            root:root 0711
#   /run/fix-code-secrets/<variant>/  root:fixcode 0750
#   .../secrets.env   root:root 0600     SLACK_BOT_TOKEN, SLACK_APP_TOKEN, optional ANTHROPIC_API_KEY
#                                        (systemd reads it as root; the bridge never opens it)
#   .../gh-token      root:fixcode 0640  optional github-pat (personal-cloud token file)
# As root the script re-executes itself under "env -i" with a fixed PATH, and ignores the
# FIX_CODE_DEPLOY_* / FIX_CODE_USER test overrides. FIX_CODE_SECRET_PROVIDER from the caller's
# environment is therefore NOT honoured as root: use --provider or deploy.env (root-owned).
# A secret is "absent" only on a confirmed not-found from the CLI. Any other failure aborts the
# run and leaves the existing files untouched.
set -euo pipefail

# Defense in depth: as root, drop whatever environment the unit passed (BASH_ENV, PATH, ...).
if [ "$(id -u)" = 0 ] && [ -z "${FIX_CODE_CLEAN_ENV:-}" ]; then
  exec /usr/bin/env -i FIX_CODE_CLEAN_ENV=1 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /bin/bash "$0" "$@"
fi

usage() { echo "Usage: $0 <variant> [--provider azure|aws|gcp|none] [--dry-run]" >&2; exit 2; }

variant=""
flag_provider=""
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --provider) [ $# -ge 2 ] || usage; flag_provider="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) [ -z "$variant" ] || usage; variant="$1"; shift ;;
  esac
done
[ -n "$variant" ] || usage
[[ "$variant" =~ ^[a-z0-9-]+$ ]] || { echo "Invalid variant name: $variant" >&2; exit 2; }

is_root=0
[ "$(id -u)" -ne 0 ] || is_root=1
if [ "$is_root" -eq 1 ]; then
  # Test overrides are for unprivileged runs only; as root they are never honoured.
  unset FIX_CODE_DEPLOY_ETC FIX_CODE_DEPLOY_RUN FIX_CODE_DEPLOY_CLI_PATH FIX_CODE_DEPLOY_CLI_HOME FIX_CODE_USER
fi
etc_root="${FIX_CODE_DEPLOY_ETC:-/etc}"
run_root="${FIX_CODE_DEPLOY_RUN:-/run}"
service_user="${FIX_CODE_USER:-fixcode}"
deploy_env="$etc_root/$variant/deploy.env"
secrets_root="$run_root/fix-code-secrets"
run_dir="$secrets_root/$variant"

file_stat() { stat -c '%u %a' "$1" 2>/dev/null || stat -f '%u %Lp' "$1"; }

# As root, only source files that root owns and nobody else can write.
check_root_owned() {
  local f="$1" owner mode
  read -r owner mode < <(file_stat "$f")
  if [ "$owner" != 0 ] || [ $(( 8#$mode & 8#022 )) -ne 0 ]; then
    echo "Refusing to source $f: must be owned by root and not group- or world-writable" >&2
    exit 1
  fi
}

if [ -f "$deploy_env" ]; then
  if [ "$is_root" -eq 1 ]; then
    check_root_owned "$deploy_env"
    check_root_owned "$(dirname "$deploy_env")"
  fi
  # shellcheck disable=SC1090
  . "$deploy_env"
fi

# Provider: --provider flag > FIX_CODE_SECRET_PROVIDER (environment or deploy.env) > azure.
provider="${flag_provider:-${FIX_CODE_SECRET_PROVIDER:-azure}}"
case "$provider" in azure|aws|gcp|none) ;; *) echo "Invalid provider: $provider" >&2; exit 2 ;; esac

if [ "$provider" = none ]; then
  echo "provider none: nothing to fetch for $variant"
  exit 0
fi

token_source="${GITHUB_TOKEN_SOURCE:-}"
required=(slack-bot-token slack-app-token)
# Split on whitespace without glob expansion (read does not expand patterns).
extra_required=()
read -r -a extra_required <<< "${REQUIRED_SECRETS:-}" || true
for s in ${extra_required[@]+"${extra_required[@]}"}; do
  case "$s" in
    github-pat|anthropic-api-key) required+=("$s") ;;
    slack-bot-token|slack-app-token) ;;
    *) echo "Invalid name in REQUIRED_SECRETS: $s" >&2; exit 2 ;;
  esac
done
is_required() { local s; for s in "${required[@]}"; do [ "$s" != "$1" ] || return 0; done; return 1; }
if [ "$token_source" = external ] && is_required github-pat; then
  echo "github-pat cannot be required when GITHUB_TOKEN_SOURCE=external" >&2; exit 2
fi
secrets=(slack-bot-token slack-app-token anthropic-api-key)
[ "$token_source" = external ] || secrets+=(github-pat)

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
  for name in "${secrets[@]}"; do
    echo "[dry-run] $(describe "$name")"
  done
  echo "[dry-run] write $run_dir/secrets.env (root:root 0600) and $run_dir/gh-token (root:$service_user 0640) atomically"
  exit 0
fi

umask 077
tmp_dir=""
cli_home_tmp=""
cleanup() {
  [ -z "$tmp_dir" ] || rm -rf "$tmp_dir"
  [ -z "$cli_home_tmp" ] || rm -rf "$cli_home_tmp"
}
trap cleanup EXIT

# The unit runs us as root (ExecStartPre=+) but with HOME=/var/lib/<variant>, a directory the
# unprivileged service user (and the coding agents it runs) can write. The cloud CLIs read
# config from HOME (~/.aws/config credential_process, ~/.azure extensions, gcloud config), so a
# planted file would run as root. Run every CLI with a root-only HOME and a scrubbed environment.
cli_home="${FIX_CODE_DEPLOY_CLI_HOME:-}"
if [ -z "$cli_home" ]; then
  if [ "$is_root" -eq 1 ]; then
    cli_home=/var/lib/fix-code-secrets
    mkdir -p "$cli_home"   # umask is 077; mode is enforced below
    [ ! -L "$cli_home" ] && [ -d "$cli_home" ] || { echo "$cli_home is not a plain directory" >&2; exit 1; }
    chown root:root "$cli_home"
    chmod 0700 "$cli_home"
  else
    cli_home_tmp="$(mktemp -d "${TMPDIR:-/tmp}/fix-code-cli-home.XXXXXX")"
    cli_home="$cli_home_tmp"
  fi
fi
export HOME="$cli_home"
unset AZURE_CONFIG_DIR AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE CLOUDSDK_CONFIG XDG_CONFIG_HOME
cli_path="${FIX_CODE_DEPLOY_CLI_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
passthrough=()
for v in AWS_REGION AWS_DEFAULT_REGION HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
  [ -z "${!v:-}" ] || passthrough+=("$v=${!v}")
done
cli() { env -i HOME="$cli_home" PATH="$cli_path" ${passthrough[@]+"${passthrough[@]}"} "$@"; }

case $provider in azure) cli_name=az;; aws) cli_name=aws;; gcp) cli_name=gcloud;; esac
PATH="$cli_path" command -v "$cli_name" >/dev/null \
  || { echo "CLI for provider $provider ($cli_name) is not installed" >&2; exit 1; }

case "$provider" in
  azure) [ -n "${AZURE_KEY_VAULT:-}" ] || { echo "AZURE_KEY_VAULT is not set in $deploy_env" >&2; exit 2; } ;;
  aws) [ -n "${AWS_SECRET_PREFIX:-}" ] || { echo "AWS_SECRET_PREFIX is not set in $deploy_env" >&2; exit 2; } ;;
  gcp) [ -n "${GCP_PROJECT:-}" ] || { echo "GCP_PROJECT is not set in $deploy_env" >&2; exit 2; } ;;
esac

# ensure_dir <path> <mode> <group>: create or tighten a directory. As root it refuses symlinks and
# directories owned by anyone else, then enforces root:<group> and the mode.
ensure_dir() {
  local d="$1" m="$2" g="$3" owner mode
  if [ "$is_root" -eq 1 ]; then
    [ ! -L "$d" ] || { echo "$d is a symlink" >&2; exit 1; }
    mkdir -p "$d"
    [ ! -L "$d" ] && [ -d "$d" ] || { echo "$d is not a plain directory" >&2; exit 1; }
    read -r owner mode < <(file_stat "$d")
    [ "$owner" = 0 ] || { echo "$d must be owned by root" >&2; exit 1; }
    chown "root:$g" "$d"
  else
    mkdir -p "$d"
  fi
  chmod "$m" "$d"
}
if [ "$is_root" -eq 1 ]; then root_group=root; dir_group="$service_user"; else root_group="$(id -gn)"; dir_group="$root_group"; fi
ensure_dir "$secrets_root" 0711 "$root_group"
ensure_dir "$run_dir" 0750 "$dir_group"
tmp_dir="$(mktemp -d "$run_dir/.fetch.XXXXXX")"

if [ "$provider" = azure ]; then
  if ! login_out="$(cli az login --identity --output none 2>&1)"; then
    echo "az login --identity failed: $login_out" >&2; exit 1
  fi
fi

# fetch_secret <name>: sets secret_value; returns 0 found, 1 confirmed absent; exits on any other failure.
secret_value=""
fetch_secret() {
  local name="$1" rc=0 err not_found=0
  secret_value=""
  case "$provider" in
    azure) secret_value="$(cli az keyvault secret show --vault-name "$AZURE_KEY_VAULT" --name "$name" --query value -o tsv 2>"$tmp_dir/err")" || rc=$? ;;
    aws) secret_value="$(cli aws secretsmanager get-secret-value --secret-id "$AWS_SECRET_PREFIX/$name" --query SecretString --output text 2>"$tmp_dir/err")" || rc=$? ;;
    gcp) secret_value="$(cli gcloud secrets versions access latest --secret="$name" --project="$GCP_PROJECT" 2>"$tmp_dir/err")" || rc=$? ;;
  esac
  err="$(cat "$tmp_dir/err")"
  rm -f "$tmp_dir/err"
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  secret_value=""
  case "$provider" in
    azure) case "$err" in *SecretNotFound*) not_found=1 ;; esac ;;
    aws) case "$err" in *ResourceNotFoundException*) not_found=1 ;; esac ;;
    gcp) case "$err" in *NOT_FOUND*) not_found=1 ;; esac ;;
  esac
  if [ "$not_found" -eq 1 ]; then
    if is_required "$name"; then
      echo "Required secret $name was not found in $provider: $err" >&2; exit 1
    fi
    return 1
  fi
  echo "Failed to fetch secret $name from $provider: $err" >&2
  exit 1
}

# Values are kept in variables val_<name> / has_<name> (no associative arrays: macOS bash 3.2).
val_slack_bot_token=""; val_slack_app_token=""; val_anthropic_api_key=""; val_github_pat=""
for name in "${secrets[@]}"; do
  key="${name//-/_}"
  printf -v "val_$key" '%s' ""
  printf -v "has_$key" '%s' ""
  if fetch_secret "$name"; then
    printf -v "val_$key" '%s' "$secret_value"
    [ -z "$secret_value" ] || printf -v "has_$key" '%s' 1
  fi
  hasvar="has_$key"
  if [ -z "${!hasvar}" ] && is_required "$name"; then
    echo "Required secret $name is empty or absent in $provider" >&2; exit 1
  fi
done
has_github_pat="${has_github_pat:-}"
has_anthropic_api_key="${has_anthropic_api_key:-}"

{
  printf 'SLACK_BOT_TOKEN=%s\n' "$val_slack_bot_token"
  printf 'SLACK_APP_TOKEN=%s\n' "$val_slack_app_token"
  if [ -n "$has_anthropic_api_key" ]; then printf 'ANTHROPIC_API_KEY=%s\n' "$val_anthropic_api_key"; fi
} > "$tmp_dir/secrets.env"
if [ "$token_source" != external ] && [ -n "$has_github_pat" ]; then
  printf '%s\n' "$val_github_pat" > "$tmp_dir/gh-token"
fi

# Everything was fetched: now replace the files.
for f in secrets.env gh-token; do
  [ -f "$tmp_dir/$f" ] || continue
  if [ "$f" = gh-token ]; then
    chmod 0640 "$tmp_dir/$f"
    if [ "$is_root" -eq 1 ]; then chown "root:$service_user" "$tmp_dir/$f"; fi
  else
    chmod 0600 "$tmp_dir/$f"
    if [ "$is_root" -eq 1 ]; then chown root:root "$tmp_dir/$f"; fi
  fi
  mv -f "$tmp_dir/$f" "$run_dir/$f"
done
# A confirmed-absent optional github-pat must not leave a stale token behind.
if [ "$token_source" != external ] && [ -z "$has_github_pat" ]; then rm -f "$run_dir/gh-token"; fi
echo "Fetched secrets for $variant from $provider into $run_dir"
