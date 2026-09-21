/**
 * Public status page for a Raspberry Pi Tailscale exit node.
 *
 * Two independent sources of truth are merged:
 *
 *   1. The Pi agent (POST /api/ingest) reports what only the Pi can see:
 *      real internet egress, DNS, IP forwarding, DERP path, add-on states,
 *      CPU temperature, disk, load.
 *   2. The Tailscale API (scheduled poll) reports what Tailscale's own
 *      coordination server believes: is the node online, is 0.0.0.0/0 both
 *      advertised and approved, key expiry, client version. This keeps
 *      working when the Pi is offline, which is exactly when it matters.
 *
 * Everything lives in one KV key so a report costs one KV write - see the
 * "Free-tier write budget" section of the README.
 */

const STATE_KEY = 'state:v1';
const STATE_VERSION = 1;

const RECENT_MAX = 240;   // ~8h of samples at the default 120s interval
const DAILY_MAX = 90;     // days retained for the availability bars
const MAX_CHECKS = 40;    // hard cap on agent-supplied checks
const MAX_MSG = 240;      // hard cap on any agent-supplied string
const REPLAY_WINDOW = 300; // seconds a signed request stays valid

const STATUSES = ['operational', 'degraded', 'down', 'unknown', 'maintenance'];
const SEVERITY = { operational: 0, unknown: 1, maintenance: 1, degraded: 2, down: 3 };

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight();

    try {
      if (url.pathname === '/api/status') return await handleStatus(request, env);
      if (url.pathname === '/api/ingest') return await handleIngest(request, env, ctx);
      if (url.pathname === '/api/notice') return await handleNotice(request, env);
      if (url.pathname === '/api/healthz') return json({ ok: true, now: nowSec() });
    } catch (err) {
      return json({ error: 'internal_error', detail: String(err && err.message || err) }, 500);
    }

    // Not an API route and the assets binding did not match a file.
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollTailscale(env));
  },
};

// ---------------------------------------------------------------------------
// GET /api/status - the public, redacted view
// ---------------------------------------------------------------------------

async function handleStatus(request, env) {
  const state = await loadState(env);
  const view = buildView(state, env);
  return json(view, 200, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
}

// ---------------------------------------------------------------------------
// POST /api/ingest - the Pi agent reporting in
// ---------------------------------------------------------------------------

async function handleIngest(request, env, ctx) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const bodyText = await request.text();
  const auth = await verifySignature(request, bodyText, env);
  if (!auth.ok) return json({ error: 'unauthorized', detail: auth.reason }, 401);

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const report = sanitizeReport(payload);
  const state = await loadState(env);
  const now = nowSec();

  state.agent = { receivedAt: now, report };

  // Recompute overall using the fresh report so history reflects this sample.
  const view = buildView(state, env);
  recordSample(state, now, view.overall.status, view.metrics.exitLatencyMs);

  await saveState(env, state);

  return json({
    ok: true,
    receivedAt: now,
    overall: view.overall.status,
    checks: report.checks.length,
  });
}

// ---------------------------------------------------------------------------
// POST /api/notice - human-authored incident / maintenance banner
// ---------------------------------------------------------------------------

async function handleNotice(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const bodyText = await request.text();
  const auth = await verifySignature(request, bodyText, env);
  if (!auth.ok) return json({ error: 'unauthorized', detail: auth.reason }, 401);

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const state = await loadState(env);

  if (payload.clear === true || payload.level === 'none') {
    state.notice = null;
  } else {
    const level = ['info', 'warning', 'critical', 'maintenance'].includes(payload.level)
      ? payload.level : 'info';
    state.notice = {
      level,
      title: clamp(payload.title, 120) || 'Notice',
      body: clamp(payload.body, 600) || '',
      since: nowSec(),
    };
  }

  await saveState(env, state);
  return json({ ok: true, notice: state.notice });
}

// ---------------------------------------------------------------------------
// Request signing (HMAC-SHA256 over "<timestamp>.<body>")
// ---------------------------------------------------------------------------

async function verifySignature(request, bodyText, env) {
  const secret = env.INGEST_SECRET;
  if (!secret) return { ok: false, reason: 'INGEST_SECRET is not configured on the Worker' };

  const ts = request.headers.get('X-Timestamp');
  const sig = (request.headers.get('X-Signature') || '').replace(/^sha256=/, '');
  if (!ts || !sig) return { ok: false, reason: 'missing X-Timestamp or X-Signature' };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(nowSec() - tsNum) > REPLAY_WINDOW) {
    return { ok: false, reason: 'timestamp outside replay window (check the Pi clock)' };
  }

  const expected = await hmacHex(secret, `${ts}.${bodyText}`);
  if (!timingSafeEqual(expected, sig.toLowerCase())) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Agent payload sanitisation - this ends up on a public page
// ---------------------------------------------------------------------------

function sanitizeReport(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const checks = Array.isArray(p.checks) ? p.checks.slice(0, MAX_CHECKS) : [];

  return {
    agentVersion: clamp(p.agentVersion, 32),
    checks: checks.map((c) => ({
      id: slug(c && c.id) || 'unknown',
      label: clamp(c && c.label, 80) || 'Check',
      group: clamp(c && c.group, 40) || 'Other',
      status: STATUSES.includes(c && c.status) ? c.status : 'unknown',
      message: clamp(c && c.message, MAX_MSG),
      metric: clamp(c && c.metric, 48),
      critical: c && c.critical === true,
    })),
    metrics: numbersOnly(p.metrics, [
      'exitLatencyMs', 'dnsLatencyMs', 'packetLossPct', 'derpLatencyMs',
    ]),
    host: numbersOnly(p.host, [
      'cpuTempC', 'load1', 'memUsedPct', 'diskUsedPct', 'uptimeSeconds',
    ]),
    // Deliberately not surfaced unless SHOW_EGRESS_IP is enabled.
    egressIp: clamp(p.egressIp, 45),
    egressNetwork: clamp(p.egressNetwork, 80),
  };
}

function numbersOnly(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
  }
  return out;
}

function clamp(v, max) {
  if (v === null || v === undefined) return '';
  // Strip control characters - the result is rendered as text on a public page.
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function slug(v) {
  return String(v === null || v === undefined ? '' : v)
    .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48);
}

// ---------------------------------------------------------------------------
// Tailscale API poll (scheduled)
// ---------------------------------------------------------------------------

async function pollTailscale(env) {
  const creds = await tailscaleToken(env);
  if (!creds) return; // Not configured - nothing to do.

  const state = await loadState(env);
  const tailnet = encodeURIComponent(env.TAILSCALE_TAILNET || '-');

  try {
    const res = await tsFetch(
      `https://api.tailscale.com/api/v2/tailnet/${tailnet}/devices?fields=all`, creds,
    );
    if (!res.ok) throw new Error(`devices HTTP ${res.status}`);
    const data = await res.json();
    const devices = Array.isArray(data.devices) ? data.devices : [];

    const wanted = (env.TAILSCALE_DEVICE || '').trim().toLowerCase();
    const device = pickDevice(devices, wanted);

    if (!device) {
      state.tailscale = {
        checkedAt: nowSec(), ok: false,
        error: wanted
          ? `No device matching "${wanted}" in this tailnet`
          : 'TAILSCALE_DEVICE is not set, so the exit node could not be identified',
      };
    } else {
      // The device object's route fields are advisory; the routes endpoint is
      // authoritative about what is advertised vs actually approved.
      let advertised = toArray(device.advertisedRoutes);
      let enabled = toArray(device.enabledRoutes);
      try {
        const rr = await tsFetch(
          `https://api.tailscale.com/api/v2/device/${encodeURIComponent(device.id)}/routes`, creds,
        );
        if (rr.ok) {
          const routes = await rr.json();
          advertised = toArray(routes.advertisedRoutes);
          enabled = toArray(routes.enabledRoutes);
        }
      } catch { /* fall back to the device object's fields */ }

      state.tailscale = {
        checkedAt: nowSec(),
        ok: true,
        error: null,
        device: {
          hostname: clamp(device.hostname, 64),
          online: device.online === true,
          lastSeen: device.lastSeen || null,
          os: clamp(device.os, 32),
          clientVersion: clamp(device.clientVersion, 48),
          updateAvailable: device.updateAvailable === true,
          authorized: device.authorized !== false,
          keyExpiryDisabled: device.keyExpiryDisabled === true,
          expires: device.expires || null,
          advertisesExitNode: hasExitRoute(advertised),
          exitNodeApproved: hasExitRoute(enabled),
          advertisesExitNodeV6: advertised.includes('::/0'),
          exitNodeApprovedV6: enabled.includes('::/0'),
        },
      };
    }
  } catch (err) {
    state.tailscale = {
      checkedAt: nowSec(), ok: false,
      error: clamp(err && err.message, 160) || 'Tailscale API request failed',
    };
  }

  await saveState(env, state);
}

function pickDevice(devices, wanted) {
  if (!devices.length) return null;
  if (wanted) {
    return devices.find((d) => {
      const h = String(d.hostname || '').toLowerCase();
      const n = String(d.name || '').toLowerCase();
      return h === wanted || n === wanted || n.split('.')[0] === wanted || h.startsWith(wanted);
    }) || null;
  }
  // No hint given: if exactly one device advertises a default route, use it.
  const exits = devices.filter((d) => hasExitRoute(toArray(d.advertisedRoutes)));
  return exits.length === 1 ? exits[0] : null;
}

function hasExitRoute(routes) {
  return routes.includes('0.0.0.0/0');
}

function toArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

async function tailscaleToken(env) {
  if (env.TAILSCALE_API_KEY) return { type: 'bearer', value: env.TAILSCALE_API_KEY };

  if (env.TAILSCALE_OAUTH_CLIENT_ID && env.TAILSCALE_OAUTH_CLIENT_SECRET) {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.TAILSCALE_OAUTH_CLIENT_ID,
      client_secret: env.TAILSCALE_OAUTH_CLIENT_SECRET,
    });
    const res = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return null;
    const tok = await res.json();
    return tok.access_token ? { type: 'bearer', value: tok.access_token } : null;
  }
  return null;
}

function tsFetch(url, creds) {
  return fetch(url, { headers: { Authorization: `Bearer ${creds.value}` } });
}

// ---------------------------------------------------------------------------
// View construction - merge both sources into the public payload
// ---------------------------------------------------------------------------

function buildView(state, env) {
  const now = nowSec();
  const staleAfter = Number(env.AGENT_STALE_AFTER || 300) || 300;

  const agentAge = state.agent ? now - state.agent.receivedAt : null;
  const agentStale = agentAge === null || agentAge > staleAfter;
  const report = (state.agent && state.agent.report) || { checks: [], metrics: {}, host: {} };

  const ts = state.tailscale || null;
  const tsAge = ts && ts.checkedAt ? now - ts.checkedAt : null;
  // The cron runs every 15m; allow two misses before calling it stale.
  const tsStale = tsAge === null || tsAge > 2400;

  const components = [];

  // --- Tailscale-side checks (survive the Pi being offline) ----------------
  if (ts && ts.ok && ts.device) {
    const d = ts.device;
    // Relative age rather than a raw ISO string: it reads better and needs no
    // assumption about the viewer's timezone.
    const lastSeenSec = d.lastSeen ? Math.floor(Date.parse(d.lastSeen) / 1000) : null;
    const lastSeenAgo = Number.isFinite(lastSeenSec) && lastSeenSec !== null && now >= lastSeenSec
      ? formatAge(now - lastSeenSec) : null;

    components.push({
      id: 'ts_node_online', label: 'Node reachable on the tailnet', group: 'Tailscale',
      critical: true,
      status: d.online ? 'operational' : 'down',
      message: d.online
        ? 'Tailscale reports the exit node as online.'
        : `Tailscale reports the exit node as offline${lastSeenAgo ? ` (last seen ${lastSeenAgo} ago)` : ''}.`,
      metric: d.online ? 'online' : 'offline',
    });

    components.push({
      id: 'exit_advertised', label: 'Advertising itself as an exit node', group: 'Exit node',
      critical: true,
      status: d.advertisesExitNode ? 'operational' : 'down',
      message: d.advertisesExitNode
        ? 'The node is offering 0.0.0.0/0 to the tailnet.'
        : 'The node is not advertising a default route, so it cannot be selected as an exit node.',
    });

    components.push({
      id: 'exit_approved', label: 'Exit node approved in admin console', group: 'Exit node',
      critical: true,
      status: d.exitNodeApproved ? 'operational' : 'down',
      message: d.exitNodeApproved
        ? 'The default route is approved, so clients can route traffic through it.'
        : 'The default route is advertised but not approved in the Tailscale admin console.',
    });

    if (d.advertisesExitNode) {
      const v6ok = d.exitNodeApprovedV6 && d.advertisesExitNodeV6;
      components.push({
        id: 'exit_ipv6', label: 'IPv6 exit routing', group: 'Exit node',
        critical: false,
        status: v6ok ? 'operational' : 'degraded',
        message: v6ok
          ? 'IPv6 (::/0) is advertised and approved.'
          : 'IPv6 (::/0) is not fully enabled. IPv4 traffic is unaffected; IPv6-only destinations may fail.',
      });
    }

    if (!d.authorized) {
      components.push({
        id: 'ts_authorized', label: 'Device authorized', group: 'Tailscale', critical: true,
        status: 'down',
        message: 'The device is not authorized on this tailnet.',
      });
    }

    const expiryDays = d.keyExpiryDisabled || !d.expires
      ? null
      : Math.floor((Date.parse(d.expires) - now * 1000) / 86400000);
    if (expiryDays !== null && Number.isFinite(expiryDays) && expiryDays <= 14) {
      components.push({
        id: 'ts_key_expiry', label: 'Node key expiry', group: 'Tailscale',
        critical: expiryDays <= 0,
        status: expiryDays <= 0 ? 'down' : 'degraded',
        message: expiryDays <= 0
          ? 'The node key has expired and the exit node needs to be re-authenticated.'
          : `The node key expires in ${expiryDays} day${expiryDays === 1 ? '' : 's'} and will need re-authentication.`,
        metric: `${expiryDays}d`,
      });
    }
  } else if (ts && !ts.ok) {
    components.push({
      id: 'ts_api', label: 'Tailscale API check', group: 'Tailscale', critical: false,
      status: 'unknown',
      message: ts.error || 'The Tailscale API check could not complete.',
    });
  }

  // --- Agent-side checks ---------------------------------------------------
  if (!agentStale) {
    // The Home Assistant add-on's `advertise_exit_node` option is only
    // advisory: the route can also be advertised through `tailscaled_args`.
    // If the Tailscale API can see the route, that is authoritative and the
    // option check would be a false alarm, so drop it.
    const routeConfirmed = !!(ts && ts.ok && ts.device && ts.device.advertisesExitNode);
    for (const c of report.checks) {
      if (routeConfirmed && c.id === 'ts_addon_exit_config' && c.status !== 'operational') continue;
      components.push(c);
    }
  } else {
    components.push({
      id: 'agent', label: 'Monitoring agent on the Pi', group: 'Host', critical: false,
      status: 'unknown',
      message: agentAge === null
        ? 'The Pi has never reported in. Local health detail is unavailable.'
        : `The Pi has not reported in for ${formatAge(agentAge)}. Local health detail is stale.`,
    });
  }

  const overall = computeOverall(components, state.notice, {
    agentStale, tsStale, hasTailscale: !!(ts && ts.ok && ts.device),
  });

  const view = {
    generatedAt: now,
    title: env.SITE_TITLE || 'Tailscale Exit Node Status',
    subtitle: env.SITE_SUBTITLE || '',
    overall,
    notice: state.notice || null,
    sources: {
      agent: {
        ageSeconds: agentAge, stale: agentStale, staleAfter,
        version: report.agentVersion || '',
      },
      tailscaleApi: {
        enabled: !!ts, ok: !!(ts && ts.ok), ageSeconds: tsAge, stale: tsStale,
        error: (ts && ts.error) || null,
      },
    },
    components,
    metrics: agentStale ? {} : (report.metrics || {}),
    host: agentStale ? {} : (report.host || {}),
    history: {
      recent: (state.recent || []).slice(-RECENT_MAX),
      daily: dailySeries(state.daily || {}),
    },
    uptime: uptimeWindows(state.daily || {}),
    links: { uptimeKuma: env.UPTIME_KUMA_URL || '' },
  };

  if (String(env.SHOW_EGRESS_IP) === 'true' && !agentStale) {
    view.egress = { ip: report.egressIp || '', network: report.egressNetwork || '' };
  } else if (!agentStale && report.egressNetwork) {
    // The network name is not identifying the way a bare IP is.
    view.egress = { ip: '', network: report.egressNetwork };
  }

  return view;
}

function computeOverall(components, notice, flags) {
  if (notice && notice.level === 'maintenance') {
    return {
      status: 'maintenance',
      headline: 'Planned maintenance',
      summary: notice.title || 'The exit node is under planned maintenance.',
    };
  }

  let worst = 'operational';
  const problems = [];
  for (const c of components) {
    if (c.status === 'down' || c.status === 'degraded') problems.push(c);
    const effective = c.critical ? c.status : (c.status === 'down' ? 'degraded' : c.status);
    if (SEVERITY[effective] > SEVERITY[worst]) worst = effective;
  }

  // Lead with the problem that matters most, not whichever happens to be
  // first in the list: down before degraded, critical before cosmetic.
  problems.sort((a, b) => (SEVERITY[b.status] - SEVERITY[a.status])
    || (Number(b.critical) - Number(a.critical)));

  // Nothing is reporting at all - say so rather than claiming health.
  if (flags.agentStale && !flags.hasTailscale) {
    return {
      status: 'unknown',
      headline: 'Status unknown',
      summary: 'Neither the Pi nor the Tailscale API is reporting right now, so the exit node cannot be confirmed working. Treat it as unavailable until this clears.',
    };
  }

  if (worst === 'down') {
    return {
      status: 'down',
      headline: 'Exit node is down',
      summary: problems.length
        ? summarize(problems)
        : 'The exit node is not usable right now.',
    };
  }

  if (worst === 'degraded' || worst === 'unknown') {
    return {
      status: worst === 'unknown' ? 'unknown' : 'degraded',
      headline: worst === 'unknown' ? 'Partially reporting' : 'Working, with problems',
      summary: problems.length
        ? summarize(problems)
        : 'Some checks could not be completed. The exit node is probably usable.',
    };
  }

  return {
    status: 'operational',
    headline: 'Exit node is working normally',
    summary: 'All checks are passing. You can route your traffic through this exit node.',
  };
}

// Lead with the worst problem, then say how many others there are, so the
// headline stays readable without hiding the scale of the failure.
function summarize(problems) {
  const [first, ...rest] = problems;
  let summary = `${first.label}: ${first.message}`;
  if (rest.length) {
    summary += ` Plus ${rest.length} other check${rest.length === 1 ? '' : 's'} reporting problems.`;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const S_CODE = { operational: 0, degraded: 1, down: 2, unknown: 3, maintenance: 4 };

function recordSample(state, now, status, latencyMs) {
  const code = S_CODE[status] !== undefined ? S_CODE[status] : 3;

  state.recent = state.recent || [];
  state.recent.push({
    t: now,
    s: code,
    l: typeof latencyMs === 'number' && Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
  });
  if (state.recent.length > RECENT_MAX) state.recent = state.recent.slice(-RECENT_MAX);

  const day = new Date(now * 1000).toISOString().slice(0, 10);
  state.daily = state.daily || {};
  const bucket = state.daily[day] || { up: 0, deg: 0, down: 0 };
  if (status === 'down') bucket.down += 1;
  else if (status === 'degraded') bucket.deg += 1;
  else if (status === 'operational' || status === 'maintenance') bucket.up += 1;
  state.daily[day] = bucket;

  // Trim to the retention window.
  const days = Object.keys(state.daily).sort();
  if (days.length > DAILY_MAX) {
    for (const d of days.slice(0, days.length - DAILY_MAX)) delete state.daily[d];
  }
}

function dailySeries(daily) {
  const out = [];
  const today = new Date();
  for (let i = DAILY_MAX - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    const b = daily[d];
    if (!b) { out.push({ d, pct: null, up: 0, deg: 0, down: 0 }); continue; }
    const total = b.up + b.deg + b.down;
    out.push({
      d,
      pct: total ? Math.round(((b.up + b.deg) / total) * 10000) / 100 : null,
      up: b.up, deg: b.deg, down: b.down,
    });
  }
  return out;
}

function uptimeWindows(daily) {
  const windows = { d1: 1, d7: 7, d30: 30, d90: 90 };
  const series = dailySeries(daily);
  const out = {};
  for (const [key, n] of Object.entries(windows)) {
    const slice = series.slice(-n);
    let up = 0, total = 0;
    for (const s of slice) { up += s.up + s.deg; total += s.up + s.deg + s.down; }
    out[key] = total ? Math.round((up / total) * 10000) / 100 : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// State + helpers
// ---------------------------------------------------------------------------

async function loadState(env) {
  const raw = await env.STATUS_KV.get(STATE_KEY, 'json');
  if (raw && raw.version === STATE_VERSION) return raw;
  return { version: STATE_VERSION, agent: null, tailscale: null, notice: null, recent: [], daily: {} };
}

function saveState(env, state) {
  state.version = STATE_VERSION;
  return env.STATUS_KV.put(STATE_KEY, JSON.stringify(state));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Timestamp, X-Signature',
      'Access-Control-Max-Age': '86400',
    },
  });
}
