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
| **Add-on `advertise_exit_node` / `userspace_networking`** | **Supervisor API** | **same** |
| `tailscale status`, `netcheck`, DERP path | Tailscale CLI | protection mode off (see below) |
| **Node online, exit route advertised *and approved*, key expiry** | **Tailscale API, from the Worker** | **nothing on the Pi** |

Two rows deserve attention.

The **add-on options row** catches the failure mode that is unique to running
Tailscale as a Home Assistant add-on: the exit node is configured through the
add-on's own options, so `tailscaled` can be perfectly healthy while the Pi
routes nobody's traffic. The agent reads those options straight from the
Supervisor API and reports two specific problems:

- `advertise_exit_node` is **off** — the Pi is not offering itself as an exit
  node at all.
- `userspace_networking` is **on** — Tailscale cannot route other devices'
  traffic in userspace mode, so exit node use will not work until it is
  switched off. This is the single most common reason a Home Assistant
  Tailscale exit node silently does nothing.

The `advertise_exit_node` check is advisory: if the Tailscale API can see the
route actually being advertised (you can also set it through `tailscaled_args`),
the Worker drops the option check rather than raising a false alarm.

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

You normally do not need to: the agent discovers add-on slugs from the
Supervisor API by matching on name and slug, because the hash prefix in a slug
depends on which repository the add-on came from (`a0d7b954_tailscale` from the
community add-ons, but Uptime Kuma usually carries a different hash). Set
`TAILSCALE_ADDON_SLUG` only to disambiguate. Confirm with `ha addons list`.

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

# Which add-on slugs did it find? (--verbose prints them)
/config/ts-health/ts-health-agent.sh --dry-run --verbose 2>&1 | grep 'add-on slugs'

# What options is the Tailscale add-on actually running with?
curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/addons/a0d7b954_tailscale/info | jq '.data.options'
```

If the push is rejected with `timestamp outside replay window`, the Pi's clock
has drifted. HAOS syncs time over NTP; check the host's network access.
