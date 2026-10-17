#!/usr/bin/env bash
# Provision an Arkivate worker on a fresh Debian 12 VM. Idempotent: safe to re-run.
#
#   sudo bash setup.sh <hostname> <env-file>
#
#   <hostname>  public name Caddy serves, e.g. 34-123-45-67.sslip.io
#   <env-file>  filled-in copy of deploy/vm/worker.env.example; moved to /opt/arkivate/.env and the
#               source removed. On a re-run it may be omitted if /opt/arkivate/.env already exists.
#
# Guide: docs/deploy-vm.md. This script never prints the env file.
set -euo pipefail

REPO_URL="https://github.com/NatX223/Arkivate.git"
APP_DIR="/opt/arkivate"
DATA_DIR="/var/lib/arkivate"
SVC_USER="arkivate"
SERVICE="arkivate-worker"
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
as_app() { sudo -u "$SVC_USER" -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c "$1"; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0 <hostname> <env-file>"
[[ $# -ge 1 && $# -le 2 ]] || die "usage: sudo bash $0 <hostname> <env-file>"
HOSTNAME_ARG="$1"
ENV_FILE="${2:-}"
[[ "$HOSTNAME_ARG" =~ ^[A-Za-z0-9.-]+$ ]] || die "hostname must be a bare host name like 34-123-45-67.sslip.io (no scheme, no path)"
if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
  grep -Eq '^WORKER_PRIVATE_KEY=.+' "$ENV_FILE" || die "$ENV_FILE has no WORKER_PRIVATE_KEY value"
  ENV_FILE="$(readlink -f "$ENV_FILE")"
elif [[ ! -f "$APP_DIR/.env" ]]; then
  die "no env file given and $APP_DIR/.env does not exist yet"
fi

# 1. Packages: git, curl, Node 22 (NodeSource), corepack, Caddy (official apt repo).
log "Installing packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
echo "node $(node -v), caddy $(caddy version | cut -d' ' -f1)"

# 2. 1 GB swap: an e2-micro has 1 GB RAM, which pnpm install can exhaust.
if [[ -z "$(swapon --show --noheadings)" ]]; then
  log "Adding 1 GB swapfile"
  [[ -f /swapfile ]] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 3. Service user and checkout.
log "Preparing $SVC_USER user and $APP_DIR"
id -u "$SVC_USER" >/dev/null 2>&1 \
  || useradd --system --create-home --home-dir "/home/$SVC_USER" --shell /usr/sbin/nologin "$SVC_USER"
if [[ -d "$APP_DIR/.git" ]]; then
  chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
  as_app "git -C '$APP_DIR' pull --ff-only"
else
  [[ ! -e "$APP_DIR" || -z "$(ls -A "$APP_DIR")" ]] || die "$APP_DIR exists and is not a git checkout"
  install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR"
  as_app "git clone --quiet '$REPO_URL' '$APP_DIR'"
fi
echo "checkout at $(as_app "git -C '$APP_DIR' rev-parse --short HEAD")"

# 4. Worker dependencies only (core comes with it).
log "Installing worker dependencies"
as_app "cd '$APP_DIR' && pnpm install --frozen-lockfile --filter @arkivate/worker..."

# 5. Secrets: move the env file into place.
if [[ -n "$ENV_FILE" ]]; then
  log "Installing $APP_DIR/.env"
  install -o "$SVC_USER" -g "$SVC_USER" -m 600 "$ENV_FILE" "$APP_DIR/.env"
  rm -f "$ENV_FILE"
else
  log "Keeping existing $APP_DIR/.env"
  chown "$SVC_USER:$SVC_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

# 6. Job store.
install -d -o "$SVC_USER" -g "$SVC_USER" -m 750 "$DATA_DIR"

# 7. systemd service (restarted if it was already running, to pick up new code and env).
log "Installing $SERVICE.service"
install -m 644 "$APP_DIR/deploy/vm/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
if systemctl is-active --quiet "$SERVICE"; then
  systemctl enable "$SERVICE"
  systemctl restart "$SERVICE"
else
  systemctl enable --now "$SERVICE"
fi

# 8. Caddy (HTTPS, certificate issued automatically on first request).
log "Configuring Caddy for $HOSTNAME_ARG"
sed "s/{{HOST}}/$HOSTNAME_ARG/g" "$APP_DIR/deploy/vm/Caddyfile.template" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy || systemctl restart caddy

# 9. Status.
log "Service status"
systemctl --no-pager --lines=15 status "$SERVICE" || true
log "GET https://$HOSTNAME_ARG/health"
for _ in $(seq 1 30); do
  if body="$(curl -fsS --max-time 10 "https://$HOSTNAME_ARG/health" 2>/dev/null)"; then
    echo "$body"
    exit 0
  fi
  sleep 3
done
echo "no answer yet. Check: sudo journalctl -u $SERVICE -n 50 --no-pager; sudo journalctl -u caddy -n 50 --no-pager;"
echo "and that the VM firewall allows tcp:80 and tcp:443."
exit 1
