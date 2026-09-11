#!/usr/bin/env bash
#
# Install impact-telemetry-service as a supervised launchd job.
#
# Idempotent: re-running replaces the existing job with the current template.
#
#   ./deploy/install-launchd.sh            # install and start
#   ./deploy/install-launchd.sh --dry-run  # render the plist, change nothing
#
# Deliberately NOT run automatically by anything. Installing a persistent
# background job that writes to a clinical database is a decision, not a build
# step.
set -euo pipefail

LABEL="com.criticalinsights.impact-telemetry"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO/deploy/$LABEL.plist.template"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENTS_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/impact-telemetry"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

die() { printf '\nERROR: %s\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }

echo "impact-telemetry-service — launchd install"
echo

# ── Preflight. Each of these has actually bitten us, so each is checked rather
# ── than assumed. A job that installs cleanly and then crash-loops at 3am is
# ── worse than an install that refuses now with a reason.

[[ -f "$TEMPLATE" ]] || die "template not found: $TEMPLATE"

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || die "node not found on PATH"
NODE_MAJOR="$("$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
(( NODE_MAJOR >= 20 )) || die "node >= 20 required (package.json engines); found $NODE_MAJOR"
note "node:  $NODE (v$NODE_MAJOR)"

[[ -f "$REPO/dist/index.js" ]] || die "dist/index.js missing — run 'npm run build' first"
note "build: $REPO/dist/index.js"

[[ -f "$REPO/.env" ]] || die ".env missing at $REPO/.env — the job reads it via WorkingDirectory; without it every start fails config validation"

# .env holds MQTT_PASSWORD and IMPACT_INGEST_KEY. Loose permissions on a
# machine inside a hospital network are worth stopping for, not warning about.
ENV_MODE="$(stat -f '%Lp' "$REPO/.env")"
if [[ "$ENV_MODE" != "600" && "$ENV_MODE" != "400" ]]; then
  echo
  echo "  WARNING: .env is mode $ENV_MODE and contains live credentials."
  echo "           Fix with:  chmod 600 $REPO/.env"
  echo
fi

# An nvm-managed node lives under a versioned directory, so a node upgrade
# silently moves the binary out from under the baked-in absolute path and the
# job then fails to spawn at all. Say so at install time.
if [[ "$NODE" == *"/.nvm/"* ]]; then
  echo "  NOTE: node is nvm-managed ($NODE)."
  echo "        The plist stores this absolute path because launchd jobs get a"
  echo "        minimal PATH. If you upgrade or switch node, re-run this script."
  echo
fi

note "logs:  $LOG_DIR"

RENDERED="$(sed \
  -e "s|__LABEL__|$LABEL|g" \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__REPO__|$REPO|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE")"

if (( DRY_RUN )); then
  echo
  echo "── rendered plist (dry run; nothing written) ──────────────────────────"
  printf '%s\n' "$RENDERED"
  exit 0
fi

mkdir -p "$AGENTS_DIR" "$LOG_DIR"
printf '%s\n' "$RENDERED" > "$PLIST"
plutil -lint "$PLIST" >/dev/null || die "rendered plist failed plutil -lint: $PLIST"
note "plist: $PLIST"

# `bootout` first so a re-install replaces rather than collides. The job may
# not be loaded, so a failure here is expected and ignored.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

echo
echo "installed and started."
echo

# Give it a moment, then prove it is actually serving rather than reporting
# success on the strength of having written a file. The health endpoint is the
# only honest confirmation available, which is exactly why it was built.
HEALTH_PORT="$(grep -E '^HEALTH_PORT=' "$REPO/.env" | cut -d= -f2 | tr -d '"'"'"' ' || true)"
HEALTH_PORT="${HEALTH_PORT:-3036}"
sleep 3

if curl -fsS --max-time 5 "http://127.0.0.1:$HEALTH_PORT/health/live" >/dev/null 2>&1; then
  echo "  health endpoint is answering on http://127.0.0.1:$HEALTH_PORT/health"
else
  echo "  health endpoint not answering yet on port $HEALTH_PORT."
  echo "  It may still be connecting to the broker. Check:"
  echo "      tail -n 40 $LOG_DIR/impact-telemetry.log"
fi

cat <<EOF

Useful commands
  status      launchctl print gui/$UID/$LABEL | head -20
  health      curl -s http://127.0.0.1:$HEALTH_PORT/health | head -40
  logs        tail -f $LOG_DIR/impact-telemetry.log
  restart     launchctl kickstart -k gui/$UID/$LABEL
  STOP        ./deploy/uninstall-launchd.sh

Note: KeepAlive is true, so 'kill' will NOT stop this service — launchd
restarts it. That is intentional. Use uninstall-launchd.sh to stop it.
EOF
