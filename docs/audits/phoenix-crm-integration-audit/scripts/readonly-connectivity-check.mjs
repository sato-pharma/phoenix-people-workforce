/**
 * Read-only connectivity probe for the integration audit.
 *
 * What it does: one or two GET requests per provider, to that provider's own status / identity /
 * listing endpoint, using the keys already in `.env.local`. It prints HTTP status, latency and
 * NON-SECRET metadata (counts, names of checks and jobs, verification states). It never prints a
 * key, a token, an e-mail address, a phone number or a message body.
 *
 * What it never does: send an e-mail, a Telegram message, a WhatsApp message or a push; ping a
 * heartbeat; create, update or delete anything; call a billable Google Maps endpoint; sign in to
 * iReports360 or Action1 (those two are probed for reachability only, with no credentials sent).
 *
 * Run from the repo root:  node docs/audits/phoenix-crm-integration-audit/scripts/readonly-connectivity-check.mjs
 */
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!match) continue;
  env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}

const results = [];
async function probe(id, integration, objective, url, init = {}, summarize = () => "") {
  const started = Date.now();
  const at = new Date().toISOString();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const ms = Date.now() - started;
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    let note = "";
    try {
      note = summarize(body, response, text) ?? "";
    } catch (error) {
      note = `summary failed: ${error.message}`;
    }
    results.push({ id, integration, objective, at, http: response.status, ms, note });
  } catch (error) {
    results.push({ id, integration, objective, at, http: "ERR", ms: Date.now() - started, note: `${error.name}: ${error.message}`.slice(0, 160) });
  }
}
const has = (name) => Boolean(env[name]);
const skip = (id, integration, objective, why) => results.push({ id, integration, objective, at: new Date().toISOString(), http: "SKIP", ms: 0, note: why });

// ── Supabase (production project named by .env.local) ───────────────────────────────────────
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (supabaseUrl && anon) {
  await probe("T-SB-01", "Supabase Auth", "GoTrue health", `${supabaseUrl}/auth/v1/health`, { headers: { apikey: anon } }, (b) => (b ? `version=${b.version ?? "?"} name=${b.name ?? "?"}` : ""));
  await probe("T-SB-02", "Supabase Auth", "public auth settings (which sign-in methods are on)", `${supabaseUrl}/auth/v1/settings`, { headers: { apikey: anon } }, (b) =>
    b ? `signup_disabled=${b.disable_signup} email=${b.external?.email} phone=${b.external?.phone} oauth_on=${Object.entries(b.external ?? {}).filter(([k, v]) => v && !["email", "phone"].includes(k)).map(([k]) => k).join("|") || "none"} mfa_enabled=${b.mfa_enabled} mailer_autoconfirm=${b.mailer_autoconfirm}` : "",
  );
  await probe("T-SB-03", "Supabase Data API", "PostgREST answers the anon key (root, no table read)", `${supabaseUrl}/rest/v1/`, { headers: { apikey: anon } }, (b, r) => `content-type=${r.headers.get("content-type")} paths_exposed_to_anon=${b?.paths ? Object.keys(b.paths).length : "n/a"}`);
  await probe("T-SB-04", "Supabase Storage", "storage service status", `${supabaseUrl}/storage/v1/status`, { headers: { apikey: anon } }, (_b, _r, t) => t.slice(0, 60));
} else skip("T-SB-01", "Supabase", "connectivity", "URL or publishable key name missing in .env.local");

// ── Resend ──────────────────────────────────────────────────────────────────────────────────
if (has("RESEND_API_KEY")) {
  await probe("T-RS-01", "Resend", "list sending domains and their verification state (no send)", "https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } }, (b) =>
    Array.isArray(b?.data) ? `domains=${b.data.length} states=${b.data.map((d) => `${d.name}:${d.status}:${d.region}`).join(",")}` : `message=${b?.message ?? b?.name ?? ""}`.slice(0, 140),
  );
} else skip("T-RS-01", "Resend", "domains", "RESEND_API_KEY not in .env.local");

// ── Telegram ────────────────────────────────────────────────────────────────────────────────
if (has("TELEGRAM_BOT_TOKEN")) {
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  await probe("T-TG-01", "Telegram Bot API", "getMe (identity only, no message)", `${base}/getMe`, {}, (b) => `ok=${b?.ok} is_bot=${b?.result?.is_bot} can_join_groups=${b?.result?.can_join_groups}`);
  await probe("T-TG-02", "Telegram Bot API", "getWebhookInfo (is an inbound webhook registered, and is it failing)", `${base}/getWebhookInfo`, {}, (b) => {
    const r = b?.result ?? {};
    let host = "";
    try {
      host = r.url ? new URL(r.url).host + new URL(r.url).pathname : "(none)";
    } catch {
      host = "(unparseable)";
    }
    return `webhook=${host} pending_updates=${r.pending_update_count} last_error_date=${r.last_error_date ? new Date(r.last_error_date * 1000).toISOString() : "none"} last_error=${(r.last_error_message ?? "none").slice(0, 60)} max_connections=${r.max_connections ?? "?"} has_secret=${"n/a (API does not report it)"}`;
  });
} else skip("T-TG-01", "Telegram", "getMe", "TELEGRAM_BOT_TOKEN not in .env.local");

// ── OpenAI / Anthropic (model listing is free and read-only) ────────────────────────────────
if (has("OPENAI_API_KEY")) {
  await probe("T-AI-01", "OpenAI", "list models (free, read-only)", "https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }, (b) => (Array.isArray(b?.data) ? `models_visible=${b.data.length}` : `error=${b?.error?.code ?? b?.error?.type ?? ""}`));
} else skip("T-AI-01", "OpenAI", "models", "OPENAI_API_KEY not in .env.local");
if (has("ANTHROPIC_API_KEY")) {
  await probe("T-AI-02", "Anthropic", "list models (free, read-only)", "https://api.anthropic.com/v1/models", { headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } }, (b) => (Array.isArray(b?.data) ? `models_visible=${b.data.length}` : `error=${b?.error?.type ?? ""}`));
} else skip("T-AI-02", "Anthropic", "models", "ANTHROPIC_API_KEY not in .env.local");

// ── Sentry ──────────────────────────────────────────────────────────────────────────────────
if (has("SENTRY_AUTH_TOKEN")) {
  await probe("T-SE-01", "Sentry", "token is accepted; organizations and projects visible to it", "https://sentry.io/api/0/projects/", { headers: { Authorization: `Bearer ${env.SENTRY_AUTH_TOKEN}` } }, (b) =>
    Array.isArray(b) ? `projects=${b.length} platforms=${[...new Set(b.map((p) => p.platform))].join("|")} orgs=${new Set(b.map((p) => p.organization?.slug)).size}` : `detail=${(b?.detail ?? "").slice(0, 100)}`,
  );
} else skip("T-SE-01", "Sentry", "projects", "SENTRY_AUTH_TOKEN not in .env.local");
const dsn = env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  try {
    const parsed = new URL(dsn);
    results.push({ id: "T-SE-02", integration: "Sentry", objective: "DSN is well-formed and names an ingest host (no event sent)", at: new Date().toISOString(), http: "n/a", ms: 0, note: `ingest_host_suffix=${parsed.host.split(".").slice(-3).join(".")} project_id_present=${parsed.pathname.length > 1}` });
  } catch {
    results.push({ id: "T-SE-02", integration: "Sentry", objective: "DSN is well-formed", at: new Date().toISOString(), http: "n/a", ms: 0, note: "DSN did not parse as a URL" });
  }
}

// ── Healthchecks.io (management API, read-only listing — no ping) ───────────────────────────
if (has("HEALTHCHECKS_API_KEY")) {
  await probe("T-HC-01", "Healthchecks.io", "list checks with status, period and grace (no ping sent)", "https://healthchecks.io/api/v3/checks/", { headers: { "X-Api-Key": env.HEALTHCHECKS_API_KEY } }, (b) => {
    if (!Array.isArray(b?.checks)) return `error=${JSON.stringify(b ?? {}).slice(0, 120)}`;
    const byStatus = {};
    for (const check of b.checks) byStatus[check.status] = (byStatus[check.status] ?? 0) + 1;
    const lines = b.checks
      .map((c) => `${c.name || "(unnamed)"} [${c.status}] period=${c.timeout ?? "cron:" + (c.schedule ?? "?")}s grace=${c.grace}s last_ping=${c.last_ping ?? "never"} pings=${c.n_pings}`)
      .join(" ## ");
    return `checks=${b.checks.length} by_status=${JSON.stringify(byStatus)} :: ${lines}`;
  });
  await probe("T-HC-02", "Healthchecks.io", "list notification channels (kinds only)", "https://healthchecks.io/api/v3/channels/", { headers: { "X-Api-Key": env.HEALTHCHECKS_API_KEY } }, (b) => (Array.isArray(b?.channels) ? `channels=${b.channels.length} kinds=${b.channels.map((c) => c.kind).join("|")}` : `error=${JSON.stringify(b ?? {}).slice(0, 120)}`));
} else skip("T-HC-01", "Healthchecks.io", "checks", "HEALTHCHECKS_API_KEY not in .env.local");

// ── cron-job.org (read-only job listing) ────────────────────────────────────────────────────
if (has("CRONJOB_API_KEY")) {
  await probe("T-CJ-01", "cron-job.org", "list jobs with enabled flag, last status and schedule", "https://api.cron-job.org/jobs", { headers: { Authorization: `Bearer ${env.CRONJOB_API_KEY}` } }, (b) => {
    if (!Array.isArray(b?.jobs)) return `error=${JSON.stringify(b ?? {}).slice(0, 120)}`;
    const statusName = { 0: "unknown", 1: "ok", 2: "dns", 3: "connect", 4: "http", 5: "timeout", 6: "too-much-data", 7: "bad-url", 8: "internal", 9: "unknown-error" };
    const enabled = b.jobs.filter((j) => j.enabled).length;
    const lastBad = b.jobs.filter((j) => j.enabled && j.lastStatus !== 1);
    const lines = b.jobs
      .map((j) => {
        let path = "";
        try {
          const u = new URL(j.url);
          path = u.host + u.pathname;
        } catch {
          path = "(unparseable)";
        }
        const s = j.schedule ?? {};
        const every = `m=${(s.minutes ?? []).join("/") || "*"} h=${(s.hours ?? []).join("/") || "*"} tz=${s.timezone ?? "?"}`;
        return `${j.title || "(untitled)"} | ${path} | enabled=${j.enabled} | last=${statusName[j.lastStatus] ?? j.lastStatus} ${j.lastDuration ?? "?"}ms | ${every} | timeout=${j.requestTimeout}s | saveResponses=${j.saveResponses}`;
      })
      .join(" ## ");
    return `jobs=${b.jobs.length} enabled=${enabled} enabled_with_last_run_not_ok=${lastBad.length} someFailed=${b.someFailed} :: ${lines}`;
  });
} else skip("T-CJ-01", "cron-job.org", "jobs", "CRONJOB_API_KEY not in .env.local");

// ── Cloudflare (token self-verification only) ───────────────────────────────────────────────
if (has("CLOUDFLARE_API_TOKEN")) {
  await probe("T-CF-01", "Cloudflare", "token verify (reads nothing but the token's own state)", "https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }, (b) => `success=${b?.success} status=${b?.result?.status ?? "?"} expires=${b?.result?.expires_on ?? "none"} errors=${(b?.errors ?? []).map((e) => e.code).join("|")}`);
} else skip("T-CF-01", "Cloudflare", "token", "CLOUDFLARE_API_TOKEN not in .env.local");

// ── Google Calendar (public holiday calendar; the Calendar API has no per-call charge) ──────
if (has("GOOGLE_CALENDAR_API_KEY") && has("GOOGLE_HOLIDAY_CALENDAR_ID_EG")) {
  const year = new Date().getUTCFullYear();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_HOLIDAY_CALENDAR_ID_EG)}/events?key=${env.GOOGLE_CALENDAR_API_KEY}&timeMin=${year}-01-01T00:00:00Z&timeMax=${year}-12-31T23:59:59Z&singleEvents=true&maxResults=250&fields=items(start)`;
  await probe("T-GC-01", "Google Calendar API", "read this year's public-holiday events (count only)", url, {}, (b) => (Array.isArray(b?.items) ? `holiday_events_this_year=${b.items.length}` : `error=${b?.error?.status ?? ""} ${String(b?.error?.message ?? "").slice(0, 90)}`));
} else skip("T-GC-01", "Google Calendar API", "holidays", "calendar key or id not in .env.local");

// ── Google Maps: deliberately NOT called (every Maps Platform request is metered) ───────────
skip("T-GM-01", "Google Maps Platform", "live request with the server or browser key", "NOT RUN on purpose — Maps Platform calls are metered/billable; key restrictions live in the Google Cloud console, which this audit cannot read");

// ── Reachability only, no credentials sent ──────────────────────────────────────────────────
if (has("IREPORTS360_BASE_URL")) {
  let origin = "";
  try {
    origin = new URL(env.IREPORTS360_BASE_URL).origin;
  } catch {
    origin = "";
  }
  if (origin) await probe("T-IR-01", "iReports360", "host reachable (no sign-in, no credentials sent)", origin, { method: "GET", redirect: "manual" }, (_b, r) => `server=${r.headers.get("server") ?? "?"} redirect=${r.status >= 300 && r.status < 400}`);
} else skip("T-IR-01", "iReports360", "reachability", "IREPORTS360_BASE_URL not in .env.local");
if (has("ACTION1_API_BASE_URL")) {
  let origin = "";
  try {
    origin = new URL(env.ACTION1_API_BASE_URL).origin;
  } catch {
    origin = "";
  }
  if (origin) await probe("T-A1-01", "Action1", "host reachable (no sign-in, no credentials sent)", origin, { method: "GET", redirect: "manual" }, (_b, r) => `server=${r.headers.get("server") ?? "?"}`);
} else skip("T-A1-01", "Action1", "reachability", "ACTION1_API_BASE_URL not in .env.local");

for (const r of results) console.log(`${r.id}\t${r.integration}\t${r.objective}\t${r.at}\thttp=${r.http}\t${r.ms}ms\t${r.note}`);
