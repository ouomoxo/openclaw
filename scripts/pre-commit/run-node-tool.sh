#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

local_tool="$ROOT_DIR/node_modules/.bin/$tool"
if [[ -x "$local_tool" ]]; then
  exec "$local_tool" "$@"
fi

echo "Skipping $tool in pre-commit: $local_tool is not installed." >&2
echo "Run pnpm install to enable pre-commit formatting." >&2
exit 0
