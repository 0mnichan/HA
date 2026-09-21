#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Signed requests to the status Worker, so you never have to hand-craft an
# HMAC curl command.
#
#   ./status-cli.sh status                       # public status, no signing
#   ./status-cli.sh poll                         # run the Tailscale poll now
#   ./status-cli.sh notice maintenance "Router upgrade" "Back by 21:00."
#   ./status-cli.sh notice critical "ISP outage" "Provider says this evening."
#   ./status-cli.sh clear                        # remove the banner
#
# Credentials are read from, in order of preference:
#   $STATUS_ENDPOINT / $INGEST_SECRET in the environment
#   ./status.conf, ~/.ts-status.conf, /etc/ts-health-agent.conf
# ---------------------------------------------------------------------------

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
for f in "$HERE/status.conf" "$HOME/.ts-status.conf" /etc/ts-health-agent.conf; do
  # shellcheck disable=SC1090
  [ -f "$f" ] && . "$f" && break
done

STATUS_ENDPOINT="${STATUS_ENDPOINT:-}"
INGEST_SECRET="${INGEST_SECRET:-}"

usage() { sed -n '3,16p' "$0"; exit "${1:-0}"; }
die() { echo "Error: $*" >&2; exit 1; }

[ $# -ge 1 ] || usage 1
[ -n "$STATUS_ENDPOINT" ] || die "STATUS_ENDPOINT is not set (env or a status.conf)"
command -v curl >/dev/null 2>&1 || die "curl is required"

ENDPOINT="${STATUS_ENDPOINT%/}"

pretty() { if command -v jq >/dev/null 2>&1; then jq .; else cat; fi; }

# signed_post <path> <json body>
signed_post() {
  [ -n "$INGEST_SECRET" ] || die "INGEST_SECRET is not set (env or a status.conf)"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to sign requests"

  local path="$1" body="$2" ts sig
  ts="$(date +%s)"
  sig="$(printf '%s' "${ts}.${body}" \
    | openssl dgst -sha256 -hmac "$INGEST_SECRET" -hex 2>/dev/null \
    | awk '{print $NF}')"
  [ -n "$sig" ] || die "failed to compute the signature"

  printf '%s' "$body" | curl -sS -X POST "${ENDPOINT}${path}" \
    -H 'Content-Type: application/json' \
    -H "X-Timestamp: ${ts}" \
    -H "X-Signature: sha256=${sig}" \
    --data-binary @- | pretty
}

# JSON-escape a string without assuming jq is present.
esc() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk '{printf "%s", (NR>1 ? "\\n" : "") $0}'
}

case "${1:-}" in
  status)
    curl -sS "${ENDPOINT}/api/status" | pretty
    ;;
  poll)
    echo "Running the Tailscale poll..." >&2
    signed_post /api/poll '{}'
    ;;
  notice)
    [ $# -ge 3 ] || die 'usage: status-cli.sh notice <info|warning|critical|maintenance> "Title" ["Body"]'
    level="$2"
    case "$level" in
      info|warning|critical|maintenance) ;;
      *) die "level must be one of: info, warning, critical, maintenance" ;;
    esac
    signed_post /api/notice \
      "{\"level\":\"$(esc "$level")\",\"title\":\"$(esc "$3")\",\"body\":\"$(esc "${4:-}")\"}"
    ;;
  clear)
    signed_post /api/notice '{"clear":true}'
    ;;
  -h|--help|help) usage 0 ;;
  *) die "unknown command '$1' (try --help)" ;;
esac
