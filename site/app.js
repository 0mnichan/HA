/* Status page renderer. No dependencies, no build step. */
(() => {
  'use strict';

  const REFRESH_MS = 30000;
  const el = (id) => document.getElementById(id);
  const tooltip = el('tooltip');

  const LABEL = {
    operational: 'Operational',
    degraded: 'Degraded',
    down: 'Down',
    unknown: 'Unknown',
    maintenance: 'Maintenance',
  };

  // What a viewer of this page should actually DO about the current state.
  const ADVICE = {
    operational: '<strong>Nothing to do.</strong> Pick this exit node in your Tailscale client as usual.',
    degraded: '<strong>Usable, but expect problems.</strong> Traffic should still get through, though some connections may be slow or fail. Failing checks are listed below.',
    down: '<strong>Turn the exit node off for now.</strong> In your Tailscale client choose <em>Exit node &rarr; None</em>, otherwise your internet may not work at all.',
    unknown: '<strong>Status cannot be confirmed.</strong> If your connection stops working while this exit node is selected, set <em>Exit node &rarr; None</em> in your Tailscale client.',
    maintenance: '<strong>Planned work is in progress.</strong> Set <em>Exit node &rarr; None</em> in your Tailscale client until this clears.',
  };

  // A status page often lives in a pinned tab, so the favicon carries the
  // state too. '#' must be percent-encoded inside a data URI.
  const FAVICON = {
    operational: '%230ca30c', degraded: '%23fab219', down: '%23d03b3b',
    unknown: '%23898781', maintenance: '%232a78d6',
  };

  function setFavicon(status) {
    const link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    const c = FAVICON[status] || FAVICON.unknown;
    link.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' "
      + `viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='${c}'/></svg>`;
  }

  // ---- theme --------------------------------------------------------------

  const savedTheme = safeGet('theme');
  if (savedTheme === 'dark' || savedTheme === 'light') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
  el('theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.hasAttribute('data-theme')
          && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    safeSet('theme', next);
    if (lastData) render(lastData); // charts are measured, so re-render
  });

  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

  // ---- fetch loop ---------------------------------------------------------

  let lastData = null;

  async function load() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      el('error-banner').setAttribute('data-show', 'false');
      lastData = data;
      render(data);
    } catch (err) {
      el('error-banner').setAttribute('data-show', 'true');
      el('error-detail').textContent =
        `${err.message}. The page will keep retrying. If this persists, the status service itself is down - which says nothing about the exit node.`;
    }
  }

  load();
  setInterval(load, REFRESH_MS);
  addEventListener('resize', debounce(() => { if (lastData) render(lastData); }, 180));
  // Re-fetch immediately when the tab comes back to the foreground.
  addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  // ---- render -------------------------------------------------------------

  function render(d) {
    document.title = `${LABEL[d.overall.status] || 'Status'} - ${d.title || 'Exit Node Status'}`;
    setFavicon(d.overall.status);
    el('site-title').textContent = d.title || 'Exit Node Status';
    el('site-subtitle').textContent = d.subtitle || '';

    renderHero(d);
    renderNotice(d);
    renderUptime(d);
    renderComponents(d);
    renderRecent(d);
    renderLatency(d);
    renderHost(d);
    renderFooter(d);
  }

  function renderHero(d) {
    const s = d.overall.status;
    const hero = el('hero');
    hero.setAttribute('data-status', s);
    hero.querySelector('.hero-icon use').setAttribute('href', `#i-${s}`);
    el('hero-headline').textContent = d.overall.headline;
    el('hero-summary').textContent = d.overall.summary;
    const advice = el('hero-advice');
    advice.innerHTML = ADVICE[s] || '';
    advice.hidden = !ADVICE[s];
  }

  function renderNotice(d) {
    const box = el('notice');
    if (!d.notice) { box.hidden = true; return; }
    box.hidden = false;
    box.setAttribute('data-status',
      d.notice.level === 'critical' ? 'down'
        : d.notice.level === 'warning' ? 'degraded'
        : d.notice.level === 'maintenance' ? 'maintenance' : 'maintenance');
    el('notice-title').textContent = d.notice.title;
    el('notice-body').textContent = d.notice.body;
    el('notice-when').textContent = d.notice.since ? `Posted ${relTime(d.notice.since, d.generatedAt)}` : '';
  }

  function renderUptime(d) {
    const u = d.uptime || {};
    const tiles = [
      ['Last 24h', u.d1], ['7 days', u.d7], ['30 days', u.d30], ['90 days', u.d90],
    ];
    el('uptime-tiles').innerHTML = tiles.map(([label, v]) => `
      <div class="tile">
        <span class="label">${esc(label)}</span>
        <span class="value">${v === null || v === undefined ? '<span class="skeleton">no data</span>'
          : `${fmtPct(v)}<span class="unit">%</span>`}</span>
      </div>`).join('');

    // Only render as many days as can stay legible at this width.
    const wrapEl = el('daily-bars');
    const width = wrapEl.clientWidth || 640;
    const all = d.history.daily || [];
    const count = Math.max(30, Math.min(all.length, Math.floor((width + 2) / 7)));
    const days = all.slice(-count);

    wrapEl.innerHTML = days.map((day) => {
      const st = dayStatus(day);
      const total = day.up + day.deg + day.down;
      const title = day.pct === null
        ? `${day.d}: no data`
        : `${day.d}: ${fmtPct(day.pct)}% available (${total} checks)`;
      return `<div class="bar" data-status="${st}" data-day="${esc(day.d)}"
                   data-pct="${day.pct === null ? '' : day.pct}"
                   data-up="${day.up}" data-deg="${day.deg}" data-down="${day.down}"
                   title="${esc(title)}"></div>`;
    }).join('');

    el('daily-from').textContent = days.length ? fmtDate(days[0].d) : '—';
    el('daily-legend').textContent = `${days.length} days`;

    attachBarTooltips(wrapEl, (b) => {
      const pct = b.dataset.pct;
      return {
        title: fmtDate(b.dataset.day),
        rows: pct === ''
          ? ['No data recorded']
          : [`${fmtPct(Number(pct))}% available`,
             `${b.dataset.up} OK · ${b.dataset.deg} degraded · ${b.dataset.down} down`],
      };
    });

    const rows = all.filter((x) => x.pct !== null).reverse();
    el('daily-table').querySelector('tbody').innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${esc(fmtDate(r.d))}</td><td>${fmtPct(r.pct)}%</td>
          <td>${r.up}</td><td>${r.deg}</td><td>${r.down}</td></tr>`).join('')
      : '<tr><td colspan="5">No history recorded yet.</td></tr>';
  }

  function dayStatus(day) {
    if (day.pct === null) return 'nodata';
    if (day.down > 0) return 'down';
    if (day.deg > 0) return 'degraded';
    return 'operational';
  }

  function renderComponents(d) {
    const comps = d.components || [];
    if (!comps.length) {
      el('components').innerHTML = '<p class="skeleton">No checks have been reported yet.</p>';
      return;
    }
    const groups = [];
    for (const c of comps) {
      let g = groups.find((x) => x.name === c.group);
      if (!g) { g = { name: c.group || 'Other', items: [] }; groups.push(g); }
      g.items.push(c);
    }
    el('components').innerHTML = groups.map((g) => `
      <div class="group-label">${esc(g.name)}</div>
      ${g.items.map((c) => `
        <div class="component" data-status="${esc(c.status)}">
          <div class="component-main">
            <div class="component-name">
              <span>${esc(c.label)}</span>
              ${c.metric ? `<span class="component-metric">${esc(c.metric)}</span>` : ''}
            </div>
            ${c.message ? `<p class="component-msg">${esc(c.message)}</p>` : ''}
          </div>
          <span class="pill"><svg aria-hidden="true"><use href="#i-${esc(c.status)}"></use></svg>${esc(LABEL[c.status] || c.status)}</span>
        </div>`).join('')}
    `).join('');
  }

  function renderRecent(d) {
    const wrapEl = el('recent-bars');
    const all = d.history.recent || [];
    if (!all.length) {
      wrapEl.innerHTML = '';
      el('recent-from').textContent = 'No samples yet';
      return;
    }
    const width = wrapEl.clientWidth || 640;
    const count = Math.max(30, Math.min(all.length, Math.floor((width + 1) / 4)));
    const pts = all.slice(-count);
    const NAME = ['operational', 'degraded', 'down', 'unknown', 'maintenance'];

    wrapEl.innerHTML = pts.map((p) => {
      const st = NAME[p.s] || 'unknown';
      return `<div class="bar" data-status="${st}" data-t="${p.t}" data-l="${p.l === null ? '' : p.l}"
                   title="${esc(`${fmtTime(p.t)} — ${LABEL[st]}`)}"></div>`;
    }).join('');

    el('recent-from').textContent = fmtTime(pts[0].t);

    attachBarTooltips(wrapEl, (b) => {
      const st = b.getAttribute('data-status');
      const rows = [LABEL[st] || st];
      if (b.dataset.l) rows.push(`${b.dataset.l} ms to the internet`);
      return { title: fmtTime(Number(b.dataset.t)), rows };
    });
  }

  function renderLatency(d) {
    const block = el('latency-block');
    const pts = (d.history.recent || []).filter((p) => typeof p.l === 'number');
    if (pts.length < 2) { block.hidden = true; return; }
    block.hidden = false;

    const svg = el('spark');
    const w = svg.clientWidth || 640;
    const h = 64;
    const padY = 8;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const vals = pts.map((p) => p.l);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const x = (i) => (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w);
    const y = (v) => padY + (1 - (v - min) / span) * (h - padY * 2);

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.l).toFixed(1)}`).join('');
    const area = `${line}L${w},${h}L0,${h}Z`;

    svg.innerHTML = `
      <path class="spark-area" d="${area}"/>
      <path class="spark-line" d="${line}"/>
      <line class="spark-cursor" id="spark-cursor" x1="0" y1="0" x2="0" y2="${h}" style="display:none"/>
      <circle class="spark-dot" id="spark-dot" cx="0" cy="0" style="display:none"/>`;

    const current = vals[vals.length - 1];
    el('latency-current').textContent = `${current} ms now · ${min}–${max} ms range`;

    const cursor = el('spark-cursor');
    const dot = el('spark-dot');

    svg.onpointermove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const rel = (ev.clientX - rect.left) / rect.width;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(rel * (pts.length - 1))));
      const px = x(i), py = y(pts[i].l);
      cursor.setAttribute('x1', px); cursor.setAttribute('x2', px);
      cursor.style.display = ''; dot.style.display = '';
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      showTooltip(ev, { title: `${pts[i].l} ms`, rows: [fmtTime(pts[i].t)] });
    };
    svg.onpointerleave = () => {
      cursor.style.display = 'none'; dot.style.display = 'none'; hideTooltip();
    };
  }

  function renderHost(d) {
    const h = d.host || {};
    const m = d.metrics || {};
    const tiles = [];

    if (typeof h.cpuTempC === 'number') {
      tiles.push(tile('CPU temp', h.cpuTempC.toFixed(1), '°C',
        h.cpuTempC >= 82 ? 'down' : h.cpuTempC >= 75 ? 'degraded' : null));
    }
    if (typeof h.diskUsedPct === 'number') {
      tiles.push(tile('Disk used', Math.round(h.diskUsedPct), '%',
        h.diskUsedPct >= 92 ? 'down' : h.diskUsedPct >= 85 ? 'degraded' : null));
    }
    if (typeof h.memUsedPct === 'number') {
      tiles.push(tile('Memory used', Math.round(h.memUsedPct), '%',
        h.memUsedPct >= 95 ? 'degraded' : null));
    }
    if (typeof h.load1 === 'number') tiles.push(tile('Load (1m)', h.load1.toFixed(2), '', null));
    if (typeof h.uptimeSeconds === 'number') tiles.push(tile('Pi uptime', fmtUptime(h.uptimeSeconds), '', null));
    if (typeof m.packetLossPct === 'number') {
      tiles.push(tile('Packet loss', Math.round(m.packetLossPct), '%',
        m.packetLossPct >= 20 ? 'down' : m.packetLossPct > 0 ? 'degraded' : null));
    }
    if (typeof m.dnsLatencyMs === 'number') tiles.push(tile('DNS lookup', Math.round(m.dnsLatencyMs), 'ms', null));
    if (d.egress && d.egress.network) tiles.push(tile('Egress region', esc(d.egress.network), '', null));
    if (d.egress && d.egress.ip) tiles.push(tile('Egress IP', esc(d.egress.ip), '', null));

    const card = el('host-card');
    if (!tiles.length) { card.hidden = true; return; }
    card.hidden = false;
    el('host-tiles').innerHTML = tiles.join('');
  }

  function tile(label, value, unit, status) {
    return `<div class="tile"${status ? ` data-status="${status}"` : ''}>
      <span class="label">${esc(label)}</span>
      <span class="value">${value}${unit ? `<span class="unit">${esc(unit)}</span>` : ''}</span>
    </div>`;
  }

  function renderFooter(d) {
    const agent = d.sources.agent;
    const ts = d.sources.tailscaleApi;
    const parts = [];

    if (agent.ageSeconds === null) parts.push('Pi has never reported in');
    else parts.push(`Pi reported ${relTime(d.generatedAt - agent.ageSeconds, d.generatedAt)}`);

    if (ts.enabled && ts.ageSeconds !== null) {
      parts.push(`Tailscale checked ${relTime(d.generatedAt - ts.ageSeconds, d.generatedAt)}`);
    }
    el('last-updated').textContent = parts.join(' · ');
    el('live-dot').setAttribute('data-stale', String(agent.stale));

    const links = [];
    if (d.links && d.links.uptimeKuma) {
      links.push(`<a href="${esc(d.links.uptimeKuma)}" rel="noopener noreferrer">Detailed monitors</a>`);
    }
    links.push('Auto-refreshes every 30s');
    el('foot-links').innerHTML = links.join(' · ');
  }

  // ---- tooltip ------------------------------------------------------------

  function attachBarTooltips(container, build) {
    container.onpointermove = (ev) => {
      const bar = ev.target.closest('.bar');
      if (!bar) { hideTooltip(); return; }
      showTooltip(ev, build(bar));
    };
    container.onpointerleave = hideTooltip;
  }

  function showTooltip(ev, { title, rows }) {
    tooltip.innerHTML = `<span class="tt-title">${esc(title)}</span>` +
      rows.map((r) => `<span class="tt-row">${esc(r)}</span>`).join('<br>');
    tooltip.setAttribute('data-show', 'true');
    const pad = 12;
    const rect = tooltip.getBoundingClientRect();
    let left = ev.clientX + pad;
    let top = ev.clientY - rect.height - pad;
    if (left + rect.width > innerWidth - 8) left = ev.clientX - rect.width - pad;
    if (top < 8) top = ev.clientY + pad;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() { tooltip.setAttribute('data-show', 'false'); }

  // ---- formatting ---------------------------------------------------------

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtPct(v) {
    return v >= 99.995 ? '100' : v.toFixed(2);
  }

  function fmtDate(iso) {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function fmtTime(sec) {
    return new Date(sec * 1000).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtUptime(sec) {
    const d = Math.floor(sec / 86400);
    if (d >= 1) return `${d}d ${Math.floor((sec % 86400) / 3600)}h`;
    const h = Math.floor(sec / 3600);
    return h >= 1 ? `${h}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`;
  }

  function relTime(then, now) {
    const s = Math.max(0, now - then);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
})();
