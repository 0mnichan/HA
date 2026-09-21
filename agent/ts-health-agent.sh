#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Tailscale exit node health agent.
#
# Runs on the Raspberry Pi, collects the health facts that only the Pi can
# see, pushes them to the status Worker and (optionally) to Uptime Kuma push
# monitors. Outbound only - nothing needs to be exposed to the internet.
#
# Works in two environments:
#   * Home Assistant OS, from the "Advanced SSH & Web Terminal" add-on
#   * A plain Raspberry Pi OS / Debian install with Tailscale installed
#
# Usage:
#   ts-health-agent.sh              # collect, push, exit
#   ts-health-agent.sh --dry-run    # print the JSON, push nothing
#   ts-health-agent.sh --verbose    # explain what it is doing on stderr
# ---------------------------------------------------------------------------

set -uo pipefail

AGENT_VERSION="1.0.0"

# --- configuration ---------------------------------------------------------

CONFIG_FILE="${CONFIG_FILE:-/etc/ts-health-agent.conf}"
[ -f "$CONFIG_FILE" ] && . "$CONFIG_FILE"
# A config next to the script wins, which keeps a git checkout self-contained.
_here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$_here/agent.conf" ] && . "$_here/agent.conf"

STATUS_ENDPOINT="${STATUS_ENDPOINT:-}"              # https://status.example.workers.dev
INGEST_SECRET="${INGEST_SECRET:-}"                  # must match the Worker secret
CONNECTIVITY_URL="${CONNECTIVITY_URL:-https://connectivitycheck.gstatic.com/generate_204}"
PING_TARGET="${PING_TARGET:-1.1.1.1}"
PING_COUNT="${PING_COUNT:-5}"
DIRECT_IP_URL="${DIRECT_IP_URL:-https://1.1.1.1/}"  # used to tell DNS failure from no internet
DISK_PATH="${DISK_PATH:-auto}"
# Left empty on purpose: these are discovered from the Supervisor API, since
# an add-on's slug carries the hash of whichever repository it came from.
TAILSCALE_ADDON_SLUG="${TAILSCALE_ADDON_SLUG:-}"
KUMA_ADDON_SLUG="${KUMA_ADDON_SLUG:-}"
TAILSCALE_CLI="${TAILSCALE_CLI:-}"                  # override, e.g. a docker exec wrapper
EGRESS_IP_LOOKUP="${EGRESS_IP_LOOKUP:-false}"       # third-party lookup; off by default
CURL_TIMEOUT="${CURL_TIMEOUT:-8}"
TEMP_WARN_C="${TEMP_WARN_C:-75}"
TEMP_CRIT_C="${TEMP_CRIT_C:-82}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
DISK_CRIT_PCT="${DISK_CRIT_PCT:-92}"
LATENCY_WARN_MS="${LATENCY_WARN_MS:-400}"

DRY_RUN=false
VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --verbose|-v) VERBOSE=true ;;
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { $VERBOSE && echo "[agent] $*" >&2; return 0; }
die() { echo "[agent] ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq   >/dev/null 2>&1 || die "jq is required (apk add jq / apt install jq)"

# --- check accumulator -----------------------------------------------------

CHECKS_FILE="$(mktemp)"
trap 'rm -f "$CHECKS_FILE"' EXIT
: > "$CHECKS_FILE"

# add_check <id> <label> <group> <status> <message> [metric] [critical]
add_check() {
  jq -cn \
    --arg id "$1" --arg label "$2" --arg group "$3" --arg status "$4" \
    --arg message "$5" --arg metric "${6:-}" --argjson critical "${7:-false}" \
    '{id:$id,label:$label,group:$group,status:$status,message:$message,metric:$metric,critical:$critical}' \
    >> "$CHECKS_FILE"
  log "$4  $1 - $5"
}

# Numeric helpers that avoid `bc` (not present on Alpine by default).
fnum() { awk -v v="$1" 'BEGIN{ if (v=="" || v+0!=v) exit 1; printf "%.2f", v }' 2>/dev/null; }
fge()  { awk -v a="$1" -v b="$2" 'BEGIN{ exit !(a+0 >= b+0) }'; }

# --- Tailscale CLI discovery ----------------------------------------------

TS_CLI=""
detect_ts_cli() {
  if [ -n "$TAILSCALE_CLI" ]; then TS_CLI="$TAILSCALE_CLI"; return 0; fi
  if command -v tailscale >/dev/null 2>&1; then TS_CLI="tailscale"; return 0; fi
  # Home Assistant OS: the CLI lives inside the Tailscale add-on container.
  # Only reachable if the SSH add-on has protection mode disabled.
  if command -v docker >/dev/null 2>&1 \
     && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "addon_${TAILSCALE_ADDON_SLUG}"; then
    TS_CLI="docker exec addon_${TAILSCALE_ADDON_SLUG} tailscale"
    return 0
  fi
  return 1
}

# --- Home Assistant Supervisor --------------------------------------------

SUPERVISOR_AVAILABLE=false
supervisor_get() {
  curl -fsS --max-time 6 \
    -H "Authorization: Bearer ${SUPERVISOR_TOKEN:-}" \
    "http://supervisor/$1" 2>/dev/null
}
if [ -n "${SUPERVISOR_TOKEN:-}" ] && supervisor_get "info" >/dev/null 2>&1; then
  SUPERVISOR_AVAILABLE=true
  log "Supervisor API is reachable"
fi

# The agent asks about the same add-on several times, so keep the last answer.
_addon_cache=""
_addon_cache_slug=""
addon_info() {
  [ -z "${1:-}" ] && return 1
  if [ "$1" != "$_addon_cache_slug" ]; then
    _addon_cache="$(supervisor_get "addons/$1/info")"
    _addon_cache_slug="$1"
  fi
  [ -n "$_addon_cache" ] || return 1
  printf '%s' "$_addon_cache"
}

addon_state() { addon_info "$1" | jq -r '.data.state // empty' 2>/dev/null; }
addon_opt()   { addon_info "$1" | jq -r --arg k "$2" '.data.options[$k] // empty' 2>/dev/null; }

# Match an add-on by slug or name rather than hardcoding a repository hash.
discover_addon() {
  supervisor_get "addons" | jq -r --arg re "$1" '
    [.data.addons[]?
     | select(((.slug // "") | test($re; "i")) or ((.name // "") | test($re; "i")))
     | .slug] | first // empty' 2>/dev/null
}

if $SUPERVISOR_AVAILABLE; then
  [ -z "$TAILSCALE_ADDON_SLUG" ] && TAILSCALE_ADDON_SLUG="$(discover_addon 'tailscale')"
  [ -z "$KUMA_ADDON_SLUG" ]      && KUMA_ADDON_SLUG="$(discover_addon 'uptime.?kuma')"
  log "add-on slugs: tailscale=[${TAILSCALE_ADDON_SLUG:-not found}] kuma=[${KUMA_ADDON_SLUG:-not found}]"
fi
# Fall back to the community add-on's slug so the docker-exec path still works
# when the Supervisor API is not reachable.
TAILSCALE_ADDON_SLUG="${TAILSCALE_ADDON_SLUG:-a0d7b954_tailscale}"

# ===========================================================================
# Checks
# ===========================================================================

# --- 1. Tailscale daemon ---------------------------------------------------

TS_BACKEND=""
if detect_ts_cli; then
  log "using Tailscale CLI: $TS_CLI"
  # shellcheck disable=SC2086 -- TS_CLI may legitimately be a multi-word command
  TS_JSON="$($TS_CLI status --json 2>/dev/null)"
  if [ -n "$TS_JSON" ] && echo "$TS_JSON" | jq -e . >/dev/null 2>&1; then
    TS_BACKEND="$(echo "$TS_JSON" | jq -r '.BackendState // "Unknown"')"
    case "$TS_BACKEND" in
      Running)
        add_check ts_backend "Tailscale daemon" "Tailscale" operational \
          "tailscaled is running and logged in." "$TS_BACKEND" true ;;
      Stopped)
        add_check ts_backend "Tailscale daemon" "Tailscale" down \
          "Tailscale is installed and logged in but has been stopped, so the exit node is not serving anyone." \
          "$TS_BACKEND" true ;;
      NeedsLogin|NeedsMachineAuth)
        add_check ts_backend "Tailscale daemon" "Tailscale" down \
          "Tailscale needs to be re-authenticated before it can act as an exit node." "$TS_BACKEND" true ;;
      Starting|NoState)
        add_check ts_backend "Tailscale daemon" "Tailscale" degraded \
          "Tailscale is still starting up." "$TS_BACKEND" false ;;
      *)
        add_check ts_backend "Tailscale daemon" "Tailscale" unknown \
          "Unrecognised Tailscale backend state." "$TS_BACKEND" false ;;
    esac

    # Locally-visible exit node advertisement. The Worker cross-checks this
    # against the Tailscale API, which also knows about admin approval.
    ADV="$(echo "$TS_JSON" | jq -r '[.Self.AllowedIPs // [] | .[]] | join(",")' 2>/dev/null)"
    if echo "$ADV" | grep -q '0\.0\.0\.0/0'; then
      add_check exit_local_route "Default route active on the node" "Exit node" operational \
        "The node is locally serving 0.0.0.0/0." "" false
    elif [ "$TS_BACKEND" = "Running" ]; then
      add_check exit_local_route "Default route active on the node" "Exit node" degraded \
        "The node is not currently serving a default route locally. If the admin console shows it approved, the daemon may need a restart." "" false
    fi
  else
    add_check ts_backend "Tailscale daemon" "Tailscale" down \
      "The Tailscale CLI is present but did not return a status, which usually means tailscaled is not running." "" true
  fi
elif $SUPERVISOR_AVAILABLE; then
  # No CLI reachable - fall back to whether the add-on container is running.
  STATE="$(addon_state "$TAILSCALE_ADDON_SLUG")"
  case "$STATE" in
    started)
      add_check ts_addon "Tailscale add-on" "Tailscale" operational \
        "The Tailscale add-on is running." "started" true ;;
    "")
      add_check ts_addon "Tailscale add-on" "Tailscale" unknown \
        "The Tailscale add-on could not be found under slug ${TAILSCALE_ADDON_SLUG}. Set TAILSCALE_ADDON_SLUG in the agent config." "" false ;;
    *)
      add_check ts_addon "Tailscale add-on" "Tailscale" down \
        "The Tailscale add-on is not running (state: ${STATE})." "$STATE" true ;;
  esac
else
  add_check ts_local "Tailscale visibility from the Pi" "Tailscale" unknown \
    "Neither the Tailscale CLI nor the Supervisor API is reachable from the agent, so local Tailscale state is unknown. The Tailscale API check still applies." "" false
fi

# --- 1b. Tailscale add-on exit node configuration --------------------------
# Home Assistant OS specific: the exit node is configured through the add-on's
# own options, so tailscaled can be perfectly healthy and still route nothing.

if $SUPERVISOR_AVAILABLE && addon_info "$TAILSCALE_ADDON_SLUG" >/dev/null 2>&1; then
  ADV_EXIT="$(addon_opt "$TAILSCALE_ADDON_SLUG" advertise_exit_node)"
  USERSPACE="$(addon_opt "$TAILSCALE_ADDON_SLUG" userspace_networking)"

  case "$ADV_EXIT" in
    true)
      add_check ts_addon_exit_config "Add-on set to advertise an exit node" "Exit node" operational         "The Tailscale add-on has 'advertise_exit_node' turned on." "on" false ;;
    false)
      add_check ts_addon_exit_config "Add-on set to advertise an exit node" "Exit node" down         "The Tailscale add-on has 'advertise_exit_node' turned off, so the Pi is not offering itself as an exit node at all. Turn it on in the add-on configuration and restart it."         "off" true ;;
    *) : ;;  # Option absent on this add-on build - stay quiet rather than guess.
  esac

  if [ "$USERSPACE" = "true" ]; then
    add_check ts_addon_userspace "Add-on networking mode" "Exit node" down       "The Tailscale add-on is running with 'userspace_networking' turned on. Tailscale cannot route other devices' traffic in that mode, so the exit node will not work until it is switched off."       "userspace" true
  fi
fi

# --- 2. DERP / UDP path ----------------------------------------------------

if [ -n "$TS_CLI" ] && [ "$TS_BACKEND" = "Running" ]; then
  # shellcheck disable=SC2086
  NETCHECK="$($TS_CLI netcheck --format=json 2>/dev/null)"
  if [ -n "$NETCHECK" ] && echo "$NETCHECK" | jq -e . >/dev/null 2>&1; then
    UDP_OK="$(echo "$NETCHECK" | jq -r '.UDP // false')"
    VARIES="$(echo "$NETCHECK" | jq -r '.MappingVariesByDestIP // false')"
    if [ "$UDP_OK" = "true" ]; then
      if [ "$VARIES" = "true" ]; then
        add_check ts_path "Direct connection path" "Tailscale" degraded \
          "UDP works but this network uses hard NAT, so some clients will fall back to a relay and see lower throughput." "hard NAT" false
      else
        add_check ts_path "Direct connection path" "Tailscale" operational \
          "UDP is open, so clients can connect directly for full speed." "direct" false
      fi
    else
      add_check ts_path "Direct connection path" "Tailscale" degraded \
        "UDP is blocked on this network, so all exit node traffic is relayed through DERP. It works, but it will be noticeably slower." "relayed" false
    fi
  fi
fi

# --- 3. IP forwarding ------------------------------------------------------

read_sysctl() { [ -r "$1" ] && cat "$1" 2>/dev/null || echo ""; }
FWD4="$(read_sysctl /proc/sys/net/ipv4/ip_forward)"
FWD6="$(read_sysctl /proc/sys/net/ipv6/conf/all/forwarding)"

if [ "$FWD4" = "1" ] && { [ "$FWD6" = "1" ] || [ -z "$FWD6" ]; }; then
  add_check ip_forwarding "IP forwarding enabled" "Exit node" operational \
    "The kernel is configured to forward traffic, which an exit node needs." "on" false
elif [ "$FWD4" = "1" ]; then
  add_check ip_forwarding "IP forwarding enabled" "Exit node" degraded \
    "IPv4 forwarding is on but IPv6 forwarding is off, so IPv6 destinations will not work through the exit node." "IPv4 only" false
elif [ -z "$FWD4" ]; then
  add_check ip_forwarding "IP forwarding enabled" "Exit node" unknown \
    "Could not read the kernel forwarding setting from this container." "" false
else
  add_check ip_forwarding "IP forwarding enabled" "Exit node" down \
    "IP forwarding is disabled, so the node cannot route anyone's traffic even though it advertises itself as an exit node." "off" false
fi

# --- 4. Internet egress + DNS ---------------------------------------------

EXIT_LATENCY_MS=""
DNS_LATENCY_MS=""

CURL_OUT="$(curl -sS -o /dev/null --max-time "$CURL_TIMEOUT" \
  -w '%{http_code} %{time_namelookup} %{time_total}' "$CONNECTIVITY_URL" 2>/dev/null)"
CURL_RC=$?
HTTP_CODE="$(echo "$CURL_OUT" | awk '{print $1}')"
T_DNS="$(echo "$CURL_OUT"  | awk '{print $2}')"
T_TOTAL="$(echo "$CURL_OUT" | awk '{print $3}')"

if [ "$CURL_RC" -eq 0 ] && [ "${HTTP_CODE:-0}" -ge 200 ] && [ "${HTTP_CODE:-0}" -lt 400 ]; then
  EXIT_LATENCY_MS="$(awk -v t="$T_TOTAL" 'BEGIN{printf "%.0f", t*1000}')"
  DNS_LATENCY_MS="$(awk -v t="$T_DNS"   'BEGIN{printf "%.0f", t*1000}')"
  if fge "$EXIT_LATENCY_MS" "$LATENCY_WARN_MS"; then
    add_check egress_internet "Internet reachable from the Pi" "Exit node" degraded \
      "The Pi can reach the internet, but responses are slow (${EXIT_LATENCY_MS} ms). Traffic through the exit node will feel sluggish." \
      "${EXIT_LATENCY_MS} ms" true
  else
    add_check egress_internet "Internet reachable from the Pi" "Exit node" operational \
      "The Pi reached the internet in ${EXIT_LATENCY_MS} ms, so traffic routed through it gets out." \
      "${EXIT_LATENCY_MS} ms" true
  fi
  add_check dns_resolution "DNS resolution" "Exit node" operational \
    "Name lookups are working (${DNS_LATENCY_MS} ms)." "${DNS_LATENCY_MS} ms" false
else
  # Distinguish "DNS is broken" from "there is no internet at all".
  DIRECT_RC=1
  if curl -sS -o /dev/null -k --max-time 6 "$DIRECT_IP_URL" >/dev/null 2>&1; then DIRECT_RC=0; fi

  if [ "$CURL_RC" -eq 6 ] || { [ "$DIRECT_RC" -eq 0 ] && [ -z "$HTTP_CODE" ]; }; then
    add_check dns_resolution "DNS resolution" "Exit node" down \
      "The Pi cannot resolve hostnames, so anything routed through the exit node will fail to load by name even though raw connectivity is fine." \
      "no resolve" true
    add_check egress_internet "Internet reachable from the Pi" "Exit node" degraded \
      "Raw IP connectivity works but DNS does not, so most traffic will appear broken." "IP only" true
  elif [ "$DIRECT_RC" -eq 0 ]; then
    add_check egress_internet "Internet reachable from the Pi" "Exit node" degraded \
      "The connectivity endpoint did not respond as expected (curl exit ${CURL_RC}, HTTP ${HTTP_CODE:-none}), but the Pi can still reach the wider internet." \
      "partial" true
  else
    add_check egress_internet "Internet reachable from the Pi" "Exit node" down \
      "The Pi has no working internet connection (curl exit ${CURL_RC}). Anything using this exit node has no internet either." \
      "offline" true
  fi
fi

# --- 5. Upstream quality ---------------------------------------------------

PACKET_LOSS=""
if command -v ping >/dev/null 2>&1; then
  PING_OUT="$(ping -c "$PING_COUNT" -W 2 "$PING_TARGET" 2>/dev/null)"
  if [ -n "$PING_OUT" ]; then
    PACKET_LOSS="$(echo "$PING_OUT" | grep -o '[0-9]\{1,3\}% packet loss' | head -1 | tr -d '%' | awk '{print $1}')"
  fi
  if [ -n "$PACKET_LOSS" ]; then
    if [ "$PACKET_LOSS" -ge 20 ] 2>/dev/null; then
      add_check upstream_quality "Home internet quality" "Exit node" down \
        "${PACKET_LOSS}% of packets to ${PING_TARGET} are being lost. The home connection itself is in trouble." \
        "${PACKET_LOSS}% loss" false
    elif [ "$PACKET_LOSS" -gt 0 ] 2>/dev/null; then
      add_check upstream_quality "Home internet quality" "Exit node" degraded \
        "${PACKET_LOSS}% packet loss to ${PING_TARGET}. Expect occasional stalls through the exit node." \
        "${PACKET_LOSS}% loss" false
    else
      add_check upstream_quality "Home internet quality" "Exit node" operational \
        "No packet loss to ${PING_TARGET}." "0% loss" false
    fi
  fi
fi

# --- 6. Host health --------------------------------------------------------

CPU_TEMP=""
if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
  CPU_TEMP="$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"
elif command -v vcgencmd >/dev/null 2>&1; then
  CPU_TEMP="$(vcgencmd measure_temp 2>/dev/null | grep -o '[0-9.]\+' | head -1)"
fi
if [ -n "$CPU_TEMP" ]; then
  if fge "$CPU_TEMP" "$TEMP_CRIT_C"; then
    add_check pi_temp "CPU temperature" "Host" down \
      "The Pi is at ${CPU_TEMP}°C and is throttling, which will slow every connection through it." "${CPU_TEMP}°C" false
  elif fge "$CPU_TEMP" "$TEMP_WARN_C"; then
    add_check pi_temp "CPU temperature" "Host" degraded \
      "The Pi is running hot at ${CPU_TEMP}°C and may start throttling." "${CPU_TEMP}°C" false
  else
    add_check pi_temp "CPU temperature" "Host" operational \
      "Temperature is normal at ${CPU_TEMP}°C." "${CPU_TEMP}°C" false
  fi
fi

if [ "$DISK_PATH" = "auto" ]; then
  if [ -d /config ]; then DISK_PATH=/config; else DISK_PATH=/; fi
fi
DISK_PCT="$(df -P "$DISK_PATH" 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
if [ -n "$DISK_PCT" ]; then
  if [ "$DISK_PCT" -ge "$DISK_CRIT_PCT" ] 2>/dev/null; then
    add_check pi_disk "Disk space" "Host" down \
      "Storage is ${DISK_PCT}% full. Services on the Pi will start failing." "${DISK_PCT}%" false
  elif [ "$DISK_PCT" -ge "$DISK_WARN_PCT" ] 2>/dev/null; then
    add_check pi_disk "Disk space" "Host" degraded \
      "Storage is ${DISK_PCT}% full and needs attention soon." "${DISK_PCT}%" false
  else
    add_check pi_disk "Disk space" "Host" operational \
      "Storage is ${DISK_PCT}% full." "${DISK_PCT}%" false
  fi
fi

LOAD1="$(awk '{print $1}' /proc/loadavg 2>/dev/null)"
MEM_PCT=""
if [ -r /proc/meminfo ]; then
  MEM_PCT="$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{ if (t>0) printf "%.1f", (t-a)/t*100 }' /proc/meminfo)"
fi
UPTIME_S="$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null)"

# --- 7. Home Assistant side-cars ------------------------------------------

if $SUPERVISOR_AVAILABLE && [ -n "$KUMA_ADDON_SLUG" ]; then
  KUMA_STATE="$(addon_state "$KUMA_ADDON_SLUG")"
  if [ "$KUMA_STATE" = "started" ]; then
    add_check kuma_addon "Uptime Kuma" "Host" operational "Monitoring add-on is running." "started" false
  elif [ -n "$KUMA_STATE" ]; then
    add_check kuma_addon "Uptime Kuma" "Host" degraded \
      "The Uptime Kuma add-on is not running (state: ${KUMA_STATE}). This does not affect the exit node itself." "$KUMA_STATE" false
  fi

  HA_STATE="$(supervisor_get "core/info" | jq -r '.data.state // empty' 2>/dev/null)"
  if [ -n "$HA_STATE" ] && [ "$HA_STATE" != "running" ]; then
    add_check ha_core "Home Assistant core" "Host" degraded \
      "Home Assistant core is in state '${HA_STATE}'. This does not affect the exit node itself." "$HA_STATE" false
  fi
fi

# --- 8. Optional egress identity ------------------------------------------

EGRESS_IP=""
EGRESS_NET=""
if [ "$EGRESS_IP_LOOKUP" = "true" ]; then
  TRACE="$(curl -sS --max-time 6 https://1.1.1.1/cdn-cgi/trace 2>/dev/null)"
  EGRESS_IP="$(echo "$TRACE" | awk -F= '/^ip=/{print $2}')"
  # `loc` is the country Cloudflare sees the traffic coming from - useful to
  # exit node users, who mostly care which country they appear to be in.
  EGRESS_NET="$(echo "$TRACE" | awk -F= '/^loc=/{print $2}')"
fi

# ===========================================================================
# Assemble and send
# ===========================================================================

CHECKS_JSON="$(jq -s '.' "$CHECKS_FILE")"

PAYLOAD="$(jq -cn \
  --arg agentVersion "$AGENT_VERSION" \
  --argjson checks "$CHECKS_JSON" \
  --arg exitLatencyMs "${EXIT_LATENCY_MS:-}" \
  --arg dnsLatencyMs "${DNS_LATENCY_MS:-}" \
  --arg packetLossPct "${PACKET_LOSS:-}" \
  --arg cpuTempC "${CPU_TEMP:-}" \
  --arg load1 "${LOAD1:-}" \
  --arg memUsedPct "${MEM_PCT:-}" \
  --arg diskUsedPct "${DISK_PCT:-}" \
  --arg uptimeSeconds "${UPTIME_S:-}" \
  --arg egressIp "${EGRESS_IP:-}" \
  --arg egressNetwork "${EGRESS_NET:-}" \
  '
  def num($s): if ($s | length) > 0 then ($s | tonumber? // null) else null end;
  {
    agentVersion: $agentVersion,
    checks: $checks,
    metrics: ({
      exitLatencyMs: num($exitLatencyMs),
      dnsLatencyMs:  num($dnsLatencyMs),
      packetLossPct: num($packetLossPct)
    } | with_entries(select(.value != null))),
    host: ({
      cpuTempC:       num($cpuTempC),
      load1:          num($load1),
      memUsedPct:     num($memUsedPct),
      diskUsedPct:    num($diskUsedPct),
      uptimeSeconds:  num($uptimeSeconds)
    } | with_entries(select(.value != null))),
    egressIp: $egressIp,
    egressNetwork: $egressNetwork
  }')"

# Worst status across the agent's own checks - used for the Uptime Kuma push.
OVERALL="$(echo "$CHECKS_JSON" | jq -r '
  def rank: {"operational":0,"unknown":1,"maintenance":1,"degraded":2,"down":3}[.] // 1;
  ([.[] | if .critical then .status else (if .status == "down" then "degraded" else .status end) end]
   | max_by(rank)) // "unknown"')"

if $DRY_RUN; then
  echo "$PAYLOAD" | jq .
  echo "--- overall: $OVERALL ---" >&2
  exit 0
fi

# --- push to Uptime Kuma ---------------------------------------------------
# Define KUMA_PUSH_<check_id> (dashes become underscores) in the config file,
# plus an optional KUMA_PUSH_overall, to mirror checks into Uptime Kuma.

kuma_push() {
  local url="$1" status="$2" msg="$3" ping="$4"
  [ -z "$url" ] && return 0
  local kstatus="up"
  case "$status" in down) kstatus="down" ;; esac
  curl -fsS --max-time 6 -G "$url" \
    --data-urlencode "status=${kstatus}" \
    --data-urlencode "msg=${msg}" \
    --data-urlencode "ping=${ping}" >/dev/null 2>&1 \
    || log "Uptime Kuma push failed for ${url%%\?*}"
}

kuma_push "${KUMA_PUSH_overall:-}" "$OVERALL" "$OVERALL" "${EXIT_LATENCY_MS:-0}"

while IFS=$'\t' read -r cid cstatus cmsg; do
  var="KUMA_PUSH_$(echo "$cid" | tr '-' '_')"
  url="${!var:-}"
  [ -n "$url" ] && kuma_push "$url" "$cstatus" "$cmsg" "${EXIT_LATENCY_MS:-0}"
done < <(echo "$CHECKS_JSON" | jq -r '.[] | [.id, .status, .message] | @tsv')

# --- push to the status Worker --------------------------------------------

if [ -z "$STATUS_ENDPOINT" ] || [ -z "$INGEST_SECRET" ]; then
  log "STATUS_ENDPOINT or INGEST_SECRET is unset - skipping the status push"
  exit 0
fi

command -v openssl >/dev/null 2>&1 || die "openssl is required to sign the report"

TS_NOW="$(date +%s)"
SIG="$(printf '%s' "${TS_NOW}.${PAYLOAD}" \
  | openssl dgst -sha256 -hmac "$INGEST_SECRET" -hex 2>/dev/null \
  | awk '{print $NF}')"
[ -n "$SIG" ] || die "failed to compute the request signature"

attempt=1
delay=2
while [ "$attempt" -le 4 ]; do
  RESP="$(printf '%s' "$PAYLOAD" | curl -sS --max-time 15 \
    -X POST "${STATUS_ENDPOINT%/}/api/ingest" \
    -H 'Content-Type: application/json' \
    -H "X-Timestamp: ${TS_NOW}" \
    -H "X-Signature: sha256=${SIG}" \
    --data-binary @- 2>&1)"
  RC=$?
  if [ "$RC" -eq 0 ] && echo "$RESP" | jq -e '.ok == true' >/dev/null 2>&1; then
    log "reported: $(echo "$RESP" | jq -c .)"
    exit 0
  fi
  log "push attempt ${attempt} failed (curl ${RC}): ${RESP}"
  # Do not retry an auth or validation failure - it will not fix itself.
  if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
    echo "[agent] ERROR: status service rejected the report: $RESP" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -le 4 ] && sleep "$delay" && delay=$((delay * 2))
done

echo "[agent] ERROR: could not reach ${STATUS_ENDPOINT} after 4 attempts" >&2
exit 1
