# Tailscale exit node status page

A public status page for a Raspberry Pi Tailscale exit node running under Home
Assistant, so the people using your exit node can tell — without asking you —
whether it is working, and if not, what is actually wrong.

It answers three questions:

1. **Is the exit node usable right now?** One plain-English verdict at the top,
   with what the viewer should do about it (including "turn the exit node off
   in your Tailscale client" when it is down).
2. **What is the problem?** Every check reports a sentence, not a red dot:
   *"The Pi cannot resolve hostnames, so anything routed through the exit node
   will fail to load by name even though raw connectivity is fine."*
3. **Is Tailscale itself healthy on the Pi?** Daemon or add-on state, whether
   the node is online per Tailscale's own coordination server, whether
   `0.0.0.0/0` is both advertised *and approved*, node key expiry, and whether
   UDP is open or everything is being relayed through DERP.

Tailscale here runs as a **Home Assistant add-on**, so the checks include the
two add-on options that silently stop an exit node working —
`advertise_exit_node` being off, and `userspace_networking` being on (in which
mode Tailscale cannot route other devices' traffic at all).

## How it works

```
   Raspberry Pi (Home Assistant OS)          Cloudflare               Viewers
  ┌────────────────────────────────┐     ┌──────────────────┐      ┌──────────┐
  │ ts-health-agent.sh (every 2m)  │     │  Worker          │      │ Anyone   │
  │  · internet egress + DNS       │────▶│   POST /api/     │      │ with the │
  │  · IP forwarding, DERP/UDP     │HMAC │      ingest      │      │ link     │
  │  · CPU temp, disk, load        │     │                  │◀─────│          │
  │  · add-on states (Supervisor)  │     │  KV: one key     │ GET  │          │
  │                                │     │                  │      └──────────┘
  │ Uptime Kuma add-on             │◀────│  cron every 15m  │
  │  (push monitors, alerting)     │push │      │           │
  └────────────────────────────────┘     └──────┼───────────┘
                                                ▼
                                        Tailscale API
                                   (online? route approved?)
```

**Nothing is exposed to the internet.** The Pi only makes outbound requests.
There is no port forward, no tunnel, and Uptime Kuma stays private.

Two independent sources of truth are merged, which is the point of the design:

- **The Pi agent** sees what only the Pi can see — whether traffic actually
  gets out, whether DNS resolves, whether the kernel will forward packets.
- **The Worker's Tailscale API poll** sees what Tailscale's coordination server
  believes, and **keeps working when the Pi is dead** — which is exactly when
  people are looking at the page.

If both go quiet the page says *"Status unknown … treat it as unavailable"*.
It never reports a stale green.

## Quick start

> **Setting this up for the first time? Follow
> [docs/SETUP.md](docs/SETUP.md).** It is the full start-to-finish walkthrough
> for Home Assistant OS, with a verification step after each part. What follows
> here is the condensed version.

### 1. Deploy the Worker

```sh
npm install
npx wrangler kv namespace create STATUS_KV     # paste the id into wrangler.toml
openssl rand -hex 32                           # keep this - the agent needs it
npx wrangler secret put INGEST_SECRET          # paste the value from above
npx wrangler deploy
```

Optional but recommended — the Tailscale-side checks:

```sh
npx wrangler secret put TAILSCALE_API_KEY      # or the OAuth client pair
```

Then set `TAILSCALE_DEVICE` in `wrangler.toml` to your exit node's hostname and
redeploy. An OAuth client with the `devices:core:read` and `routes:read` scopes
is preferable to a personal API key, which expires after 90 days.

### 2. Install the agent on the Pi

**Home Assistant OS — [docs/home-assistant.md](docs/home-assistant.md).**
Read that first. HAOS has real constraints: there is no systemd to add units
to, and the `tailscale` CLI lives inside the add-on's own container, so the
agent runs from the Advanced SSH & Web Terminal add-on and gets the exit-node
facts from the Tailscale API instead of the CLI.

<details>
<summary>Plain Raspberry Pi OS / Debian, with Tailscale installed directly</summary>

```sh
sudo apt install -y curl jq openssl
sudo ./agent/install-systemd.sh
sudo nano /etc/ts-health-agent.conf      # STATUS_ENDPOINT + INGEST_SECRET
sudo systemctl start ts-health-agent.service
```

Verify before trusting it:

```sh
/usr/local/bin/ts-health-agent.sh --dry-run --verbose
```

</details>

### 3. Optional: Uptime Kuma alerting

See [docs/uptime-kuma.md](docs/uptime-kuma.md). The status page keeps its own
history, so this is purely for notifications.

## Posting an incident or maintenance notice

A banner you write yourself, for the things automation cannot know ("ISP
outage, provider says this evening"). A `maintenance` notice also overrides the
computed status.

```sh
export STATUS_ENDPOINT="https://your-worker.workers.dev"
export INGEST_SECRET="..."

./scripts/status-cli.sh notice critical "ISP outage" "Provider says this evening."
./scripts/status-cli.sh notice maintenance "Router upgrade" "Back by 21:00."
./scripts/status-cli.sh clear
```

`scripts/status-cli.sh` signs requests for you. It also has:

```sh
./scripts/status-cli.sh status    # fetch the public status JSON
./scripts/status-cli.sh poll      # run the Tailscale poll now, instead of
                                  # waiting up to 15 minutes for the cron
```

`poll` is the fastest way to tell whether your Tailscale credentials and
`TAILSCALE_DEVICE` are right — it returns the API error verbatim when they
are not.

## Free-tier write budget

Cloudflare KV's free tier allows **1,000 writes per day**. Everything is packed
into a single KV key so each report costs exactly one write:

| Source | Interval | Writes/day |
|---|---|---|
| Pi agent | 120s | 720 |
| Tailscale API cron | 15m | 96 |
| **Total** | | **816** |

That is the reason the agent defaults to 120 seconds rather than 60. If you
lower it, raise the cron interval to match, or move to the Workers Paid plan.
Also lower `AGENT_STALE_AFTER` in `wrangler.toml` to roughly 2.5× your new
interval, or a dead agent will take too long to show up.

Reads are not a concern: the page polls `/api/status` every 30s, which is one
KV read per viewer-poll against a 100,000/day allowance.

## Privacy

The page is public, so the Worker treats everything the agent sends as
untrusted: strings are stripped of control characters and clamped, unknown
status values become `unknown`, and the check list is capped.

- **Your home IP is not published** unless you set `SHOW_EGRESS_IP = "true"`.
- The egress *country* is shown if you enable `EGRESS_IP_LOOKUP` on the agent
  — useful to exit node users, who mostly care which country they appear to be
  in.
- No tailnet name, peer device names, or internal IPs are ever sent.
- The page ships `noindex`. It is unlisted, not secret — treat the URL as
  shareable with the people who use your exit node.

`/api/ingest` and `/api/notice` require an HMAC-SHA256 signature over
`<timestamp>.<body>` with a 5-minute replay window. `/api/status` is public and
read-only.

## Development

```sh
npm test                  # 25 tests, no Cloudflare runtime needed
npm run preview           # http://localhost:8788 with synthetic data
node test/preview.mjs --state=down        # or degraded / unknown / maintenance
```

The preview server runs the real Worker code against an in-memory KV, so what
you see is what deploys.

## Layout

```
docs/SETUP.md              start-to-finish setup guide  <- start here
src/worker.js              ingest, status API, Tailscale poll, status rules
site/                      the status page (no build step, no dependencies)
agent/ts-health-agent.sh   the health agent that runs on the Pi
agent/systemd/             timer + unit for Raspberry Pi OS
scripts/status-cli.sh      signed requests: poll, notices
test/worker.test.mjs       Worker tests
test/preview.mjs           local preview with synthetic data
docs/                      Home Assistant OS and Uptime Kuma setup
```

## HTTP API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/status` | none | the public status payload the page renders |
| `POST /api/ingest` | HMAC | a report from the Pi agent |
| `POST /api/poll` | HMAC | run the Tailscale poll now |
| `POST /api/notice` | HMAC | set or clear the incident banner |
| `GET /api/healthz` | none | liveness |

Signed routes take `X-Timestamp` and `X-Signature: sha256=<hex>`, where the
signature is HMAC-SHA256 of `<timestamp>.<body>` keyed with `INGEST_SECRET`,
valid for 5 minutes.

## Adding your own check

Everything is driven by the agent's output, so a new check is a few lines in
`ts-health-agent.sh`:

```sh
add_check my_check "Human readable name" "Exit node" operational \
  "A sentence explaining what this means for someone using the exit node." \
  "42 ms" true
#  └ id   └ label            └ group   └ status  └ message   └ metric  └ critical
```

`critical: true` means a failure takes the whole page down; `false` means it
only degrades it. Valid statuses are `operational`, `degraded`, `down` and
`unknown`. The Worker picks it up with no changes.
