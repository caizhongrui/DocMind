#!/usr/bin/env bash
# DocMind release script — bumps version, commits, tags, pushes.
# GitHub Actions ".github/workflows/build.yml" then builds all platforms
# and publishes a Release with .dmg / .exe / .msi / .app.tar.gz / .sig.
#
# Usage:
#   ./scripts/release.sh 0.1.2
#   ./scripts/release.sh 0.1.2 "新增 ABC 功能, 修复 XYZ"
#
# Pre-flight: working tree clean, on branch with push access, gh CLI
# optional (only used to tail the workflow run).

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <version> [release-notes]" >&2
  echo "example: $0 0.1.2 \"修复 .doc 预览乱码\"" >&2
  exit 1
fi

VERSION="$1"
NOTES="${2:-}"
TAG="v${VERSION}"

# Sanity-check the version string.
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'; then
  echo "✗ '$VERSION' doesn't look like a semver string (expected 0.1.2 / 1.0.0-beta.1)" >&2
  exit 1
fi

# Working tree must be clean — the version-bump commit needs a clean base.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree has uncommitted changes:" >&2
  git status --short >&2
  exit 1
fi

# Tag must not already exist.
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "✗ tag $TAG already exists locally — bump to a new version" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "▸ bumping package.json + src-tauri/tauri.conf.json + Cargo.toml → $VERSION"

# package.json — top-level "version" field.
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json'));
  p.version = '$VERSION';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"

# src-tauri/tauri.conf.json — top-level "version" field.
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json'));
  p.version = '$VERSION';
  fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(p, null, 2) + '\n');
"

# src-tauri/Cargo.toml — keep the [package] version in sync.
# Only the FIRST `version = "..."` after `[package]` is replaced.
python3 - <<EOF
import re, pathlib
p = pathlib.Path("src-tauri/Cargo.toml")
text = p.read_text()
text = re.sub(
    r'(\[package\][^\[]*?\nversion\s*=\s*")[^"]+(")',
    r'\g<1>$VERSION\g<2>',
    text,
    count=1,
    flags=re.DOTALL,
)
p.write_text(text)
EOF

# Git commit + tag.
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock 2>/dev/null || true
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore(release): $VERSION"

if [ -n "$NOTES" ]; then
  git tag -a "$TAG" -m "$NOTES"
else
  git tag -a "$TAG" -m "Release $VERSION"
fi

echo "▸ pushing branch + tag"
git push
git push origin "$TAG"

echo
echo "✓ tagged $TAG and pushed."
echo
echo "  GitHub Actions will now:"
echo "    1. Build macOS arm64    (≈ 8 min)"
echo "    2. Build macOS x64      (≈ 10 min)"
echo "    3. Build Windows x64    (≈ 12 min)"
echo "    4. Publish a Release with all .dmg / .exe / .msi + .sig files."
echo

if command -v gh >/dev/null 2>&1; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  if [ -n "$REPO" ]; then
    echo "  → https://github.com/$REPO/actions"
    echo
    echo "  Tail the run with:"
    echo "    gh run watch --exit-status"
  fi
else
  echo "  (Install \`gh\` CLI to tail the run from terminal: brew install gh)"
fi
