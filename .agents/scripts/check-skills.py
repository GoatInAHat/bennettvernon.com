#!/usr/bin/env python3
"""Verify skills-lock.json against the skills actually present in .agents/skills.

Checks that every skill is locked, that SKILL.md declares a name matching its
directory and a non-empty description, and that vendored content has not
drifted from the hash recorded when it was installed.

Usage: check-skills.py [--update]
       --update rewrites the recorded hashes instead of failing on drift.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = REPO_ROOT / ".agents" / "skills"
LOCK_PATH = REPO_ROOT / "skills-lock.json"
IGNORED_DIRECTORIES = {".git", "node_modules", "__pycache__"}
FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", re.DOTALL)


def skill_hash(skill_root):
    """Hash a skill directory: sorted relative path plus file bytes.

    Matches the folder-hash convention used by skill installers, so hashes
    written by `npx skills add` stay valid here.
    """
    digest = hashlib.sha256()
    files = [
        path
        for path in sorted(skill_root.rglob("*"))
        if path.is_file()
        and not IGNORED_DIRECTORIES.intersection(path.relative_to(skill_root).parts)
    ]
    for path in sorted(files, key=lambda path: path.relative_to(skill_root).as_posix()):
        digest.update(path.relative_to(skill_root).as_posix().encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def frontmatter_field(block, field):
    """Read one top-level scalar or folded value out of YAML frontmatter."""
    match = re.search(rf"^{field}:[ \t]*(.*)$", block, re.MULTILINE)
    if not match:
        return None
    value = match.group(1).strip()
    if value in ("", "|", ">", "|-", ">-"):
        # Folded or literal block: take the indented lines that follow.
        rest = block[match.end():].splitlines()
        folded = []
        for line in rest[1:] if rest[:1] == [""] else rest:
            if line.strip() and not line.startswith((" ", "\t")):
                break
            folded.append(line.strip())
        value = " ".join(part for part in folded if part).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value.strip()


def skill_failures(name, entry, update):
    skill_root = SKILLS_ROOT / name
    skill_file = skill_root / "SKILL.md"
    if not skill_file.is_file():
        return [f"{name}: locked but .agents/skills/{name}/SKILL.md is missing"]

    failures = []
    match = FRONTMATTER.match(skill_file.read_text(encoding="utf-8"))
    if not match:
        failures.append(f"{name}: SKILL.md has no YAML frontmatter")
    else:
        declared = frontmatter_field(match.group(1), "name")
        if declared != name:
            failures.append(f"{name}: SKILL.md declares name {declared!r}")
        if not frontmatter_field(match.group(1), "description"):
            failures.append(f"{name}: SKILL.md has no description")

    actual = skill_hash(skill_root)
    if update:
        entry["computedHash"] = actual
    elif entry.get("computedHash") != actual:
        failures.append(
            f"{name}: content changed since it was locked "
            "(run .agents/scripts/check-skills.py --update)"
        )
    return failures


def main():
    update = "--update" in sys.argv[1:]
    if set(sys.argv[1:]) - {"--update"}:
        print(__doc__, file=sys.stderr)
        return 2

    try:
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot read {LOCK_PATH.name}: {exc}", file=sys.stderr)
        return 1
    skills = lock.setdefault("skills", {})

    on_disk = {path.name for path in SKILLS_ROOT.iterdir() if path.is_dir()}
    failures = []
    for name in sorted(on_disk - set(skills)):
        if update:
            skills[name] = {}
        else:
            failures.append(f"{name}: present in .agents/skills but not in skills-lock.json")
    for name in sorted(set(skills) - on_disk):
        if update:
            del skills[name]
        else:
            failures.append(f"{name}: locked but no .agents/skills/{name} directory")

    for name in sorted(skills):
        failures.extend(skill_failures(name, skills[name], update))

    if failures:
        print("Skill lock problems:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    if update:
        lock["skills"] = {name: skills[name] for name in sorted(skills)}
        document = json.dumps(lock, indent=2, ensure_ascii=False) + "\n"
        if document != LOCK_PATH.read_text(encoding="utf-8"):
            LOCK_PATH.write_text(document, encoding="utf-8")
            print(f"Updated {LOCK_PATH.name}")
            return 0
    print(f"{len(skills)} skill(s) locked and current.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
