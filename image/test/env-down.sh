#!/bin/bash
# Remove the local M0 test env (containers, volumes, network). Touches only ocm0-* names.
docker ps -a --format '{{.Names}}' | grep -E '^ocm0-' | xargs -r docker rm -f >/dev/null
docker volume ls --format '{{.Name}}' | grep -E '^ocm0-' | xargs -r docker volume rm >/dev/null
docker network rm ocm0 >/dev/null 2>&1 || true
echo "env down"
