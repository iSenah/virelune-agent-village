#!/usr/bin/env bash
# Virelune Agent Village - macOS / Linux setup. Safe to run again; never overwrites .env.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Install Node.js 22.18+ (24 LTS recommended) first."; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' || { echo "Node.js $(node -v) is too old; need 22.18+."; exit 1; }
echo "Node.js $(node -v) ... ok"
command -v git >/dev/null && echo "$(git --version) ... ok" || echo "Git not found (needed for agent work)."
if [ ! -f .env ]; then
  sed "s/^VILLAGE_MACHINE_NAME=$/VILLAGE_MACHINE_NAME=$(hostname -s)/" .env.example > .env
  echo "Created .env. Edit it to add keys and tool paths."
fi
mkdir -p data
npm run --silent doctor
echo "Start with: npm start   then open http://127.0.0.1:4317"
