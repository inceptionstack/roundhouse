#!/usr/bin/env bash
#
# Scan the STAGED version of every added/changed file with secretlint.
# The index content (not the working tree) is exported to a temp dir, so a
# secret that is staged but later edited out of the working copy is still caught.
#
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

BIN="$ROOT/node_modules/.bin/secretlint"
if [ ! -x "$BIN" ]; then
  echo "secret scan: secretlint is not installed. Run 'npm ci' first." >&2
  exit 1
fi

FILES=()
while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

[ "${#FILES[@]}" -eq 0 ] && exit 0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

printf '%s\0' "${FILES[@]}" | git checkout-index -z --stdin --prefix="$TMP/"

cd "$TMP"
"$BIN" \
  --secretlintrc "$ROOT/.secretlintrc.json" \
  --secretlintignore "$ROOT/.secretlintignore" \
  --maskSecrets \
  "${FILES[@]}"
