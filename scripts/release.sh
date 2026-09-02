#!/bin/sh
# Release helper: scripts/release.sh patch|minor|major
# Validates, bumps the version (npm version commits + tags v<version>),
# pushes main with tags — the Release workflow then creates the GitHub
# release automatically. The only remaining manual step is npm publish
# (account has 2FA on publishing).
set -e
cd "$(dirname "$0")/.."
bump="${1:?usage: scripts/release.sh patch|minor|major}"

npm run typecheck
npm test
npm run build

npm version "$bump"
git push origin main --follow-tags

echo
echo "✓ pushed $bump release tag — the GitHub Release will be created by CI."
echo "  remaining manual step (2FA): npm publish"
