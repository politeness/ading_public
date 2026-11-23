#!/bin/bash
# Deploy ading_ops.jar to the server: back up the old one, replace, restart, health-check; automatically switch back to the old jar if the health check fails.
# First deployment requires manually creating the directory, env and systemd unit, see "First deployment" in docs/deployment.md; this script only swaps the jar.
# Usage: run ./scripts/deploy.sh from the ops/ directory
set -euo pipefail
cd "$(dirname "$0")/.."

# Server address and deploy directory stay out of the repo: pass them as environment variables, or put them in .env at the repo root (not in Git; see .env.example)
if [ -z "${ADING_OPS_SERVER:-}" ] && [ -f ../.env ]; then set -a; . ../.env; set +a; fi
SERVER="${ADING_OPS_SERVER:?ADING_OPS_SERVER is missing, see .env.example at the repo root}"
TARGET="${ADING_OPS_DIR:?ADING_OPS_DIR is missing, see .env.example at the repo root}"
JAR=target/ading_ops.jar

[ -f "$JAR" ] || { echo "$JAR is missing, run mvn -B clean package first" >&2; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
UPLOAD="ading_ops.jar.upload-$STAMP"
# Upload the new jar under a timestamped temp name first: if this step breaks, it only leaves an unused file and the running jar is unaffected
ssh "$SERVER" "cd '$TARGET' && [ -d backup ] && cat > '$UPLOAD'" < "$JAR" \
  || { echo "Upload failed; for a first deployment, create the directory per 'First deployment' in docs/deployment.md" >&2; exit 1; }

# Then use a single ssh connection for backup, replacement, restart, health check and rollback on failure.
# The remote script is passed verbatim via a single-quoted heredoc so variables expand remotely; arguments are passed on the command line
ssh "$SERVER" bash -s -- "$TARGET" "$STAMP" "$UPLOAD" <<'REMOTE'
set -euo pipefail
TARGET=$1
STAMP=$2
UPLOAD=$3
cd "$TARGET"

BACKUP=""
if [ -f ading_ops.jar ]; then
  BACKUP="backup/ading_ops.jar.bak-$STAMP"
  cp ading_ops.jar "$BACKUP"
fi
mv "$UPLOAD" ading_ops.jar

HEALTH=$(mktemp)
trap 'rm -f "$HEALTH"' EXIT

healthy() {
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    if curl -fsS http://127.0.0.1:8280/ading/ops/actuator/health > "$HEALTH"; then
      return 0
    fi
  done
  return 1
}

systemctl restart ading_ops_service
if healthy; then
  cat "$HEALTH"; echo
  ls -l ading_ops.jar
  exit 0
fi

echo 'New jar failed the health check ten times, see logs: journalctl -u ading_ops_service -n 100' >&2
if [ -z "$BACKUP" ]; then
  echo 'This is the first deployment, there is no old jar to roll back to; the service is left as is' >&2
  exit 1
fi
mv ading_ops.jar "backup/ading_ops.jar.failed-$STAMP"
cp "$BACKUP" ading_ops.jar
systemctl restart ading_ops_service
if healthy; then
  echo "Rolled back to $BACKUP, the old version passed the health check; the failed jar is kept at backup/ading_ops.jar.failed-$STAMP" >&2
else
  echo "Switched back to $BACKUP but the old version also failed the health check; manual intervention needed" >&2
fi
exit 1
REMOTE

echo "Deployed: https://www.coffeestudy.com.cn/ading/ops/"
echo "Remember to log in with a browser and check each tab, and confirm /ading/ops/api/me returns 401 when logged out"
