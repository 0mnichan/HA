#!/usr/bin/env bash
# Run the agent forever, for environments without a cron or systemd timer
# (for example backgrounded from the Home Assistant SSH add-on's init_commands).
#
#   ./run-loop.sh [interval_seconds]     # default 120
set -u
INTERVAL="${1:-${AGENT_INTERVAL:-120}}"
HERE="$(cd "$(dirname "$0")" && pwd)"

while true; do
  "$HERE/ts-health-agent.sh" || echo "[run-loop] agent exited $?" >&2
  sleep "$INTERVAL"
done
