#!/usr/bin/env bash
# Install the agent as a systemd timer on Raspberry Pi OS / Debian.
# Run as root:  sudo ./install-systemd.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run this as root (sudo $0)"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

for tool in curl jq openssl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing $tool. Install it first:  apt install -y curl jq openssl"; exit 1; }
done

install -m 0755 "$HERE/ts-health-agent.sh" /usr/local/bin/ts-health-agent.sh
install -m 0644 "$HERE/systemd/ts-health-agent.service" /etc/systemd/system/
install -m 0644 "$HERE/systemd/ts-health-agent.timer"   /etc/systemd/system/

if [ ! -f /etc/ts-health-agent.conf ]; then
  install -m 0600 "$HERE/agent.conf.example" /etc/ts-health-agent.conf
  echo "Wrote /etc/ts-health-agent.conf - edit it before the timer does anything useful."
else
  echo "Keeping the existing /etc/ts-health-agent.conf"
fi

systemctl daemon-reload
systemctl enable --now ts-health-agent.timer

echo
echo "Installed. Useful commands:"
echo "  systemctl list-timers ts-health-agent.timer"
echo "  systemctl start ts-health-agent.service     # run once now"
echo "  journalctl -u ts-health-agent.service -n 50"
echo "  /usr/local/bin/ts-health-agent.sh --dry-run --verbose"
