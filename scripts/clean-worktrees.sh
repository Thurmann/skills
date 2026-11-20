#!/usr/bin/env bash
# Clean up git worktrees living under $WORKSPACE_DIR/worktrees/<repo>/<worktree>/.
# WORKSPACE_DIR defaults to ~/workspace.
#
# Usage: clean-worktrees.sh [options] [repo ...]
#   -k, --keep-branches   only remove the worktree directories; keep the git branches
#   -w, --pick-worktrees  also pick individual worktrees inside the chosen repos
#   -n, --dry-run         print what would happen, change nothing
#   -y, --yes             skip the confirmation prompt
#   -h, --help            show this help
#
# Without repo arguments an fzf picker is shown (TAB to multi-select).
# Without -k/-y you are also asked which cleanup mode to use.

set -uo pipefail

ROOT="${WORKSPACE_DIR:-$HOME/workspace}/worktrees"
KEEP_BRANCHES=""
PICK_WORKTREES=0
DRY_RUN=0
ASSUME_YES=0
REPOS=()

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -k|--keep-branches)  KEEP_BRANCHES=1 ;;
    -w|--pick-worktrees) PICK_WORKTREES=1 ;;
    -n|--dry-run)        DRY_RUN=1 ;;
    -y|--yes)            ASSUME_YES=1 ;;
    -h|--help)           usage 0 ;;
    -*)                  echo "Unknown option: $1" >&2; usage 1 ;;
    *)                   REPOS+=("${1%/}") ;;
  esac
  shift
done

if [ -t 1 ]; then
  RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' DIM=$'\e[2m' BOLD=$'\e[1m' RESET=$'\e[0m'
else
  RED="" GREEN="" YELLOW="" DIM="" BOLD="" RESET=""
fi

have_fzf() { command -v fzf >/dev/null 2>&1 && [ -t 0 ]; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ${DIM}[dry-run] $*${RESET}"
  else
    "$@"
  fi
}

# Worktree directories (those with a .git file) directly under a repo folder.
worktrees_of() {
  local repo="$1" d
  for d in "$ROOT/$repo"/*/ "$ROOT/$repo"/.[!.]*/; do
    d="${d%/}"
    [ -f "$d/.git" ] && echo "$d"
  done
}

# Repo folders under ROOT that contain at least one worktree.
list_repos() {
  local d name
  for d in "$ROOT"/*/ "$ROOT"/.[!.]*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ -n "$(worktrees_of "$name")" ] && echo "$name"
  done
}

# GNU coreutils stat/date vs. BSD (macOS).
if stat -c %Y / >/dev/null 2>&1; then GNU_STAT=1; else GNU_STAT=0; fi

# Modification times (epoch seconds) of the given files, one per line.
mtimes() {
  if [ "$GNU_STAT" -eq 1 ]; then stat -c %Y "$@" 2>/dev/null; else stat -f %m "$@" 2>/dev/null; fi
}

# Epoch seconds -> "YYYY-MM-DD HH:MM", or "?" when unknown.
fmt_date() {
  [ -n "$1" ] && [ "$1" != "0" ] || { echo "?"; return; }
  if [ "$GNU_STAT" -eq 1 ]; then date -d "@$1" '+%Y-%m-%d %H:%M'; else date -r "$1" '+%Y-%m-%d %H:%M'; fi
}

# When the worktree was added: birth time of its .git file (falls back to mtime).
added_epoch() {
  local t=""
  if [ "$GNU_STAT" -eq 1 ]; then t="$(stat -c %W "$1/.git" 2>/dev/null)"; else t="$(stat -f %B "$1/.git" 2>/dev/null)"; fi
  [ -n "$t" ] && [ "$t" != "0" ] && [ "$t" != "-" ] || t="$(mtimes "$1/.git")"
  echo "$t"
}

# Last change: newest of the HEAD commit time and modified/untracked file mtimes.
changed_epoch() {
  local wt="$1" commit f paths=()
  commit="$(git -C "$wt" log -1 --format=%ct 2>/dev/null)"
  while IFS= read -r -d '' f; do
    [ -e "$wt/$f" ] && paths+=("$wt/$f")
  done < <(git -C "$wt" ls-files -z -m -o --exclude-standard 2>/dev/null)
  { echo "${commit:-0}"; [ ${#paths[@]} -gt 0 ] && mtimes "${paths[@]}"; } | sort -n | tail -1
}

# One-line status for a worktree: branch, dirty, unpushed, added and last changed dates.
describe() {
  local wt="$1" branch flags=""
  branch="$(git -C "$wt" branch --show-current 2>/dev/null)"
  [ -z "$branch" ] && branch="(detached)"
  [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ] && flags+=" ${RED}dirty${RESET}"
  if git -C "$wt" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    [ "$(git -C "$wt" rev-list --count '@{u}..HEAD' 2>/dev/null)" != "0" ] && flags+=" ${YELLOW}unpushed${RESET}"
  elif [ "$branch" != "(detached)" ]; then
    flags+=" ${YELLOW}no-upstream${RESET}"
  fi
  flags+="  ${DIM}added $(fmt_date "$(added_epoch "$wt")"), changed $(fmt_date "$(changed_epoch "$wt")")${RESET}"
  echo "$(basename "$wt")  ${DIM}[$branch]${RESET}$flags"
}

# --- pick repos -----------------------------------------------------------
if [ ${#REPOS[@]} -eq 0 ]; then
  ALL_REPOS=()
  while IFS= read -r r; do ALL_REPOS+=("$r"); done < <(list_repos)
  [ ${#ALL_REPOS[@]} -eq 0 ] && { echo "No worktrees found under $ROOT"; exit 0; }

  if have_fzf; then
    export -f worktrees_of describe mtimes fmt_date added_epoch changed_epoch
    export ROOT RED YELLOW DIM RESET GNU_STAT
    while IFS= read -r r; do REPOS+=("$r"); done < <(
      printf '%s\n' "${ALL_REPOS[@]}" | fzf --multi --ansi --with-shell 'bash -c' \
        --header 'Pick repos to clean (TAB = select, ctrl-a = all, ENTER = confirm)' \
        --bind 'ctrl-a:select-all' \
        --preview 'for w in $(worktrees_of {}); do describe "$w"; done' \
        --preview-window 'right,60%'
    )
  else
    echo "Repos with worktrees:"
    i=1; for r in "${ALL_REPOS[@]}"; do echo "  $i) $r"; i=$((i+1)); done
    read -r -p "Numbers to clean (space separated, 'a' for all): " picks
    if [ "$picks" = "a" ]; then
      REPOS=("${ALL_REPOS[@]}")
    else
      for n in $picks; do
        [ -n "${ALL_REPOS[$((n-1))]:-}" ] && REPOS+=("${ALL_REPOS[$((n-1))]}")
      done
    fi
  fi
fi
[ ${#REPOS[@]} -eq 0 ] && { echo "Nothing selected."; exit 0; }

# --- collect worktrees ----------------------------------------------------
TARGETS=()
for repo in "${REPOS[@]}"; do
  [ -d "$ROOT/$repo" ] || { echo "${YELLOW}Skipping unknown repo: $repo${RESET}" >&2; continue; }
  while IFS= read -r wt; do TARGETS+=("$wt"); done < <(worktrees_of "$repo")
done

if [ "$PICK_WORKTREES" -eq 1 ] && [ ${#TARGETS[@]} -gt 0 ] && have_fzf; then
  PICKED=()
  while IFS= read -r line; do PICKED+=("$ROOT/$line"); done < <(
    printf '%s\n' "${TARGETS[@]#"$ROOT/"}" | fzf --multi --bind 'start:select-all,ctrl-a:toggle-all' \
      --header 'Pick worktrees (all preselected, TAB toggles, ctrl-a toggles all)' \
      --preview "git -C '$ROOT'/{} log --oneline -10 --color=always; echo; git -C '$ROOT'/{} status --short"
  )
  TARGETS=(${PICKED[@]+"${PICKED[@]}"})
fi
[ ${#TARGETS[@]} -eq 0 ] && { echo "No worktrees selected."; exit 0; }

# --- pick mode ------------------------------------------------------------
if [ -z "$KEEP_BRANCHES" ]; then
  if [ "$ASSUME_YES" -eq 1 ]; then
    KEEP_BRANCHES=0
  else
    MODE_FULL="Remove worktrees AND delete their branches"
    MODE_DIR="Remove worktree directories only (keep branches)"
    if have_fzf; then
      mode="$(printf '%s\n%s\n' "$MODE_FULL" "$MODE_DIR" | fzf --no-multi --height 5 --header 'Cleanup mode')"
    else
      echo "1) $MODE_FULL"; echo "2) $MODE_DIR"
      read -r -p "Mode [1/2]: " n
      [ "$n" = "2" ] && mode="$MODE_DIR" || { [ "$n" = "1" ] && mode="$MODE_FULL"; }
    fi
    case "${mode:-}" in
      "$MODE_FULL") KEEP_BRANCHES=0 ;;
      "$MODE_DIR")  KEEP_BRANCHES=1 ;;
      *) echo "Aborted."; exit 0 ;;
    esac
  fi
fi

# --- confirm --------------------------------------------------------------
echo
if [ "$KEEP_BRANCHES" -eq 1 ]; then
  echo "${BOLD}Will remove these worktree directories (branches are kept):${RESET}"
else
  echo "${BOLD}Will remove these worktrees ${RED}and delete their branches${RESET}${BOLD}:${RESET}"
fi
for wt in "${TARGETS[@]}"; do echo "  $(basename "$(dirname "$wt")")/$(describe "$wt")"; done
echo

if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  read -r -p "Proceed? [y/N] " ok
  case "$ok" in y|Y|yes) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# --- clean ----------------------------------------------------------------
FAILED=0
MAIN_REPOS=()
for wt in "${TARGETS[@]}"; do
  echo "${BOLD}$(basename "$(dirname "$wt")")/$(basename "$wt")${RESET}"
  branch="$(git -C "$wt" branch --show-current 2>/dev/null)"
  common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  main=""
  # <repo>/.git -> <repo>; a bare repo is used as-is
  if [ -n "$common" ]; then
    [ "$(basename "$common")" = ".git" ] && main="$(dirname "$common")" || main="$common"
  fi

  if [ -z "$main" ] || [ ! -d "$common" ]; then
    echo "  ${YELLOW}main repo not found; deleting directory only${RESET}"
    run rm -rf "$wt"
    continue
  fi

  if ! run git -C "$main" worktree remove --force "$wt"; then
    echo "  ${YELLOW}git worktree remove failed; deleting directory${RESET}"
    run rm -rf "$wt"
  fi
  MAIN_REPOS+=("$main")

  if [ "$KEEP_BRANCHES" -eq 0 ] && [ -n "$branch" ]; then
    if run git -C "$main" branch -D "$branch"; then
      [ "$DRY_RUN" -eq 1 ] || echo "  ${GREEN}deleted branch $branch${RESET}"
    else
      echo "  ${RED}could not delete branch $branch${RESET}"; FAILED=1
    fi
  elif [ -n "$branch" ]; then
    echo "  ${DIM}kept branch $branch${RESET}"
  fi
done

# Clear stale worktree metadata (never touches branches) and empty repo folders.
if [ ${#MAIN_REPOS[@]} -gt 0 ]; then
  printf '%s\n' "${MAIN_REPOS[@]}" | sort -u | while IFS= read -r main; do
    run git -C "$main" worktree prune
  done
fi
for repo in "${REPOS[@]}"; do
  d="$ROOT/$repo"
  if [ -d "$d" ] && [ -z "$(ls -A "$d" 2>/dev/null)" ]; then run rmdir "$d"; fi
done

echo
[ "$FAILED" -eq 0 ] && echo "${GREEN}Done.${RESET}" || { echo "${RED}Done with errors.${RESET}"; exit 1; }
