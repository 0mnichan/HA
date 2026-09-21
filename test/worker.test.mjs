/**
 * Worker tests. No Cloudflare runtime needed - the Worker only uses
 * WebCrypto, fetch and a KV binding, all of which Node 18+ can stand in for.
 *
 *   node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const SECRET = 'test-secret-value';

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

function makeEnv(overrides = {}) {
  return {
    STATUS_KV: makeKV(),
    INGEST_SECRET: SECRET,
    AGENT_STALE_AFTER: '300',
    SITE_TITLE: 'Test Status',
    ...overrides,
  };
}

async function sign(secret, ts, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function post(env, path, payload, { secret = SECRET, ts = null, sig = null } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = ts === null ? Math.floor(Date.now() / 1000) : ts;
  const signature = sig === null ? await sign(secret, timestamp, body) : sig;
  const req = new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': String(timestamp),
      'X-Signature': `sha256=${signature}`,
    },
    body,
  });
  return worker.fetch(req, env, { waitUntil() {} });
}

function getStatus(env) {
  return worker.fetch(
    new Request('https://example.test/api/status'), env, { waitUntil() {} },
  );
}

const okReport = (over = {}) => ({
  agentVersion: '1.0.0',
  checks: [
    { id: 'egress_internet', label: 'Internet reachable from the Pi', group: 'Exit node',
      status: 'operational', message: 'Reached the internet in 22 ms.', metric: '22 ms', critical: true },
    { id: 'pi_temp', label: 'CPU temperature', group: 'Host',
      status: 'operational', message: 'Normal.', metric: '48.1°C', critical: false },
  ],
  metrics: { exitLatencyMs: 22, dnsLatencyMs: 9, packetLossPct: 0 },
  host: { cpuTempC: 48.1, load1: 0.2, memUsedPct: 41, diskUsedPct: 62, uptimeSeconds: 90000 },
  ...over,
});

// --- auth -----------------------------------------------------------------

test('ingest rejects an unsigned request', async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    new Request('https://example.test/api/ingest', { method: 'POST', body: '{}' }),
    env, { waitUntil() {} },
  );
  assert.equal(res.status, 401);
  assert.match((await res.json()).detail, /missing/i);
});

test('ingest rejects a wrong signature', async () => {
  const env = makeEnv();
  const res = await post(env, '/api/ingest', okReport(), { secret: 'wrong-secret' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).detail, 'signature mismatch');
});

test('ingest rejects a replayed/stale timestamp', async () => {
  const env = makeEnv();
  const old = Math.floor(Date.now() / 1000) - 4000;
  const res = await post(env, '/api/ingest', okReport(), { ts: old });
  assert.equal(res.status, 401);
  assert.match((await res.json()).detail, /replay window/);
});

test('ingest refuses to run without a configured secret', async () => {
  const env = makeEnv({ INGEST_SECRET: undefined });
  const res = await post(env, '/api/ingest', okReport());
  assert.equal(res.status, 401);
  assert.match((await res.json()).detail, /not configured/);
});

// --- happy path -----------------------------------------------------------

test('a valid report becomes an operational public status', async () => {
  const env = makeEnv();
  const ing = await post(env, '/api/ingest', okReport());
  assert.equal(ing.status, 200);
  assert.equal((await ing.json()).overall, 'operational');

  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'operational');
  assert.equal(view.title, 'Test Status');
  assert.equal(view.sources.agent.stale, false);
  assert.equal(view.metrics.exitLatencyMs, 22);
  assert.equal(view.host.cpuTempC, 48.1);
  assert.equal(view.components.length, 2);
  assert.equal(view.history.recent.length, 1);
  assert.equal(view.history.daily.length, 90);
  assert.equal(view.uptime.d1, 100);
});

test('a critical check that is down makes the whole page down', async () => {
  const env = makeEnv();
  const report = okReport();
  report.checks[0].status = 'down';
  report.checks[0].message = 'The Pi has no working internet connection.';
  await post(env, '/api/ingest', report);

  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'down');
  assert.match(view.overall.summary, /no working internet/);
});

test('a non-critical check that is down only degrades the page', async () => {
  const env = makeEnv();
  const report = okReport();
  report.checks[1].status = 'down';           // pi_temp, critical: false
  await post(env, '/api/ingest', report);

  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'degraded');
});

// --- staleness ------------------------------------------------------------

test('with no report at all the status is unknown, never operational', async () => {
  const env = makeEnv();
  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'unknown');
  assert.equal(view.sources.agent.stale, true);
  assert.match(view.overall.summary, /cannot be confirmed|not reporting/i);
});

test('a stale agent report does not keep claiming the node is healthy', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport());
  // Age the stored report past AGENT_STALE_AFTER.
  const state = JSON.parse(env.STATUS_KV.store.get('state:v1'));
  state.agent.receivedAt -= 10000;
  env.STATUS_KV.store.set('state:v1', JSON.stringify(state));

  const view = await (await getStatus(env)).json();
  assert.equal(view.sources.agent.stale, true);
  assert.notEqual(view.overall.status, 'operational');
  assert.deepEqual(view.metrics, {});           // stale metrics are withheld
  assert.equal(view.components.length, 1);      // replaced by the agent notice
  assert.equal(view.components[0].id, 'agent');
});

test('the Tailscale API keeps reporting while the Pi agent is silent', async () => {
  const env = makeEnv();
  const state = {
    version: 1, agent: null, notice: null, recent: [], daily: {},
    tailscale: {
      checkedAt: Math.floor(Date.now() / 1000), ok: true, error: null,
      device: {
        hostname: 'pi-exit', online: true, advertisesExitNode: true,
        exitNodeApproved: true, advertisesExitNodeV6: true, exitNodeApprovedV6: true,
        authorized: true, keyExpiryDisabled: true, expires: null,
      },
    },
  };
  await env.STATUS_KV.put('state:v1', JSON.stringify(state));

  const view = await (await getStatus(env)).json();
  const ids = view.components.map((c) => c.id);
  assert.ok(ids.includes('ts_node_online'));
  assert.ok(ids.includes('exit_approved'));
  assert.ok(ids.includes('agent'));             // agent silence is surfaced
  assert.equal(view.overall.status, 'unknown'); // reporting, but not fully
});

test('an offline node per the Tailscale API reads as down', async () => {
  const env = makeEnv();
  await env.STATUS_KV.put('state:v1', JSON.stringify({
    version: 1, agent: null, notice: null, recent: [], daily: {},
    tailscale: {
      checkedAt: Math.floor(Date.now() / 1000), ok: true, error: null,
      device: {
        hostname: 'pi-exit', online: false, lastSeen: '2026-09-20T10:00:00Z',
        advertisesExitNode: true, exitNodeApproved: true, authorized: true,
        keyExpiryDisabled: true, expires: null,
      },
    },
  }));
  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'down');
  assert.match(view.overall.summary, /offline/);
  // Relative age, not a raw ISO timestamp the viewer has to decode.
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(view.overall.summary), view.overall.summary);
  assert.match(view.overall.summary, /last seen \d+[smhd] ago/);
});

test('advertised but unapproved routes are reported as down with the real reason', async () => {
  const env = makeEnv();
  await env.STATUS_KV.put('state:v1', JSON.stringify({
    version: 1, agent: null, notice: null, recent: [], daily: {},
    tailscale: {
      checkedAt: Math.floor(Date.now() / 1000), ok: true, error: null,
      device: {
        hostname: 'pi-exit', online: true, advertisesExitNode: true,
        exitNodeApproved: false, authorized: true, keyExpiryDisabled: true, expires: null,
      },
    },
  }));
  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'down');
  assert.match(view.overall.summary, /not approved in the Tailscale admin console/);
});

test('the headline leads with the most important problem, not the first one', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport({
    checks: [
      { id: 'cosmetic', label: 'IPv6 exit routing', group: 'Exit node',
        status: 'degraded', message: 'IPv6 is not fully enabled.', metric: '', critical: false },
      { id: 'egress_internet', label: 'Internet reachable from the Pi', group: 'Exit node',
        status: 'degraded', message: 'Responses are slow (612 ms).', metric: '', critical: true },
      { id: 'pi_temp', label: 'CPU temperature', group: 'Host',
        status: 'degraded', message: 'Running hot.', metric: '', critical: false },
    ],
  }));
  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'degraded');
  assert.match(view.overall.summary, /^Internet reachable from the Pi:/);
  assert.match(view.overall.summary, /Plus 2 other checks reporting problems\./);
});

test('a down check outranks a critical degraded one in the headline', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport({
    checks: [
      { id: 'egress_internet', label: 'Internet reachable from the Pi', group: 'Exit node',
        status: 'degraded', message: 'Slow.', metric: '', critical: true },
      { id: 'dns_resolution', label: 'DNS resolution', group: 'Exit node',
        status: 'down', message: 'Cannot resolve hostnames.', metric: '', critical: true },
    ],
  }));
  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'down');
  assert.match(view.overall.summary, /^DNS resolution:/);
  assert.match(view.overall.summary, /Plus 1 other check reporting problems\./);
});

test('a single problem does not get a "plus others" suffix', async () => {
  const env = makeEnv();
  const report = okReport();
  report.checks[0].status = 'down';
  await post(env, '/api/ingest', report);
  const view = await (await getStatus(env)).json();
  assert.ok(!/Plus \d+ other/.test(view.overall.summary), view.overall.summary);
});

test('the add-on option check is dropped when the Tailscale API confirms the route', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport({
    checks: [{
      id: 'ts_addon_exit_config', label: 'Add-on set to advertise an exit node',
      group: 'Exit node', status: 'down',
      message: "The add-on has 'advertise_exit_node' turned off.", metric: 'off', critical: true,
    }],
  }));
  // Tailscale itself can see 0.0.0.0/0 being advertised, so the add-on option
  // is a false alarm (it can be set through tailscaled_args instead).
  const state = JSON.parse(env.STATUS_KV.store.get('state:v1'));
  state.tailscale = {
    checkedAt: Math.floor(Date.now() / 1000), ok: true, error: null,
    device: {
      hostname: 'pi', online: true, advertisesExitNode: true, exitNodeApproved: true,
      advertisesExitNodeV6: true, exitNodeApprovedV6: true,
      authorized: true, keyExpiryDisabled: true, expires: null,
    },
  };
  env.STATUS_KV.store.set('state:v1', JSON.stringify(state));

  const view = await (await getStatus(env)).json();
  assert.ok(!view.components.some((c) => c.id === 'ts_addon_exit_config'));
  assert.equal(view.overall.status, 'operational');
});

test('the add-on option check stands when the Tailscale API is not configured', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport({
    checks: [{
      id: 'ts_addon_exit_config', label: 'Add-on set to advertise an exit node',
      group: 'Exit node', status: 'down',
      message: "The add-on has 'advertise_exit_node' turned off.", metric: 'off', critical: true,
    }],
  }));
  const view = await (await getStatus(env)).json();
  assert.ok(view.components.some((c) => c.id === 'ts_addon_exit_config'));
  assert.equal(view.overall.status, 'down');
});

// --- sanitisation ---------------------------------------------------------

test('agent-supplied strings are clamped and stripped before going public', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport({
    checks: [{
      id: 'Weird ID!! <script>', label: 'x'.repeat(500), group: 'G',
      status: 'totally-made-up', message: `line1\u0000line2${'y'.repeat(500)}`,
      metric: 'm', critical: true,
    }],
  }));
  const view = await (await getStatus(env)).json();
  const c = view.components[0];
  // Slugged down to [a-z0-9_-]: every markup character is gone.
  assert.equal(c.id, 'weirdidscript');
  assert.ok(!/[<>/!"'\s]/.test(c.id));
  assert.equal(c.label.length, 80);         // clamped
  assert.equal(c.status, 'unknown');        // unrecognised status rejected
  assert.ok(!c.message.includes('\u0000')); // control characters stripped
  assert.ok(c.message.length <= 240);
});

test('the check list is capped so one bad report cannot flood the page', async () => {
  const env = makeEnv();
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `c${i}`, label: `Check ${i}`, group: 'G', status: 'operational',
    message: 'ok', metric: '', critical: false,
  }));
  await post(env, '/api/ingest', okReport({ checks: many }));
  const view = await (await getStatus(env)).json();
  assert.equal(view.components.length, 40);
});

test('non-numeric metrics are dropped rather than rendered', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport({
    metrics: { exitLatencyMs: 'not-a-number', dnsLatencyMs: 12 },
    host: { cpuTempC: NaN, diskUsedPct: 55 },
  }));
  const view = await (await getStatus(env)).json();
  assert.equal(view.metrics.exitLatencyMs, undefined);
  assert.equal(view.metrics.dnsLatencyMs, 12);
  assert.equal(view.host.cpuTempC, undefined);
  assert.equal(view.host.diskUsedPct, 55);
});

// --- privacy --------------------------------------------------------------

test('the home egress IP is withheld unless explicitly enabled', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport({ egressIp: '203.0.113.7', egressNetwork: 'GB' }));
  const view = await (await getStatus(env)).json();
  assert.equal(view.egress.ip, '');
  assert.equal(view.egress.network, 'GB');
});

test('the egress IP is shown when SHOW_EGRESS_IP is turned on', async () => {
  const env = makeEnv({ SHOW_EGRESS_IP: 'true' });
  await post(env, '/api/ingest', okReport({ egressIp: '203.0.113.7', egressNetwork: 'GB' }));
  const view = await (await getStatus(env)).json();
  assert.equal(view.egress.ip, '203.0.113.7');
});

// --- notices --------------------------------------------------------------

test('a maintenance notice overrides the computed status', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport());
  const res = await post(env, '/api/notice', {
    level: 'maintenance', title: 'Router firmware upgrade', body: 'Back by 21:00.',
  });
  assert.equal(res.status, 200);

  const view = await (await getStatus(env)).json();
  assert.equal(view.overall.status, 'maintenance');
  assert.equal(view.notice.title, 'Router firmware upgrade');
});

test('a notice can be cleared', async () => {
  const env = makeEnv();
  await post(env, '/api/notice', { level: 'maintenance', title: 'x', body: 'y' });
  await post(env, '/api/notice', { clear: true });
  const view = await (await getStatus(env)).json();
  assert.equal(view.notice, null);
});

test('posting a notice requires the same signature as ingest', async () => {
  const env = makeEnv();
  const res = await post(env, '/api/notice', { level: 'critical', title: 'fake' },
    { secret: 'not-the-secret' });
  assert.equal(res.status, 401);
});

// --- on-demand Tailscale poll ---------------------------------------------

test('the poll endpoint requires a signature', async () => {
  const env = makeEnv({ TAILSCALE_API_KEY: 'k' });
  const res = await post(env, '/api/poll', {}, { secret: 'wrong' });
  assert.equal(res.status, 401);
});

test('polling without Tailscale credentials explains what to set', async () => {
  const env = makeEnv();
  const res = await post(env, '/api/poll', {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'tailscale_not_configured');
  assert.match(body.detail, /wrangler secret put/);
});

test('a failing poll reports the reason rather than a bare error', async () => {
  const env = makeEnv({ TAILSCALE_API_KEY: 'bad-key', TAILSCALE_DEVICE: 'pi' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  try {
    const res = await post(env, '/api/poll', {});
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.tailscale.error, /401/);
    assert.match(body.hint, /TAILSCALE_DEVICE/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a successful poll stores the device and shows up in the public status', async () => {
  const env = makeEnv({ TAILSCALE_API_KEY: 'good-key', TAILSCALE_DEVICE: 'homeassistant' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/devices')) {
      return Response.json({ devices: [{
        id: '123', hostname: 'homeassistant', name: 'homeassistant.tail1234.ts.net',
        online: true, os: 'linux', clientVersion: '1.78.1', authorized: true,
        keyExpiryDisabled: true, advertisedRoutes: ['0.0.0.0/0', '::/0'],
        enabledRoutes: ['0.0.0.0/0', '::/0'],
      }] });
    }
    return Response.json({ advertisedRoutes: ['0.0.0.0/0', '::/0'], enabledRoutes: ['0.0.0.0/0', '::/0'] });
  };
  try {
    const res = await post(env, '/api/poll', {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tailscale.device.hostname, 'homeassistant');
    assert.equal(body.tailscale.device.exitNodeApproved, true);

    const view = await (await getStatus(env)).json();
    const ids = view.components.map((c) => c.id);
    assert.ok(ids.includes('ts_node_online'));
    assert.ok(ids.includes('exit_approved'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- history --------------------------------------------------------------

test('repeated reports accumulate daily availability', async () => {
  const env = makeEnv();
  await post(env, '/api/ingest', okReport());
  const bad = okReport();
  bad.checks[0].status = 'down';
  await post(env, '/api/ingest', bad);
  await post(env, '/api/ingest', okReport());

  const view = await (await getStatus(env)).json();
  const today = view.history.daily[view.history.daily.length - 1];
  assert.equal(today.up, 2);
  assert.equal(today.down, 1);
  assert.equal(view.history.recent.length, 3);
  assert.ok(view.uptime.d1 > 66 && view.uptime.d1 < 67); // 2 of 3
});

test('the recent window is trimmed rather than growing without bound', async () => {
  const env = makeEnv();
  const state = {
    version: 1, agent: null, tailscale: null, notice: null, daily: {},
    recent: Array.from({ length: 300 }, (_, i) => ({ t: 1000 + i, s: 0, l: 10 })),
  };
  await env.STATUS_KV.put('state:v1', JSON.stringify(state));
  await post(env, '/api/ingest', okReport());
  const view = await (await getStatus(env)).json();
  assert.equal(view.history.recent.length, 240);
});

// --- misc -----------------------------------------------------------------

test('malformed JSON is rejected with 400, not a 500', async () => {
  const env = makeEnv();
  const body = '{not json';
  const ts = Math.floor(Date.now() / 1000);
  const signature = await sign(SECRET, ts, body);
  const res = await worker.fetch(new Request('https://example.test/api/ingest', {
    method: 'POST', body,
    headers: { 'X-Timestamp': String(ts), 'X-Signature': `sha256=${signature}` },
  }), env, { waitUntil() {} });
  assert.equal(res.status, 400);
});

test('GET on the ingest endpoint is refused', async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    new Request('https://example.test/api/ingest'), env, { waitUntil() {} },
  );
  assert.equal(res.status, 405);
});

test('the public status endpoint is readable cross-origin and never cached', async () => {
  const env = makeEnv();
  const res = await getStatus(env);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});
