#!/usr/bin/env python3
"""Install workspace skills into local Codex and Claude Code skill directories, and the
helper scripts into $WORKSPACE (default ~/workspace)."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import sys
import uuid


def skill_sources(root: Path) -> list[Path]:
    if not root.is_dir():
        raise RuntimeError(f"Skills source directory does not exist: {root}")
    result = sorted(
        path for path in root.iterdir()
        if path.is_dir() and (path / "SKILL.md").is_file()
    )
    if not result:
        raise RuntimeError(f"No skill directories containing SKILL.md found in {root}")
    return result


def install_one(source: Path, destination: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"Would install {source.name} -> {destination}")
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.parent / f".{destination.name}.staging-{uuid.uuid4().hex}"
    backup = destination.parent / f".{destination.name}.backup-{uuid.uuid4().hex}"
    had_destination = destination.exists() or destination.is_symlink()
    try:
        shutil.copytree(source, staging, symlinks=True)
        if had_destination:
            os.replace(destination, backup)
        os.replace(staging, destination)
    except Exception:
        if had_destination and backup.exists() and not destination.exists():
            os.replace(backup, destination)
        if staging.exists():
            shutil.rmtree(staging)
        raise
    if had_destination:
        if backup.is_symlink() or not backup.is_dir():
            backup.unlink(missing_ok=True)
        else:
            shutil.rmtree(backup)
    print(f"Installed {source.name} -> {destination}")


def install_file(source: Path, destination: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"Would install {source.name} -> {destination}")
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.parent / f".{destination.name}.staging-{uuid.uuid4().hex}"
    try:
        shutil.copy2(source, staging)
        os.replace(staging, destination)
    finally:
        staging.unlink(missing_ok=True)
    print(f"Installed {source.name} -> {destination}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="show target paths without copying files")
    args = parser.parse_args()

    workspace_root = Path(__file__).resolve().parents[1]
    sources = skill_sources(workspace_root / "skills")
    home = Path.home()
    # Current Codex reads user skills from ~/.agents/skills; the older
    # $CODEX_HOME/skills (~/.codex/skills) location is no longer installed to.
    codex_target = home / ".agents" / "skills"
    targets: list[tuple[str, Path]] = [("Codex", codex_target)]

    claude_home = home / ".claude"
    if shutil.which("claude") or claude_home.is_dir():
        claude_target = claude_home / "skills"
        if claude_target.resolve() != codex_target.resolve():
            targets.append(("Claude Code", claude_target))
    else:
        print("Claude Code not detected; skipping its skill directory.")

    print(f"Source: {workspace_root / 'skills'} ({len(sources)} skills)")
    for product, target_root in targets:
        for source in sources:
            print(f"{product}: ", end="")
            install_one(source, target_root / source.name, args.dry_run)

    # Same default as the scripts themselves use for $WORKSPACE.
    workspace = Path(os.environ.get("WORKSPACE") or home / "workspace").expanduser()
    scripts = workspace_root / "scripts"
    for source, destination in [
        (scripts / "clean-worktrees.sh", workspace / "worktrees" / "clean-worktrees.sh"),
        (scripts / "open-prs.sh", workspace / "open-prs.sh"),
    ]:
        print("Script: ", end="")
        install_file(source, destination, args.dry_run)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"install-skills: {error}", file=sys.stderr)
        raise SystemExit(1)
