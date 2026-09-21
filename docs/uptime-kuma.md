# Wiring the agent into Uptime Kuma

The status page does not need Uptime Kuma — it keeps its own history in KV.
Connect them anyway if you want Kuma's alerting (push notifications, email,
Telegram, …) and its longer retention on top of the public page.

The agent pushes to Kuma **push monitors**, so Kuma never needs to reach out to
anything and nothing has to be exposed.

## Setup

1. In Uptime Kuma: **Add New Monitor → Monitor Type: Push**.
2. Name it after what it represents, e.g. *Tailscale exit node (overall)*.
3. Set **Heartbeat Interval** to a little more than your agent interval —
   `180` seconds for the default 120s agent — so a single slow run does not
   trip a false alarm.
4. Copy the **Push URL**. It looks like
   `http://homeassistant.local:3001/api/push/aBcDeF12`.
5. Add it to `agent.conf` as `KUMA_PUSH_<check id>`:

   ```sh
   KUMA_PUSH_overall="http://homeassistant.local:3001/api/push/aBcDeF12"
   ```

Repeat for any individual check you want alerting on.

## Available check ids

Run the agent with `--dry-run` to see exactly which ids your Pi produces — it
varies with what is detectable in your environment.

| Check id | What it means | Suggested |
|---|---|---|
| `overall` | Worst status across every agent check | **yes** |
| `egress_internet` | The Pi can actually reach the internet | **yes** |
| `dns_resolution` | Name lookups work | **yes** |
| `ts_backend` | `tailscaled` is running and logged in | yes, if the CLI is reachable |
| `ts_addon` | Tailscale add-on container is running | yes, on HAOS without the CLI |
| `ts_path` | UDP open vs. DERP-relayed | optional |
| `ip_forwarding` | Kernel will forward traffic | optional |
| `upstream_quality` | Packet loss to the ping target | optional |
| `pi_temp` | CPU temperature | optional |
| `pi_disk` | Disk usage | optional |
| `kuma_addon` | Uptime Kuma itself | no — it cannot report its own death |

In each push the agent sends `status` (`up` unless the check is `down`), `msg`
(the same human-readable sentence shown on the status page) and `ping` (exit
latency in ms), so Kuma's response-time graph tracks real egress latency.

## Note on `degraded`

Uptime Kuma push monitors only accept `up` or `down`. The agent maps
`degraded` to **up**, because a degraded exit node still carries traffic. The
public status page keeps the distinction; Kuma only alerts on genuine
outages. If you would rather be paged on degradation too, add a second push
monitor for the specific check you care about.

## Optional: link Kuma from the status page

If you publish an Uptime Kuma status page, put its URL in `wrangler.toml`:

```toml
UPTIME_KUMA_URL = "https://status.example.com/status/exit-node"
```

It appears as a "Detailed monitors" link in the footer. Leave it empty to hide
the link — and do not point it at a Kuma instance that is not meant to be
public.
