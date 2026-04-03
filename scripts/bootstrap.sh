#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "==> Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required (v18+)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm is required"; exit 1; }

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js v18+ is required (found v$(node -v))"
  exit 1
fi

echo "==> Installing dependencies..."
npm ci

echo "==> Building..."
npm run build

if [ ! -f .env ]; then
  echo "==> Creating .env from .env.example..."
  cp .env.example .env
  echo "IMPORTANT: Edit .env and add your HydraDB credentials"
fi

echo ""
echo "Bootstrap complete! Next steps:"
echo "  1. Edit .env with your HYDRA_DB_API_KEY and HYDRA_DB_TENANT_ID"
echo "  2. make dev    # Start MCP server in dev mode"
echo "  3. make test   # Run tests"
