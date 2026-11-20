#!/usr/bin/env bash
# List open GitHub pull requests for every git repo found under the given folders.
#
# Usage: open-prs.sh [options] [dir ...]
#   -h, --help    show this help
#
# Folders are searched recursively (default: the current directory); node_modules
# is skipped. Repos sharing a GitHub remote are checked once. Needs an
# authenticated gh CLI. In a terminal each "PR#N" is a clickable link; otherwise
# the URL is printed after the title.

set -uo pipefail

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

DIRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)  usage 0 ;;
    -*)         echo "Unknown option: $1" >&2; usage 1 ;;
    *)          DIRS+=("$1") ;;
  esac
  shift
done
[ ${#DIRS[@]} -eq 0 ] && DIRS=(.)

if [ -t 1 ]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RESET=$'\e[0m' LINKS=1
else
  BOLD="" DIM="" RESET="" LINKS=0
fi

command -v gh >/dev/null 2>&1 || { echo "gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated; run: gh auth login" >&2; exit 1; }

# GitHub remote URL -> owner/name, or nothing for other hosts.
github_slug() {
  local url="${1%/}"
  url="${url%.git}"
  case "$url" in
    git@github.com:*)                   echo "${url#git@github.com:}" ;;
    https://github.com/*|ssh://git@github.com/*|git://github.com/*)
                                        echo "${url#*github.com/}" ;;
  esac
}

# Unique GitHub repos (owner/name) of all checkouts under DIRS. Linked worktrees
# have a .git file instead of a directory, so they are not listed twice.
REPOS=()
while IFS= read -r slug; do REPOS+=("$slug"); done < <(
  for dir in "${DIRS[@]}"; do
    [ -d "$dir" ] || { echo "Skipping missing folder: $dir" >&2; continue; }
    find "$dir" -name node_modules -prune -o -type d -name .git -print -prune 2>/dev/null
  done | while IFS= read -r gitdir; do
    github_slug "$(git -C "$(dirname "$gitdir")" remote get-url origin 2>/dev/null)"
  done | sort -fu
)
[ ${#REPOS[@]} -eq 0 ] && { echo "No GitHub repos found."; exit 0; }

# One "owner/name<TAB>number<TAB>title<TAB>url" line per open PR, 8 repos at a time.
PRS="$(printf '%s\n' "${REPOS[@]}" | xargs -P 8 -I{} sh -c \
  'gh pr list --repo "$1" --state open --limit 1000 --json number,title,url \
     --jq ".[] | [\"$1\", .number, .title, .url] | @tsv" 2>/dev/null \
   || echo "Could not list PRs for $1 (no access?)" >&2' _ {} | sort -t$'\t' -k1,1f -k2,2n)"

if [ -z "$PRS" ]; then
  echo "No open PRs in ${#REPOS[@]} repos."
  exit 0
fi

current=""
while IFS=$'\t' read -r repo number title url; do
  if [ "$repo" != "$current" ]; then
    [ -n "$current" ] && echo
    echo "${BOLD}$repo${RESET}"
    current="$repo"
  fi
  if [ "$LINKS" -eq 1 ]; then
    printf '  \e]8;;%s\e\\PR#%s\e]8;;\e\\  %s\n' "$url" "$number" "$title"
  else
    printf '  PR#%s  %s  %s\n' "$number" "$title" "$url"
  fi
done <<< "$PRS"

echo
echo "${DIM}$(wc -l <<< "$PRS" | tr -d ' ') open PRs in $(cut -f1 <<< "$PRS" | sort -u | wc -l | tr -d ' ') of ${#REPOS[@]} repos.${RESET}"
