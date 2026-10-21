#!/usr/bin/env node
// THE EMERGENCY HOST — a standby copy of Phoenix on Fly.io (Frankfurt), for the day Railway cannot deploy at all
// (owner, 2026-10-21: "built a fallback deployment route to rely on when railway fails … easy and user friendly";
// he picked Fly.io in Frankfurt, switched by one button he presses).
//
// WHY A SECOND HOST. On 21 Oct 2026 Railway paused every build AND refused every deploy call ("Deploys have been
// paused temporarily") for more than nine hours. The fallback route (fallback-image.yml) built the image on GitHub
// fine, but still needed Railway to RUN it, and Railway refused that too. This route runs the SAME image on Fly.io
// and points phoenix-hr.satopharma.com (a Cloudflare CNAME) at it until Railway is healthy again.
//
//   node scripts/emergency-host.mjs status                                   read-only: DNS, Fly, both revisions
//   node scripts/emergency-host.mjs export-variables --out <file>            Railway's production web variables, filtered
//   node scripts/emergency-host.mjs certificate                              ask Fly for the domain's certificate + its DNS check
//   node scripts/emergency-host.mjs wait-standby --sha <40 hex>              the standby's own address reports the commit
//   node scripts/emergency-host.mjs point --to fly|railway [--sha <40 hex>]   flip the domain and wait until it is served there
//   node scripts/emergency-host.mjs notify --text <message>                  one Telegram line to the owner
//
// 🔴 THE STANDBY NEVER RUNS A SCHEDULER OR THE CRM POLLER. Railway's worker keeps them. infra/fly-standby/fly.toml
// forces PHOENIX_PROCESS_ROLE=web and PHOENIX_LIVE_CRM_POLL=false, the copy never carries a RAILWAY_* variable (the
// poller's host pin reads RAILWAY_ENVIRONMENT_NAME), and the copy drops the keys fly.toml forces, because a Fly
// secret outranks a fly.toml [env] value.
//
// 🔴 THE GATE IS THE WORKFLOW'S. Off Railway, /api/readyz's release gate is open (it keys on RAILWAY_ENVIRONMENT_NAME),
// so emergency-host.yml refuses any commit whose own ci.yml push run lacks a green release-gate job — the same rule.
//
// 🔴 A SECRET IS NEVER PRINTED. Values go only into the file `flyctl secrets import` reads, and every message is
// scrubbed of the tokens in use. Account and rules: docs/deployment.md, "The emergency host".

import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "emergency-host",
  entry: import.meta.url,
  known: ["--out", "--sha", "--to", "--text"],
});

export const DOMAIN = "phoenix-hr.satopharma.com";
export const ZONE = "satopharma.com";
/** What Cloudflare's CNAME holds when Railway serves (docs/deployment.md, "Production Verification"). */
export const RAILWAY_TARGET = "xok6ir4p.up.railway.app";
/** Railway's own address for the web service — answers whatever the domain points at. */
export const RAILWAY_DIRECT_URL = "https://phoenix-people-workforce-production.up.railway.app";
export const DEFAULT_FLY_APP = "phoenix-hr-standby";
export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
export const RAILWAY_PROJECT_ID = "dc218ad3-99b7-4aff-be38-953a57524a71";
export const RAILWAY_PRODUCTION_ENV = "cd5600e6-99dd-4b1c-80b2-16af8770abef";
export const RAILWAY_WEB_SERVICE = "30356676-116b-4886-ac6e-89041d80185e";
/** One minute, so a flip — and the flip back — reaches every resolver within about a minute. */
export const DNS_TTL_SECONDS = 60;

/**
 * Keys fly.toml sets itself and the copy must never override (a Fly secret outranks [env]): the process role, the
 * poller switch, and the port/host the image already declares.
 */
export const FORCED_KEYS = Object.freeze(["PHOENIX_PROCESS_ROLE", "PHOENIX_LIVE_CRM_POLL", "PHOENIX_HOST", "PORT", "HOSTNAME"]);

/**
 * Credentials Railway holds that the app never reads (docs/environment.md: CLOUDFLARE_API_TOKEN is "not currently consumed
 * by any workflow or app code"). The standby gets none of them: a DNS-editing token on a second host only widens who can
 * move the domain.
 */
export const NEVER_COPIED = Object.freeze(["CLOUDFLARE_API_TOKEN"]);

export const appName = () => (process.env.FLY_APP || DEFAULT_FLY_APP).trim();
export const flyTarget = (app = appName()) => `${app}.fly.dev`;
export const isFullSha = (value) => /^[0-9a-f]{40}$/.test(String(value ?? ""));

// ── Pure helpers (pinned by tests/emergency-host.test.ts) ──────────────────────────────────────────────────────────

/**
 * The production web variables the standby gets. Every RAILWAY_* key is dropped (Railway injects them, and the CRM
 * poller's host pin and the release gate read RAILWAY_ENVIRONMENT_NAME), as is every key fly.toml forces. Empty values
 * are dropped: `flyctl secrets import` cannot carry one and the app reads "unset" the same way.
 */
export function filterVariables(source) {
  const kept = {};
  const dropped = [];
  for (const [name, raw] of Object.entries(source ?? {})) {
    const value = raw == null ? "" : String(raw);
    if (name.startsWith("RAILWAY_") || FORCED_KEYS.includes(name) || NEVER_COPIED.includes(name) || value === "" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      dropped.push(name);
      continue;
    }
    kept[name] = value;
  }
  return { kept, dropped: dropped.sort() };
}

/** `flyctl secrets import` input: NAME=VALUE per line; a value with a line break goes between triple quotes. */
export function renderSecrets(variables) {
  return Object.entries(variables)
    .map(([name, value]) => {
      if (/[\r\n]/.test(value)) {
        if (value.includes('"""')) throw new Error(`${name}: a value containing """ cannot be imported`);
        return `${name}="""${value}"""`;
      }
      return `${name}=${value}`;
    })
    .join("\n")
    .concat("\n");
}

/** Where the domain points, by its CNAME content. Anything else is a state nobody chose, and nothing flips it. */
export function classifyTarget(content, app = appName()) {
  const c = String(content ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (c === RAILWAY_TARGET) return "railway";
  if (c === flyTarget(app).toLowerCase()) return "fly";
  return "unknown";
}

/** Which host answered, from its response headers: Fly's proxy stamps fly-request-id, Railway's edge x-railway-*. */
export function servedBy(headers) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  const server = String(get("server") ?? "").toLowerCase();
  if (get("fly-request-id") || server.startsWith("fly/")) return "fly";
  if (get("x-railway-request-id") || get("x-railway-edge") || server.includes("railway")) return "railway";
  return "unknown";
}

/**
 * Has Fly ISSUED a certificate for the domain? `configured` is NOT that: on 2026-10-21 setup read configured=true while
 * the status said "Awaiting certificates" — the DNS was right, nothing was issued yet. Flipping then sends every user to
 * a browser security error. Ready means the overall status says so, or a Fly-issued certificate is active with an issue.
 */
export function certificateReady(body) {
  const state = String(body?.status ?? "").trim().toLowerCase();
  if (["ready", "issued", "active"].includes(state)) return true;
  return (body?.certificates ?? []).some(
    (c) => String(c?.source ?? "").toLowerCase() === "fly" && ["active", "ready", "issued"].includes(String(c?.status ?? "").toLowerCase()) && (c?.issued ?? []).length > 0,
  );
}

/** Refuse a flip from a state nobody chose, and a flip to where it already points (that is a no-op, said so). */
export function planFlip({ current, to }) {
  if (!["fly", "railway"].includes(to)) throw new Error(`--to must be fly or railway, not ${to}`);
  if (current === "unknown") {
    throw new Error(`${DOMAIN} points at neither Railway (${RAILWAY_TARGET}) nor the standby (${flyTarget()}). Refusing to change a record nobody here set — read it in Cloudflare first.`);
  }
  return current === to ? "already" : "flip";
}

export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) if (secret && String(secret).length >= 4) out = out.split(String(secret)).join("***");
  return out;
}

export function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const flags = new Map();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(arg.slice(2), "true");
    else {
      flags.set(arg.slice(2), next);
      i += 1;
    }
  }
  return { command, flags };
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const secretsInUse = () => [
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.FLY_API_TOKEN,
  process.env.RAILWAY_API_TOKEN,
  process.env.RAILWAY_TOKEN,
  process.env.TELEGRAM_BOT_TOKEN,
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};
const need = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. It is a GitHub secret the owner adds once (docs/deployment.md, "The emergency host").`);
  return value;
};

async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${need("CLOUDFLARE_API_TOKEN")}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!body.success) throw new Error(`Cloudflare refused ${path}: ${(body.errors ?? []).map((e) => e.message).join("; ") || `HTTP ${response.status}`}`);
  return body.result;
}

async function zoneId() {
  const zones = await cloudflare(`/zones?name=${ZONE}`);
  if (!zones?.[0]?.id) throw new Error(`Cloudflare has no zone ${ZONE} this token can see.`);
  return zones[0].id;
}

async function readRecord(zone, name, type = "CNAME") {
  const records = await cloudflare(`/zones/${zone}/dns_records?type=${type}&name=${name}`);
  return records?.[0] ?? null;
}

async function fly(path, init = {}) {
  const response = await fetch(`https://api.machines.dev/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${need("FLY_API_TOKEN")}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, body, text };
}

async function healthz(base) {
  try {
    const response = await fetch(`${base}/api/healthz`, { signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, revision: body?.revision ?? null, host: servedBy(response.headers) };
  } catch (error) {
    return { ok: false, revision: null, host: "unknown", error: String(error?.message ?? error) };
  }
}

async function railwayVariables() {
  const token = process.env.RAILWAY_API_TOKEN?.trim() || process.env.RAILWAY_TOKEN?.trim();
  if (!token) throw new Error("RAILWAY_API_TOKEN or RAILWAY_TOKEN is required to copy the variables.");
  const query = `query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}`;
  const variables = { p: RAILWAY_PROJECT_ID, e: RAILWAY_PRODUCTION_ENV, s: RAILWAY_WEB_SERVICE };
  let last = "no answer";
  // The repo's Railway secret may be an account token (Bearer) or a project token — try both, as fallback-image-deploy does.
  for (const auth of [{ authorization: `Bearer ${token}` }, { "project-access-token": token }]) {
    const response = await fetch(RAILWAY_API, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({}));
    if (body.data?.variables) return body.data.variables;
    last = (body.errors ?? []).map((e) => e.message).join("; ") || `HTTP ${response.status}`;
  }
  throw new Error(`Railway's variables could not be read (${last}). The standby keeps the copy it already has.`);
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function status() {
  const app = appName();
  note(`### Emergency host — ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Cairo" })} Cairo`);
  try {
    const record = await readRecord(await zoneId(), DOMAIN);
    note(`- ${DOMAIN} points at **${classifyTarget(record?.content, app)}** (${record?.content ?? "no CNAME"}, TTL ${record?.ttl ?? "-"})`);
  } catch (error) {
    note(`- DNS unreadable: ${redact(error.message, secretsInUse())}`);
  }
  const [domain, railway, standby] = await Promise.all([healthz(`https://${DOMAIN}`), healthz(RAILWAY_DIRECT_URL), healthz(`https://${flyTarget(app)}`)]);
  note(`- the domain answers from ${domain.host}, revision ${domain.revision?.slice(0, 9) ?? "none"}`);
  note(`- Railway directly: ${railway.ok ? `up, revision ${railway.revision?.slice(0, 9)}` : "not answering"}`);
  note(`- standby (${flyTarget(app)}): ${standby.ok ? `up, revision ${standby.revision?.slice(0, 9)}` : "not running (normal while Railway serves)"}`);
  if (process.env.FLY_API_TOKEN) {
    const cert = await fly(`/apps/${app}/certificates/${DOMAIN}`);
    note(`- standby certificate for ${DOMAIN}: ${cert.status === 200 ? cert.body?.status ?? "unknown" : `not requested (HTTP ${cert.status})`}`);
  }
}

async function exportVariables(flags) {
  const out = flags.get("out");
  if (!out) throw new Error("--out <file> is required");
  const { kept, dropped } = filterVariables(await railwayVariables());
  const count = Object.keys(kept).length;
  if (count < 10) throw new Error(`Only ${count} variables survived the filter — that is not a production copy. Nothing written.`);
  writeFileSync(out, renderSecrets(kept), { mode: 0o600 });
  note(`- copied ${count} production web variables from Railway (values not shown); left out ${dropped.length}: the RAILWAY_* ones, the keys fly.toml forces, and empty ones`);
}

async function certificate() {
  const app = appName();
  let cert = await fly(`/apps/${app}/certificates/${DOMAIN}`);
  if (cert.status !== 200) {
    cert = await fly(`/apps/${app}/certificates/acme`, { method: "POST", body: JSON.stringify({ hostname: DOMAIN }) });
    if (cert.status >= 300) throw new Error(`Fly refused the certificate request (HTTP ${cert.status}): ${redact(cert.text.slice(0, 300), secretsInUse())}`);
    note(`- asked Fly for a certificate for ${DOMAIN}`);
  }
  const challenge = cert.body?.dns_requirements?.acme_challenge;
  if (!challenge?.name || !challenge?.target) throw new Error("Fly did not say which _acme-challenge record it needs.");
  // The challenge record lets Fly issue the certificate while the domain still points at Railway. It changes nothing
  // users reach: _acme-challenge is read only by the certificate authority.
  const zone = await zoneId();
  const existing = await readRecord(zone, challenge.name);
  const record = { type: "CNAME", name: challenge.name, content: challenge.target, ttl: DNS_TTL_SECONDS, proxied: false, comment: "Fly.io standby certificate (emergency host)" };
  if (!existing) await cloudflare(`/zones/${zone}/dns_records`, { method: "POST", body: JSON.stringify(record) });
  else if (existing.content !== challenge.target) await cloudflare(`/zones/${zone}/dns_records/${existing.id}`, { method: "PATCH", body: JSON.stringify(record) });
  note(`- ${challenge.name} → ${challenge.target} ${existing?.content === challenge.target ? "(already set)" : "(set)"}`);
  // A one-minute TTL on the live record, content untouched, so a future flip reaches users within about a minute.
  const live = await readRecord(zone, DOMAIN);
  if (!live) throw new Error(`${DOMAIN} has no CNAME in Cloudflare.`);
  if (live.ttl !== DNS_TTL_SECONDS) {
    await cloudflare(`/zones/${zone}/dns_records/${live.id}`, { method: "PATCH", body: JSON.stringify({ ttl: DNS_TTL_SECONDS }) });
    note(`- ${DOMAIN}: TTL ${live.ttl} → ${DNS_TTL_SECONDS}s (still points at ${live.content})`);
  }
  for (let i = 0; i < 30; i += 1) {
    const now = await fly(`/apps/${app}/certificates/${DOMAIN}`);
    if (certificateReady(now.body)) {
      note(`- certificate for ${DOMAIN}: ${now.body?.status ?? "issued"}`);
      return;
    }
    await sleep(10_000);
  }
  note(`- certificate for ${DOMAIN}: still being issued — \`status\` reports it; go-live checks it again before any flip`);
}

async function waitStandby(flags) {
  const sha = flags.get("sha");
  if (!isFullSha(sha)) throw new Error("--sha <40 hex> is required");
  const base = `https://${flyTarget()}`;
  for (let i = 0; i < 60; i += 1) {
    const h = await healthz(base);
    if (h.revision === sha) return note(`- standby ${flyTarget()} reports ${sha.slice(0, 9)}`);
    await sleep(10_000);
  }
  throw new Error(`The standby never reported ${sha.slice(0, 9)} on ${base}/api/healthz within 10 minutes.`);
}

async function point(flags) {
  const to = flags.get("to");
  const sha = flags.get("sha");
  const app = appName();
  const zone = await zoneId();
  const record = await readRecord(zone, DOMAIN);
  if (!record) throw new Error(`${DOMAIN} has no CNAME in Cloudflare.`);
  const current = classifyTarget(record.content, app);
  const plan = planFlip({ current, to });

  if (to === "fly") {
    // Never send users to a standby that cannot answer for this domain.
    const cert = await fly(`/apps/${app}/certificates/${DOMAIN}`);
    if (!certificateReady(cert.body)) {
      throw new Error(`The standby has no working certificate for ${DOMAIN} (${cert.body?.status ?? `HTTP ${cert.status}`}). Run the workflow with action = setup first. Nothing was changed.`);
    }
    const standby = await healthz(`https://${flyTarget(app)}`);
    if (!standby.ok || (sha && standby.revision !== sha)) throw new Error(`The standby is not answering with ${sha?.slice(0, 9) ?? "a revision"} (got ${standby.revision ?? "nothing"}). Nothing was changed.`);
  } else {
    const railway = await healthz(RAILWAY_DIRECT_URL);
    if (!railway.ok) throw new Error(`Railway is not answering on ${RAILWAY_DIRECT_URL} — flipping back would send users to a dead host. Nothing was changed.`);
  }

  if (plan === "flip") {
    const content = to === "fly" ? flyTarget(app) : RAILWAY_TARGET;
    await cloudflare(`/zones/${zone}/dns_records/${record.id}`, { method: "PATCH", body: JSON.stringify({ content, ttl: DNS_TTL_SECONDS, proxied: false }) });
    note(`- ${DOMAIN}: ${record.content} → ${content}`);
  } else {
    note(`- ${DOMAIN} already points at ${to}`);
  }

  // Proof is the DOMAIN answering from the chosen host (and with the commit, when one was given) — not the record.
  for (let i = 0; i < 60; i += 1) {
    const h = await healthz(`https://${DOMAIN}`);
    if (h.host === to && (!sha || h.revision === sha)) {
      return note(`- **${DOMAIN} is served by ${to === "fly" ? "the Fly.io standby" : "Railway"}**, revision ${h.revision?.slice(0, 9)}`);
    }
    await sleep(10_000);
  }
  throw new Error(`${DOMAIN} still did not answer from ${to} 10 minutes after the record changed. The record now says ${to}; read \`status\`.`);
}

async function notify(flags) {
  const text = flags.get("text");
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
  if (!token || !chat) return note("- Telegram not configured; no message sent");
  const body = new URLSearchParams({ chat_id: chat, text, disable_web_page_preview: "true" });
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", body, signal: AbortSignal.timeout(20_000) }).catch(() => null);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const commands = { status, "export-variables": exportVariables, certificate, "wait-standby": waitStandby, point, notify };
  if (!(command in commands)) throw new Error(`Unknown command "${command}". Use ${Object.keys(commands).join(" | ")}.`);
  await commands[command](flags);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[emergency-host] ${redact(error.message, secretsInUse())}`);
    process.exit(1);
  });
}
