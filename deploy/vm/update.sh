#!/usr/bin/env bash
# Pull the latest main, reinstall worker dependencies and restart the worker.
#
#   sudo bash /opt/arkivate/deploy/vm/update.sh
#
# Does not touch /opt/arkivate/.env or the Caddyfile. Re-run setup.sh for those.
set -euo pipefail

APP_DIR="/opt/arkivate"
SVC_USER="arkivate"
SERVICE="arkivate-worker"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
as_app() { sudo -u "$SVC_USER" -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c "$1"; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a checkout; run setup.sh first"

before="$(as_app "git -C '$APP_DIR' rev-parse --short HEAD")"
as_app "git -C '$APP_DIR' pull --ff-only"
as_app "cd '$APP_DIR' && pnpm install --frozen-lockfile --filter @arkivate/worker..."
after="$(as_app "git -C '$APP_DIR' rev-parse --short HEAD")"
echo "code: $before -> $after"

# Keep the installed unit in sync with the repo copy.
if ! cmp -s "$APP_DIR/deploy/vm/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"; then
  install -m 644 "$APP_DIR/deploy/vm/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
fi
systemctl restart "$SERVICE"

# The worker listens before its first Arkiv read; /health shows "starting" or "rate_limited" until boot completes.
host="$(awk 'NF && $1 !~ /^#/ { print $1; exit }' /etc/caddy/Caddyfile 2>/dev/null || true)"
url="${host:+https://$host/health}"
url="${url:-http://127.0.0.1:8787/health}"
echo "GET $url"
for _ in $(seq 1 20); do
  if body="$(curl -fsS --max-time 10 "$url" 2>/dev/null)"; then
    echo "$body"
    exit 0
  fi
  sleep 3
done
echo "no answer yet. Check: sudo journalctl -u $SERVICE -n 50 --no-pager"
exit 1
