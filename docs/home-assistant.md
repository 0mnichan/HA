# Running the agent on Home Assistant OS

Home Assistant OS is not a normal Linux box: there is no systemd you can add
units to, and the `tailscale` CLI lives inside the Tailscale add-on's own
container. This page covers the setup that works anyway.

## What the agent can and cannot see under HAOS

| Fact | How it is obtained | Needs |
|---|---|---|
| Tailscale add-on running | Supervisor API | `SUPERVISOR_TOKEN` (automatic in the SSH add-on) |
| Uptime Kuma add-on running | Supervisor API | same |
| Home Assistant core state | Supervisor API | same |
| Internet egress, DNS, latency, packet loss | Direct from the add-on container | nothing |
| CPU temp, disk, memory, load, uptime | `/proc`, `/sys` | nothing |
| `tailscale status`, `netcheck`, DERP path | Tailscale CLI | protection mode off (see below) |
| **Node online, exit route advertised *and approved*, key expiry** | **Tailscale API, from the Worker** | **nothing on the Pi** |

The last row is the important one. The exit-node facts people actually care
about are collected by the Worker talking to the Tailscale API, not by the Pi.
That is deliberate: those checks keep working when the Pi is offline, and they
also mean you do **not** need to disable protection mode to get a useful page.

## Install (Advanced SSH & Web Terminal add-on)

1. Install the **Advanced SSH & Web Terminal** add-on and open its terminal.

2. Install the dependencies and drop the agent in `/config` so it survives
   add-on updates:

   ```sh
   apk add --no-cache bash jq curl openssl
   mkdir -p /config/ts-health
   cd /config/ts-health
   wget -O ts-health-agent.sh \
     https://raw.githubusercontent.com/0mnichan/HA/prod/gallant-curie-vzxjx8/agent/ts-health-agent.sh
   wget -O run-loop.sh \
     https://raw.githubusercontent.com/0mnichan/HA/prod/gallant-curie-vzxjx8/agent/run-loop.sh
   chmod +x ts-health-agent.sh run-loop.sh
   ```

3. Create `/config/ts-health/agent.conf` from `agent.conf.example` and fill in
   `STATUS_ENDPOINT` and `INGEST_SECRET`. Then lock it down:

   ```sh
   chmod 600 /config/ts-health/agent.conf
   ```

4. Check it collects sensibly before scheduling anything:

   ```sh
   ./ts-health-agent.sh --dry-run --verbose
   ```

5. Schedule it. Open the add-on's **Configuration** tab and add `init_commands`:

   ```yaml
   init_commands:
     - echo "*/2 * * * * /config/ts-health/ts-health-agent.sh >/dev/null 2>&1" > /etc/crontabs/root
     - crond -b -l 8
   ```

   Restart the add-on. `crond` is busybox cron and is already present.

   If you would rather not use cron, background the loop runner instead —
   the effect is the same:

   ```yaml
   init_commands:
     - nohup /config/ts-health/run-loop.sh 120 >/dev/null 2>&1 &
   ```

> Whichever you pick, the agent only runs while the SSH add-on is running.
> Set that add-on to **start on boot**, or the page will show the agent as
> stale after every Home Assistant restart. The Tailscale API checks keep
> reporting regardless, so the page stays useful — just less detailed.

## Optional: give the agent the Tailscale CLI

With the CLI reachable the agent adds two checks: the exact `tailscaled`
backend state, and a `netcheck` that reveals whether UDP is blocked (which
forces all exit-node traffic through a DERP relay and makes it noticeably
slower).

This requires turning **Protection mode off** on the SSH add-on, which gives it
access to the Docker socket. That is a real reduction in isolation — decide
whether the two extra checks are worth it. Everything else works without it.

If you do turn it off, the agent auto-detects the container. To pin it
explicitly, set in `agent.conf`:

```sh
TAILSCALE_CLI="docker exec addon_a0d7b954_tailscale tailscale"
```

Confirm your slug with `ha addons list | grep -i tailscale` — it differs
between the community add-on and other builds.

## A note on the IP-forwarding check

The agent reads `/proc/sys/net/ipv4/ip_forward`. The SSH add-on uses host
networking, so this normally reflects the host's real setting. If your setup
differs, the check reports `unknown` rather than guessing — it is never
treated as a critical failure on its own.

## Troubleshooting

```sh
# What is the agent actually seeing?
/config/ts-health/ts-health-agent.sh --dry-run --verbose

# Is cron running at all?
ps | grep crond

# Is the Supervisor API reachable? (should print a JSON blob)
curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/info
```

If the push is rejected with `timestamp outside replay window`, the Pi's clock
has drifted. HAOS syncs time over NTP; check the host's network access.
