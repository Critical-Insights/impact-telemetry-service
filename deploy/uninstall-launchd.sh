#!/usr/bin/env bash
#
# Stop and remove the supervised launchd job.
#
# This is the ONLY correct way to stop the service: KeepAlive is true, so
# `kill` is answered by launchd restarting it within ThrottleInterval.
set -euo pipefail

LABEL="com.criticalinsights.impact-telemetry"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID/$LABEL"
  echo "stopped: $LABEL"
else
  echo "not loaded: $LABEL"
fi

if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "removed: $PLIST"
fi

# Logs are left in place on purpose — they are the record of what the feed did
# while it was running, and this script's job is to stop a service, not to
# destroy evidence of an 18-month study's data collection.
echo
echo "logs kept at: $HOME/Library/Logs/impact-telemetry/"
