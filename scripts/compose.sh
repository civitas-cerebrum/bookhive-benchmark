#!/bin/sh
# compose.sh <args> — Docker Compose v2 as `docker compose`, else the standalone `docker-compose`.
if docker compose version >/dev/null 2>&1; then exec docker compose "$@"; fi
exec docker-compose "$@"
