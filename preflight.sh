#!/bin/sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "Missing .env. Run: cp .env.example .env" >&2
  exit 1
fi

echo "[1/2] Validating Docker Compose configuration..."
docker compose config -q

echo "[2/2] Building Ascendant Ledger (includes npm ci + TypeScript build)..."
docker compose build

echo "Preflight passed. Start with: docker compose up -d"
