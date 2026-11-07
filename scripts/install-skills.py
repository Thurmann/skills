#!/usr/bin/env python3
"""Install workspace skills into local Codex and Claude Code skill directories."""

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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="show target paths without copying files")
    args = parser.parse_args()

    workspace_root = Path(__file__).resolve().parents[1]
    sources = skill_sources(workspace_root / "skills")
    home = Path.home()
    configured_codex_home = os.environ.get("CODEX_HOME")
    codex_home = Path(configured_codex_home).expanduser() if configured_codex_home else home / ".codex"
    codex_targets = [codex_home / "skills", home / ".agents" / "skills"]
    # This Codex installation also discovers skills under ~/.codex/skills.
    codex_targets.append(home / ".codex" / "skills")

    targets: list[tuple[str, Path]] = []
    seen: set[Path] = set()
    for target in codex_targets:
        resolved = target.resolve()
        if resolved not in seen:
            targets.append(("Codex", target))
            seen.add(resolved)

    claude_home = home / ".claude"
    if shutil.which("claude") or claude_home.is_dir():
        target = claude_home / "skills"
        resolved = target.resolve()
        if resolved not in seen:
            targets.append(("Claude Code", target))
            seen.add(resolved)
    else:
        print("Claude Code not detected; skipping its skill directory.")

    print(f"Source: {workspace_root / 'skills'} ({len(sources)} skills)")
    for product, target_root in targets:
        for source in sources:
            print(f"{product}: ", end="")
            install_one(source, target_root / source.name, args.dry_run)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"install-skills: {error}", file=sys.stderr)
        raise SystemExit(1)
