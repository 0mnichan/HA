/**
 * Local preview server. Serves the real status page against the real Worker
 * logic, seeded with synthetic data, so you can see the page without
 * deploying anything.
 *
 *   npm run preview      ->  http://localhost:8788
 *
 * Flags:  --state=operational|degraded|down|unknown|maintenance
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import worker from '../src/worker.js';

const PORT = Number(process.env.PORT || 8788);
const SITE = new URL('../site/', import.meta.url).pathname;
const scenario = (process.argv.find((a) => a.startsWith('--state=')) || '').split('=')[1]
  || 'operational';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// --- synthetic state -------------------------------------------------------

const now = Math.floor(Date.now() / 1000);

function seedDaily() {
  const daily = {};
  for (let i = 89; i >= 0; i--) {
    const day = new Date((now - i * 86400) * 1000).toISOString().slice(0, 10);
    const samples = 720;
    let down = 0, deg = 0;
    if (i === 41) { down = 96; deg = 20; }        // a real outage
    else if (i === 17) { down = 12; deg = 40; }   // a short blip
    else if (i % 23 === 0) { deg = 8; }           // occasional degradation
    daily[day] = { up: samples - down - deg, deg, down };
  }
  return daily;
}

function seedRecent() {
  const out = [];
  for (let i = 239; i >= 0; i--) {
    const t = now - i * 120;
    // A believable latency wobble with a slow ramp in the middle.
    const base = 24 + Math.sin(i / 14) * 6 + (i > 90 && i < 130 ? 55 : 0);
    let s = 0;
    if (scenario === 'down' && i < 6) s = 2;
    else if (i > 90 && i < 130) s = 1;
    out.push({ t, s, l: Math.max(8, Math.round(base + (i % 7) * 1.4)) });
  }
  return out;
}

const CHECKS = {
  operational: [
    ['egress_internet', 'Internet reachable from the Pi', 'Exit node', 'operational',
     'The Pi reached the internet in 24 ms, so traffic routed through it gets out.', '24 ms', true],
    ['dns_resolution', 'DNS resolution', 'Exit node', 'operational', 'Name lookups are working (9 ms).', '9 ms', false],
    ['ip_forwarding', 'IP forwarding enabled', 'Exit node', 'operational',
     'The kernel is configured to forward traffic, which an exit node needs.', 'on', false],
    ['upstream_quality', 'Home internet quality', 'Exit node', 'operational', 'No packet loss to 1.1.1.1.', '0% loss', false],
    ['ts_backend', 'Tailscale daemon', 'Tailscale', 'operational', 'tailscaled is running and logged in.', 'Running', true],
    ['ts_path', 'Direct connection path', 'Tailscale', 'operational',
     'UDP is open, so clients can connect directly for full speed.', 'direct', false],
    ['pi_temp', 'CPU temperature', 'Host', 'operational', 'Temperature is normal at 51.4°C.', '51.4°C', false],
    ['pi_disk', 'Disk space', 'Host', 'operational', 'Storage is 63% full.', '63%', false],
    ['kuma_addon', 'Uptime Kuma', 'Host', 'operational', 'Monitoring add-on is running.', 'started', false],
  ],
  degraded: [
    ['egress_internet', 'Internet reachable from the Pi', 'Exit node', 'degraded',
     'The Pi can reach the internet, but responses are slow (612 ms). Traffic through the exit node will feel sluggish.', '612 ms', true],
    ['dns_resolution', 'DNS resolution', 'Exit node', 'operational', 'Name lookups are working (11 ms).', '11 ms', false],
    ['ip_forwarding', 'IP forwarding enabled', 'Exit node', 'degraded',
     'IPv4 forwarding is on but IPv6 forwarding is off, so IPv6 destinations will not work through the exit node.', 'IPv4 only', false],
    ['upstream_quality', 'Home internet quality', 'Exit node', 'degraded',
     '4% packet loss to 1.1.1.1. Expect occasional stalls through the exit node.', '4% loss', false],
    ['ts_backend', 'Tailscale daemon', 'Tailscale', 'operational', 'tailscaled is running and logged in.', 'Running', true],
    ['ts_path', 'Direct connection path', 'Tailscale', 'degraded',
     'UDP is blocked on this network, so all exit node traffic is relayed through DERP. It works, but it will be noticeably slower.', 'relayed', false],
    ['pi_temp', 'CPU temperature', 'Host', 'degraded', 'The Pi is running hot at 78.2°C and may start throttling.', '78.2°C', false],
    ['pi_disk', 'Disk space', 'Host', 'operational', 'Storage is 63% full.', '63%', false],
  ],
  down: [
    ['egress_internet', 'Internet reachable from the Pi', 'Exit node', 'down',
     'The Pi has no working internet connection (curl exit 6). Anything using this exit node has no internet either.', 'offline', true],
    ['dns_resolution', 'DNS resolution', 'Exit node', 'down',
     'The Pi cannot resolve hostnames, so anything routed through the exit node will fail to load by name.', 'no resolve', true],
    ['ip_forwarding', 'IP forwarding enabled', 'Exit node', 'operational',
     'The kernel is configured to forward traffic, which an exit node needs.', 'on', false],
    ['ts_backend', 'Tailscale daemon', 'Tailscale', 'operational', 'tailscaled is running and logged in.', 'Running', true],
    ['pi_temp', 'CPU temperature', 'Host', 'operational', 'Temperature is normal at 49.9°C.', '49.9°C', false],
    ['pi_disk', 'Disk space', 'Host', 'operational', 'Storage is 63% full.', '63%', false],
  ],
};
CHECKS.maintenance = CHECKS.operational;
CHECKS.unknown = [];

function buildState() {
  const checks = (CHECKS[scenario] || CHECKS.operational).map(
    ([id, label, group, status, message, metric, critical]) =>
      ({ id, label, group, status, message, metric, critical }),
  );

  const state = {
    version: 1,
    agent: scenario === 'unknown' ? null : {
      receivedAt: now - 38,
      report: {
        agentVersion: '1.0.0',
        checks,
        metrics: { exitLatencyMs: scenario === 'degraded' ? 612 : 24, dnsLatencyMs: 9, packetLossPct: scenario === 'degraded' ? 4 : 0 },
        host: {
          cpuTempC: scenario === 'degraded' ? 78.2 : 51.4,
          load1: 0.34, memUsedPct: 46.2, diskUsedPct: 63, uptimeSeconds: 1_642_000,
        },
        egressIp: '', egressNetwork: 'GB',
      },
    },
    tailscale: {
      checkedAt: now - 240, ok: true, error: null,
      device: {
        hostname: 'homeassistant-pi', online: scenario !== 'down',
        lastSeen: '2026-09-21T09:04:00Z', os: 'linux', clientVersion: '1.78.1',
        updateAvailable: false, authorized: true, keyExpiryDisabled: true, expires: null,
        advertisesExitNode: true, exitNodeApproved: true,
        advertisesExitNodeV6: scenario !== 'degraded', exitNodeApprovedV6: scenario !== 'degraded',
      },
    },
    notice: scenario === 'maintenance'
      ? { level: 'maintenance', title: 'Router firmware upgrade',
          body: 'The home router is being upgraded. The exit node will drop for roughly 15 minutes.',
          since: now - 900 }
      : scenario === 'down'
      ? { level: 'critical', title: 'ISP outage in the area',
          body: 'The home broadband line is down. The provider estimates service returns this evening.',
          since: now - 3400 }
      : null,
    recent: seedRecent(),
    daily: seedDaily(),
  };
  return state;
}

// --- server ----------------------------------------------------------------

const kvStore = new Map();
kvStore.set('state:v1', JSON.stringify(buildState()));

const env = {
  STATUS_KV: {
    async get(k, t) {
      const v = kvStore.get(k);
      return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v);
    },
    async put(k, v) { kvStore.set(k, v); },
  },
  INGEST_SECRET: 'preview',
  AGENT_STALE_AFTER: '300',
  SITE_TITLE: 'Tailscale Exit Node Status',
  SITE_SUBTITLE: 'Raspberry Pi · home exit node',
  UPTIME_KUMA_URL: 'https://example.invalid/status/exit-node',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    // Forward method, headers and body so signed POSTs (ingest, notice, poll)
    // can be exercised locally exactly as they would be against the Worker.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const wres = await worker.fetch(
      new Request(`https://preview.local${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      }),
      env, { waitUntil() {} },
    );
    res.writeHead(wres.status, Object.fromEntries(wres.headers));
    res.end(Buffer.from(await wres.arrayBuffer()));
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  try {
    const body = await readFile(join(SITE, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Preview (${scenario}) on http://localhost:${PORT}`);
});
