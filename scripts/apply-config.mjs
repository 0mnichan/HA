#!/usr/bin/env node
/**
 * Prepare wrangler.toml for a CI deploy.
 *
 * Two things in wrangler.toml are per-deployment rather than per-repository:
 * the KV namespace id, and the [vars] block. Committing real values would put
 * one person's deployment in everyone's checkout, so CI fills them in instead:
 *
 *   - KV namespace id comes from the KV_NAMESPACE_ID repository variable, or
 *     is resolved from the Cloudflare account by listing namespaces.
 *   - Each [vars] entry can be overridden by a VAR_<NAME> environment
 *     variable, set from a GitHub repository variable.
 *
 * `wrangler deploy` replaces the Worker's plain-text vars with exactly what
 * this file holds, so anything not set here is reset to the repo default.
 * Secrets (INGEST_SECRET, TAILSCALE_*) live in Cloudflare and are untouched.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = 'wrangler.toml';
const PLACEHOLDER = 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID';

const OVERRIDABLE = [
  'SITE_TITLE', 'SITE_SUBTITLE', 'AGENT_STALE_AFTER',
  'TAILSCALE_TAILNET', 'TAILSCALE_DEVICE', 'SHOW_EGRESS_IP', 'UPTIME_KUMA_URL',
];

let toml = readFileSync(FILE, 'utf8');
const applied = [];

// --- KV namespace id -------------------------------------------------------

let kvId = (process.env.KV_NAMESPACE_ID || '').trim();
let kvSource = 'KV_NAMESPACE_ID variable';

if (!kvId) {
  kvId = resolveKvNamespace();
  kvSource = 'resolved from your Cloudflare account';
}

if (!/^[0-9a-f]{32}$/i.test(kvId)) {
  fail(`"${kvId}" does not look like a KV namespace id (32 hex characters).`);
}

if (!toml.includes(`id = "${PLACEHOLDER}"`)) {
  fail(`Expected id = "${PLACEHOLDER}" in ${FILE}. Has the file been edited?`);
}
toml = toml.replace(`id = "${PLACEHOLDER}"`, `id = "${kvId}"`);
applied.push(`KV namespace  ${kvId}  (${kvSource})`);

// --- [vars] overrides ------------------------------------------------------

for (const key of OVERRIDABLE) {
  const value = process.env[`VAR_${key}`];
  if (value === undefined || value === '') continue;

  const re = new RegExp(`^${key} = ".*"$`, 'm');
  if (!re.test(toml)) fail(`No "${key}" entry found in ${FILE} to override.`);

  toml = toml.replace(re, `${key} = ${JSON.stringify(value)}`);
  applied.push(`${key.padEnd(16)}${value}`);
}

writeFileSync(FILE, toml);

console.log('Applied deployment configuration:\n');
for (const line of applied) console.log(`  ${line}`);

const defaulted = OVERRIDABLE.filter((k) => !process.env[`VAR_${k}`]);
if (defaulted.length) {
  console.log(`\nUsing the repository default for: ${defaulted.join(', ')}`);
  console.log('Set a repository variable named VAR_<NAME> to override one.');
}

// ---------------------------------------------------------------------------

function resolveKvNamespace() {
  let raw;
  try {
    raw = execFileSync('npx', ['--yes', 'wrangler@4', 'kv', 'namespace', 'list'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch {
    fail('Could not list KV namespaces. Is CLOUDFLARE_API_TOKEN valid and does '
       + 'it include Workers KV read access?');
  }

  // wrangler prints a banner before the JSON on some versions.
  const start = raw.indexOf('[');
  let list;
  try {
    list = JSON.parse(raw.slice(start));
  } catch {
    fail(`Could not parse the namespace list:\n${raw}`);
  }

  const matches = list.filter((n) => String(n.title || '').includes('STATUS_KV'));

  if (matches.length === 1) return matches[0].id;

  if (matches.length === 0) {
    fail('No KV namespace with "STATUS_KV" in its title was found.\n'
      + `Namespaces on this account: ${list.map((n) => n.title).join(', ') || '(none)'}\n`
      + 'Create one with `wrangler kv namespace create STATUS_KV`, or set the '
      + 'KV_NAMESPACE_ID repository variable to the id of the one you already use.');
  }

  fail('More than one KV namespace matches "STATUS_KV":\n'
    + matches.map((n) => `  ${n.id}  ${n.title}`).join('\n')
    + '\nSet the KV_NAMESPACE_ID repository variable to the one you want.');
}

function fail(message) {
  console.error(`\nerror: ${message}\n`);
  process.exit(1);
}
