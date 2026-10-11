#!/usr/bin/env python3
"""Bump the version of every TaskSquad product by one patch, minor, or major step.

Usage: scripts/bump.py [--patch|--minor|--major] [--dry-run]

Each product keeps its version in exactly one place:
  daemon  packages/daemon/Makefile   VERSION ?= X.Y.Z   (release tag: vX.Y.Z)
  macos   packages/macos/Makefile    VERSION ?= X.Y.Z   (release tag: macos-vX.Y.Z)
  ios     packages/ios/project.yml   MARKETING_VERSION + CURRENT_PROJECT_VERSION (build number, +1 every bump)
  worker  packages/worker/package.json "version"
  portal  packages/portal/package.json "version"

Release pipelines pass VERSION explicitly, so these files are the defaults for
local builds and the source of the next release tag. Tags are never created here.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "packages"
SEMVER = r"(\d+)\.(\d+)\.(\d+)"

# product -> (file, regex whose group 2 is the X.Y.Z version)
PRODUCTS = {
    "daemon": ("daemon/Makefile", r"^(VERSION \?= )" + f"({SEMVER})$"),
    "macos": ("macos/Makefile", r"^(VERSION \?= )" + f"({SEMVER})$"),
    "ios": ("ios/project.yml", r'^(\s+MARKETING_VERSION: ")' + f"({SEMVER})\"$"),
    "worker": ("worker/package.json", r'^(\s+"version": ")' + f"({SEMVER})\""),
    "portal": ("portal/package.json", r'^(\s+"version": ")' + f"({SEMVER})\""),
}
IOS_BUILD = r'^(\s+CURRENT_PROJECT_VERSION: ")(\d+)(")$'


def bumped(version: str, part: str) -> str:
    major, minor, patch = (int(n) for n in version.split("."))
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def main(args: list[str]) -> int:
    parts = [a.lstrip("-") for a in args if a.lstrip("-") in ("patch", "minor", "major")]
    unknown = [a for a in args if a.lstrip("-") not in ("patch", "minor", "major", "dry-run")]
    if unknown or len(parts) > 1:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    part = parts[0] if parts else "patch"
    dry = "--dry-run" in args

    edits: dict[pathlib.Path, str] = {}
    for name, (rel, pattern) in PRODUCTS.items():
        path = ROOT / rel
        text = edits.get(path) or path.read_text()
        match = re.search(pattern, text, re.M)
        if not match:
            print(f"{name}: no version found in {rel}", file=sys.stderr)
            return 1
        old = match.group(2)
        new = bumped(old, part)
        text = text[: match.start(2)] + new + text[match.end(2):]
        note = ""
        if name == "ios":
            build = re.search(IOS_BUILD, text, re.M)
            if not build:
                print(f"ios: no CURRENT_PROJECT_VERSION in {rel}", file=sys.stderr)
                return 1
            n = int(build.group(2)) + 1
            text = text[: build.start(2)] + str(n) + text[build.end(2):]
            note = f" (build {n})"
        edits[path] = text
        print(f"{name:7} {old} -> {new}{note}")

    if not dry:
        for path, text in edits.items():
            path.write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
