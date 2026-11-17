#!/bin/bash
# Deploy the landing page in releases/site to ECS (https://www.coffeestudy.com.cn/ading/).
# release.json is updated separately by the release process; it is left untouched here.
# Usage: run ./scripts/deploy-site.sh from the desktop_mac directory
#
# Use tar over a single ssh connection so upload and chmod authenticate only once.
# Permissions must be fixed: local files may be 600 / 700; uploaded as-is, nginx can't read them and images return 403/404.
set -euo pipefail
cd "$(dirname "$0")/.."
# The server address and deploy directory are kept out of the repo: pass them as environment variables or put them in the untracked .env at the repo root (see .env.example)
if [ -z "${ADING_SITE_SERVER:-}" ] && [ -f ../.env ]; then set -a; . ../.env; set +a; fi
SERVER="${ADING_SITE_SERVER:?ADING_SITE_SERVER is missing; see .env.example at the repo root}"
TARGET="${ADING_SITE_DIR:?ADING_SITE_DIR is missing; see .env.example at the repo root}"
ITEMS=(index.html en sitemap.xml robots.txt terms.html privacy.html icon.png agents shots)
for item in "${ITEMS[@]}"; do
  [ -e "releases/site/$item" ] || { echo "releases/site/$item is missing; generate it before deploying" >&2; exit 1; }
done
# COPYFILE_DISABLE: keep macOS tar from including ._ metadata files
COPYFILE_DISABLE=1 tar -C releases/site -cf - "${ITEMS[@]}" \
  | ssh "$SERVER" "set -e; cd '$TARGET'; tar -xf - --no-same-owner; chmod -R u+rwX,go+rX ${ITEMS[*]}; ls -ld ${ITEMS[*]}"
echo "Deployed: https://www.coffeestudy.com.cn/ading/"
