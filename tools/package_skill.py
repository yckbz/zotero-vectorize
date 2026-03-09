#!/usr/bin/env python3
"""Package a skill directory into a .skill archive."""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

from quick_validate import validate_skill

EXCLUDED_DIRS = {".git", ".svn", ".hg", "__pycache__", "node_modules"}


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def package_skill(skill_path: Path, output_dir: Path | None = None) -> Path:
    skill_path = skill_path.resolve()
    if not skill_path.exists() or not skill_path.is_dir():
        raise SystemExit(f"[ERROR] Skill folder not found or not a directory: {skill_path}")
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        raise SystemExit(f"[ERROR] SKILL.md not found in {skill_path}")

    valid, message = validate_skill(skill_path)
    if not valid:
        raise SystemExit(f"[ERROR] Validation failed: {message}")
    print(f"[OK] {message}")

    output_dir = output_dir.resolve() if output_dir else Path.cwd()
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / f"{skill_path.name}.skill"

    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        for file_path in skill_path.rglob("*"):
            if file_path.is_symlink():
                print(f"[WARN] Skipping symlink: {file_path}")
                continue
            rel_parts = file_path.relative_to(skill_path).parts
            if any(part in EXCLUDED_DIRS for part in rel_parts):
                continue
            if file_path.is_file():
                resolved_file = file_path.resolve()
                if not _is_within(resolved_file, skill_path):
                    raise SystemExit(f"[ERROR] File escapes skill root: {file_path}")
                arcname = Path(skill_path.name) / file_path.relative_to(skill_path)
                zipf.write(file_path, arcname)
                print(f"Added: {arcname}")

    print(f"[OK] Packaged skill to {archive_path}")
    return archive_path


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python package_skill.py <path/to/skill-folder> [output-directory]")
        raise SystemExit(1)
    skill_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2]) if len(sys.argv) >= 3 else None
    package_skill(skill_path, output_dir)


if __name__ == "__main__":
    main()
