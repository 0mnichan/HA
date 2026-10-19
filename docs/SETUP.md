# Full setup guide

Start to finish, for a Raspberry Pi running **Home Assistant OS** with
Tailscale as an **add-on**. Every part ends with a check, so you always know
whether to continue or stop and fix something.

Budget about 30 minutes. Everything used here is free.

---

## Before you start

| You need | Notes |
|---|---|
| Pi running Home Assistant OS | with the **Tailscale** add-on installed |
| A computer with Node.js 18+ | your laptop — **not** the Pi. HAOS cannot run `npm` |
| A Cloudflare account | free plan is enough |
| Admin access to your Tailscale account | to approve routes and make API credentials |

Two values get created along the way. Write them down as you go:

- **`INGEST_SECRET`** — a random string shared by the Worker and the Pi.
- **Your Worker URL** — e.g. `https://tailscale-exit-node-status.you.workers.dev`.

> The repository is public. `agent.conf` is in `.gitignore` — never commit it,
> and never paste `INGEST_SECRET` into an issue, a PR, or the add-on
> configuration box.

---

## Part 1 — Make sure the exit node actually works

Do this first. A status page for a broken exit node is just a red page.

1. In Home Assistant: **Settings → Add-ons → Tailscale → Configuration**.
2. Set:

   | Option | Value | Why |
   |---|---|---|
   | `advertise_exit_node` | **true** | otherwise the Pi never offers itself as an exit node |
   | `userspace_networking` | **false** | Tailscale cannot route other devices' traffic in userspace mode |

3. **Save**, then **Restart** the add-on.
4. Go to the [Tailscale admin console → Machines](https://login.tailscale.com/admin/machines),
   find the Pi, open the **⋯** menu → **Edit route settings**, and tick
   **Use as exit node**. Advertising is not enough — it must be *approved*.
5. Note the Pi's **hostname** exactly as shown here (often `homeassistant`).
   You need it in Part 3.

**Check:** on your phone or laptop, open the Tailscale client, pick the Pi as
your exit node, and load any website. If that does not work, stop and fix it
before going further — the rest of this guide only *reports* on this.

---

## Part 2 — Tailscale API credentials

These let the status page report on the exit node **even when the Pi is
offline**, which is the whole point of the design. Strongly recommended.

1. Go to [Settings → OAuth clients](https://login.tailscale.com/admin/settings/oauth)
   and select **Generate OAuth client**.
2. Grant **read** access to **Devices → Core** and **Devices → Routes**.
   Nothing else. (Exact labels shift occasionally; you want the two read
   scopes covering devices and their routes.)
3. Copy the **Client ID** and **Client secret** now — the secret is shown once.

<details>
<summary>Simpler alternative: an API access token</summary>

[Settings → Keys](https://login.tailscale.com/admin/settings/keys) →
**Generate access token**. Use it as `TAILSCALE_API_KEY` in Part 3 instead of
the OAuth pair. It expires after 90 days and the page's Tailscale checks go
dark when it does, which is why OAuth is preferred.
</details>

---

## Part 3 — Deploy the Worker

**On your laptop**, not the Pi.

### 3.1 Get the code

```sh
git clone https://github.com/0mnichan/HA.git
cd HA
git checkout prod/gallant-curie-vzxjx8
npm install
```

### 3.2 Sign in to Cloudflare

```sh
npx wrangler login
```

### 3.3 Create the KV namespace

```sh
npx wrangler kv namespace create STATUS_KV
```

It prints an `id`. Open `wrangler.toml` and replace
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with it.

### 3.4 Create the shared secret

```sh
openssl rand -hex 32
```

Copy the output — this is your **`INGEST_SECRET`**. You need it twice: here and
in Part 4. Then:

```sh
npx wrangler secret put INGEST_SECRET      # paste it when prompted
```

### 3.5 Add the Tailscale credentials

```sh
npx wrangler secret put TAILSCALE_OAUTH_CLIENT_ID
npx wrangler secret put TAILSCALE_OAUTH_CLIENT_SECRET
# ...or, if you took the access-token route:
# npx wrangler secret put TAILSCALE_API_KEY
```

### 3.6 Point it at your Pi

In `wrangler.toml`, under `[vars]`:

```toml
TAILSCALE_DEVICE = "homeassistant"        # the hostname from Part 1, step 5
SITE_TITLE = "Exit Node Status"
SITE_SUBTITLE = "Raspberry Pi · home exit node"
```

### 3.7 Deploy

```sh
npx wrangler deploy
```

It prints your Worker URL. **Write it down** — that is the status page, and
it is what you share with people.

**Check:** open the URL in a browser. You should see the page with
*"Status unknown"* — correct, since nothing has reported yet.

### 3.8 Confirm the Tailscale credentials work

The Worker polls Tailscale every 15 minutes, so rather than waiting, trigger it:

```sh
export STATUS_ENDPOINT="https://your-worker-url.workers.dev"
export INGEST_SECRET="the-secret-from-3.4"
./scripts/status-cli.sh poll
```

A working setup returns `"ok": true` and your device, with
`"advertisesExitNode": true` and `"exitNodeApproved": true`.

If it fails, the response says why:

| Message | Fix |
|---|---|
| `No device matching "..."` | `TAILSCALE_DEVICE` does not match Part 1 step 5. Fix and redeploy. |
| `devices HTTP 401` / `403` | Credentials wrong or missing the read scopes. Redo Part 2. |
| `tailscale_not_configured` | Secrets from 3.5 did not save. Run them again, then redeploy. |
| `advertisesExitNode: false` | Part 1 is incomplete — the add-on is not advertising. |
| `exitNodeApproved: false` | Part 1 step 4 is incomplete — approve the route. |

Refresh the page. It now shows the Tailscale checks, and still reports the Pi
agent as silent. That is next.

---

## Part 4 — Install the agent on the Pi

### 4.1 Get a terminal on the Pi

Install the **Advanced SSH & Web Terminal** add-on if you do not have it.

> In its configuration, turn **"Start on boot"** and **"Watchdog"** on. The
> agent runs inside this add-on, so if it does not start, the page stops
> getting local detail. (The Tailscale checks keep working regardless.)

### 4.2 Install the agent

Open the add-on's **Terminal** tab and paste:

```sh
apk add --no-cache bash jq curl openssl

mkdir -p /config/ts-health && cd /config/ts-health
BASE=https://raw.githubusercontent.com/0mnichan/HA/prod/gallant-curie-vzxjx8/agent
wget -O ts-health-agent.sh "$BASE/ts-health-agent.sh"
wget -O run-loop.sh        "$BASE/run-loop.sh"
chmod +x ts-health-agent.sh run-loop.sh
```

`/config` survives add-on updates and restarts, which is why it goes there.

### 4.3 Configure it

```sh
cat > /config/ts-health/agent.conf <<'EOF'
STATUS_ENDPOINT="https://your-worker-url.workers.dev"
INGEST_SECRET="the-secret-from-step-3.4"
EOF

chmod 600 /config/ts-health/agent.conf
```

Substitute both values. They must match Part 3 exactly.

### 4.4 Check what it sees, before it publishes anything

```sh
cd /config/ts-health
./ts-health-agent.sh --dry-run --verbose
```

`--dry-run` collects and prints but sends nothing. You should see a line per
check, then the JSON. Confirm:

- `add-on slugs: tailscale=[...]` found your add-on
- `egress_internet` is `operational`
- no check says `unknown` for a thing you know works

### 4.5 Send the first real report

```sh
./ts-health-agent.sh --verbose
```

**Check:** refresh the status page. It should now show *"Exit node is working
normally"* with the full list of checks and the Raspberry Pi health tiles.

---

## Part 5 — Run it every two minutes

Without this, the page freezes at that one report and goes stale in 5 minutes.

In Home Assistant: **Settings → Add-ons → Advanced SSH & Web Terminal →
Configuration**, and add to `init_commands`:

```yaml
init_commands:
  - echo "*/2 * * * * /config/ts-health/ts-health-agent.sh >/dev/null 2>&1" > /etc/crontabs/root
  - crond -b -l 8
```

**Save**, then **Restart** the add-on.

**Check**, after about three minutes:

```sh
ps | grep -c crond          # at least 1
```

and on the status page the footer should read *"Pi reported Ns ago"* with N
under 120, and the dot beside it should be blue rather than grey.

> **Why two minutes and not one?** Cloudflare KV allows 1,000 writes/day free.
> At 120s the agent uses 720 and the Tailscale cron 96, totalling 816. Going
> to 60s would blow past the limit and the page would stop updating partway
> through each day. If you want faster, see *Free-tier write budget* in the
> README.

---

## Part 6 — Uptime Kuma alerting (optional)

The page keeps its own 90-day history, so this is purely to get *notified*.

1. In Uptime Kuma: **Add New Monitor → Monitor Type: Push**.
2. Name it *Tailscale exit node*, set **Heartbeat Interval** to `180`
   (longer than the agent's 120s, so one slow run is not a false alarm).
3. Copy its **Push URL**.
4. Append to `/config/ts-health/agent.conf`:

   ```sh
   KUMA_PUSH_overall="http://homeassistant.local:3001/api/push/YOURTOKEN"
   ```

5. Run `./ts-health-agent.sh --verbose` and confirm the monitor goes green.

Per-check monitors and the full id list are in
[uptime-kuma.md](uptime-kuma.md).

---

## Part 7 — Share it

Send people the Worker URL. The page tells them what to do in plain language,
including "set Exit node → None in your Tailscale client" when it is down.

The page carries `noindex`, so it will not turn up in search results. It is
unlisted, not secret — treat the URL as shareable with the people who use your
exit node, and nothing more. Your home IP is not published unless you set
`SHOW_EGRESS_IP = "true"`.

---

## Final checklist

- [ ] Exit node works when selected in a Tailscale client (Part 1)
- [ ] `./scripts/status-cli.sh poll` returns `"ok": true` (Part 3.8)
- [ ] Page shows *"Exit node is working normally"* (Part 4.5)
- [ ] Footer says *"Pi reported <120s ago"* with a blue dot (Part 5)
- [ ] SSH add-on has **Start on boot** enabled (Part 4.1)
- [ ] `agent.conf` is `chmod 600` and was never committed

---

## Deploying from a phone (or any machine without the repo)

A GitHub Action deploys the Worker, so you never need a laptop after the
one-time setup below. Everything here works in a phone browser.

### One-time setup

1. **Cloudflare dashboard** → your profile → **API Tokens** → **Create Token**
   → use the **"Edit Cloudflare Workers"** template → create, and copy it.
2. **This repo on GitHub** → **Settings** → **Secrets and variables** →
   **Actions**:
   - **Secrets** tab → *New repository secret* →
     name `CLOUDFLARE_API_TOKEN`, value = the token from step 1.
   - **Variables** tab → *New repository variable* →
     name `VAR_TAILSCALE_DEVICE`, value = your Pi's Tailscale hostname.
3. **Actions** tab → **Deploy status page** → **Run workflow**.

### After that

Every push to this branch that touches `src/`, `site/` or `wrangler.toml`
deploys automatically. You can also always re-run it by hand from the
**Actions** tab.

The run ends with a summary showing the live URL, the overall status and how
long ago the Pi reported, so you can confirm it worked without leaving GitHub.

### Why the config lives in GitHub, not in the repo

`wrangler deploy` replaces the Worker's plain-text vars with whatever
`wrangler.toml` holds, so committing one person's KV namespace id and device
name would overwrite them on anyone else's deploy. Instead
`scripts/apply-config.mjs` fills them in at deploy time:

| What | Where it comes from |
|---|---|
| KV namespace id | `KV_NAMESPACE_ID` variable, or resolved from your Cloudflare account automatically |
| `TAILSCALE_DEVICE` and other `[vars]` | repository variable `VAR_<NAME>`, else the repo default |
| `INGEST_SECRET`, `TAILSCALE_*` secrets | stored in Cloudflare; **never touched by a deploy** |

So if you set something with `wrangler secret put`, it survives. If you set
something in `[vars]`, set it as a `VAR_<NAME>` repository variable too, or
the next deploy resets it to the repo default.

---

## Running it day to day

**Post an incident banner** (for what automation cannot know):

```sh
export STATUS_ENDPOINT="https://your-worker-url.workers.dev"
export INGEST_SECRET="..."

./scripts/status-cli.sh notice critical "ISP outage" "Provider says this evening."
./scripts/status-cli.sh notice maintenance "Router upgrade" "Back by 21:00."
./scripts/status-cli.sh clear
```

A `maintenance` notice overrides the computed status and tells viewers to stop
using the exit node.

**Update the agent** after pulling changes:

```sh
cd /config/ts-health
wget -O ts-health-agent.sh \
  https://raw.githubusercontent.com/0mnichan/HA/prod/gallant-curie-vzxjx8/agent/ts-health-agent.sh
chmod +x ts-health-agent.sh
./ts-health-agent.sh --dry-run
```

**Update the Worker:**

```sh
git pull && npx wrangler deploy
```

**Watch Worker logs live:** `npx wrangler tail`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page says *"Status unknown"* forever | Nothing is reporting | Run Part 3.8 and Part 4.5 by hand and read the errors |
| *"The Pi has not reported in for …"* | Agent is not running | Check `ps \| grep crond`; re-do Part 5; confirm the SSH add-on is running |
| `status service rejected the report: unauthorized` | `INGEST_SECRET` differs | It must match between `agent.conf` and `wrangler secret put` exactly — no quotes, no trailing spaces |
| `timestamp outside replay window` | The Pi's clock has drifted | Requests are valid for 5 minutes. Check the Pi's NTP/network |
| `jq is required` | Missing dependency | `apk add --no-cache bash jq curl openssl` |
| Tailscale checks missing from the page | No credentials, or the poll failed | `./scripts/status-cli.sh poll` and read the response |
| Page stops updating late each day | KV free-tier write limit | Agent interval is below 120s — see Part 5 |
| Uptime Kuma check absent | Add-on not found | It is auto-discovered; set `KUMA_ADDON_SLUG` from `ha addons list` |
| `advertise_exit_node` check says down but it works | Route set via `tailscaled_args` | Harmless — the Worker drops that check once the Tailscale API confirms the route |

To see everything the agent sees, without publishing anything:

```sh
/config/ts-health/ts-health-agent.sh --dry-run --verbose
```
