// scripts/lib/post-deploy-errors.mjs
// ---------------------------------------------------------------------------
// WHAT A DEPLOY BROKE, READ FROM THE TWO PLACES THAT RECORD IT. The pure half of
// scripts/post-deploy-errors.mjs, which the ship skill runs once verify-shipped.mjs answers SHIPPED.
//
// THE APP'S OWN ERROR TABLE IS THE SOURCE THAT ALWAYS ANSWERS. `app_error_events` records every server
// error and every browser error the app sees, each stamped with the commit it came from (`release`, the same
// sha Sentry names its release after). So "what is new since this deploy" is the error signatures seen in the
// releases that carry the merge, minus every signature the other releases produced in the week before. Sentry
// is the second sink beside that table, never instead of it (docs/observability.md, "Sentry"), so it is read
// too WHEN a token that can read it exists, and the report says plainly when it was not read. An unread Sentry
// is never a pass about Sentry.
//
// 🔴 SENTRY_AUTH_TOKEN IS NOT A READ TOKEN. The production one is the build plugin's organisation token
// (releases and source maps only). The copy in the laptop's .env.local was, on 2026-10-19, still the RETIRED
// account's (organisation sato-pharma) and answered 403 to every read of phoenix-crm. The read uses
// SENTRY_READ_TOKEN (a Windows user variable on the laptop since 2026-10-19), a personal token that can read
// phoenix-crm's events.
//
// Everything here is a pure function or takes its `fetch` as an argument, so tests/post-deploy-errors.test.ts
// drives it with no network. Nothing here reads process.argv (refuse-arguments.mjs: never from a library).
// ---------------------------------------------------------------------------

export const SENTRY_API_BASE = "https://de.sentry.io/api/0";
// The organisation next.config.ts uploads releases to (withSentryConfig({ org })).
export const SENTRY_ORG_SLUG = "phoenix-crm";
export const DEFAULT_WINDOW_MINUTES = 15;
export const BASELINE_DAYS = 7;
export const ROW_FIELDS = "created_at,source,route,module_label,message,digest,release";

export const EXIT = Object.freeze({ CLEAN: 0, NEW: 1, TOO_EARLY: 2, NOT_LIVE: 3, NOT_MERGED: 4, CANNOT_TELL: 5 });

// Next replaces a server render error's message with this fixed sentence in production and keeps only a digest.
const NEXT_RENDER_MESSAGE = "An error occurred in the Server Components render";
const SHOWN_MESSAGE_CHARS = 400;

/**
 * The error itself, out of the shapes logAppError stores. A PostgREST failure lands as a JSON object string
 * whose `message` is the error and whose `details` carries a minified function name that changes with every
 * build ("at k (/app/.next/…" one release, "at p (…" the next), so the object as a whole is never the signature.
 */
export function innerMessage(message) {
  const text = String(message ?? "").trim();
  if (!text.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.message === "string") return parsed.message.trim();
  } catch {
    // A stored object can be cut short; its opening "message" field still names the error.
  }
  const opening = text.match(/^\{\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!opening) return text;
  try {
    return JSON.parse(`"${opening[1]}"`).trim();
  } catch {
    return opening[1].trim();
  }
}

export function firstLine(message) {
  return innerMessage(message).split(/\r?\n/)[0].trim();
}

/**
 * One error, whatever ids, timings and hashes it happened to carry this time. A React error code (#418, #441)
 * is kept: each number is a different error.
 */
export function normalizeMessage(message) {
  return firstLine(message)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ":email")
    .replace(/(https?:\/\/[^\s?#"]+)[?#][^\s"]*/g, "$1")
    .replace(/\/_next\/static\/\S+/g, "/_next/static/:asset")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ":uuid")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, ":hex")
    .replace(/(^|[^#\w])\d+(?:\.\d+)?/g, "$1:n")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export function errorSignature(row) {
  const message = normalizeMessage(row.message);
  // For Next's fixed render sentence the digest is the only thing that tells two different errors apart.
  const digest = message.startsWith(NEXT_RENDER_MESSAGE) && row.digest ? ` [digest ${row.digest}]` : "";
  return `${row.source || "unknown"} · ${message}${digest}`;
}

/**
 * Rows the repo already decided say nothing about Phoenix, using the repo's OWN classifiers (passed in, so this
 * file stays import-free of src/): a browser's network-failure wording on a browser row (browser-noise.ts), and a
 * locked module's refusal (expected-refusal.ts). Sentry skips both; the error table records both.
 */
export function noiseReason(row, classifiers) {
  if (!classifiers) return null;
  const text = firstLine(row.message);
  if (row.source === "client" && classifiers.isBrowserNoiseMessage(text)) return "browser network failure";
  if (classifiers.isModuleLockRefusal({ message: text })) return "locked module refusal";
  return null;
}

/**
 * Split the examined releases' errors into the ones the week before never produced (`fresh`) and the ones it
 * did (`recurring`). A signature is "known" if ANY row outside the examined releases carried it, so an error
 * that was already happening before the merge never reads as the merge's doing.
 */
export function classifyErrors({ examined, baseline, classifiers }) {
  const known = new Set();
  for (const row of baseline) {
    if (!noiseReason(row, classifiers)) known.add(errorSignature(row));
  }
  const groups = new Map();
  let noise = 0;
  for (const row of examined) {
    if (noiseReason(row, classifiers)) {
      noise += 1;
      continue;
    }
    const signature = errorSignature(row);
    let group = groups.get(signature);
    if (!group) {
      group = {
        signature,
        source: row.source || "unknown",
        message: firstLine(row.message).slice(0, SHOWN_MESSAGE_CHARS),
        count: 0,
        routes: new Set(),
        modules: new Set(),
        releases: new Set(),
        firstAt: row.created_at,
        lastAt: row.created_at,
        isNew: !known.has(signature),
      };
      groups.set(signature, group);
    }
    group.count += 1;
    if (row.route) group.routes.add(row.route);
    if (row.module_label) group.modules.add(row.module_label);
    if (row.release) group.releases.add(row.release);
    if (row.created_at < group.firstAt) group.firstAt = row.created_at;
    if (row.created_at > group.lastAt) group.lastAt = row.created_at;
  }
  const list = [...groups.values()]
    .map((group) => ({
      ...group,
      routes: [...group.routes].sort(),
      modules: [...group.modules].sort(),
      releases: [...group.releases].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  return { fresh: list.filter((g) => g.isNew), recurring: list.filter((g) => !g.isNew), noise };
}

/** The PostgREST filters: the examined releases' rows, and every other row of the baseline week. */
export function errorRowFilters({ releases, baselineSince }) {
  const list = `(${releases.join(",")})`;
  return {
    examined: [
      ["environment", "eq.production"],
      ["release", `in.${list}`],
    ],
    baseline: [
      ["environment", "eq.production"],
      ["created_at", `gte.${baselineSince}`],
      ["or", `(release.is.null,release.not.in.${list})`],
    ],
  };
}

function totalFromContentRange(header) {
  const match = String(header ?? "").match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

/**
 * Every row matching `filters`, page by page. 🔴 Paged by the server's own TOTAL (`Prefer: count=exact`), never by
 * "a short page means the end": Supabase caps a response at its max-rows setting, which can be BELOW the page size
 * asked for, and a reader that stops at the first short page would judge on a partial read without knowing it.
 */
export async function readErrorRows({ supabaseUrl, serviceKey, filters, fetchImpl = fetch, pageSize = 1000, maxRows = 20000 }) {
  const rows = [];
  let total = null;
  while (rows.length < maxRows) {
    const params = new URLSearchParams([...filters, ["select", ROW_FIELDS], ["order", "created_at.asc"]]);
    params.set("limit", String(pageSize));
    params.set("offset", String(rows.length));
    const res = await fetchImpl(`${supabaseUrl}/rest/v1/app_error_events?${params}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "count=exact" },
    });
    if (!res.ok) throw new Error(`the app_error_events read answered HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error("the app_error_events read did not return a list");
    total = totalFromContentRange(res.headers.get("content-range")) ?? total;
    rows.push(...page);
    if (page.length === 0) break;
    if (total !== null ? rows.length >= total : page.length < pageSize) break;
  }
  if (total !== null && rows.length < total) {
    throw new Error(`the app_error_events read stopped at ${rows.length} of ${total} rows, refusing to judge on a partial read`);
  }
  return rows;
}

/**
 * Sentry's Discover reads, the two this check needs. 🔴 Discover, not the issue list: the read token's
 * `organizations/<org>/issues/` and `projects/<org>/<project>/issues/` both answered 403 on 2026-10-19 while
 * `organizations/<org>/events/` answered 200, so the issue list is not something this check can lean on.
 *   examined: every issue with an event in a release that carries the merge (transactions excluded).
 *   baseline: which of THOSE issues also had an event in any other release over the baseline week.
 * An issue in the first and not the second is new with these releases: the same rule the error table uses.
 */
export function sentryEventParams({ releases, issueIds = null }) {
  const fields = ["issue", "title", "level", "count()", "count_unique(user)", "min(timestamp)", "max(timestamp)"];
  const list = `[${releases.join(",")}]`;
  const query = issueIds
    ? `issue:[${issueIds.join(",")}] !release:${list} !event.type:transaction`
    : `release:${list} !event.type:transaction`;
  return new URLSearchParams([
    ...fields.map((field) => ["field", field]),
    ["query", query],
    ["statsPeriod", issueIds ? `${BASELINE_DAYS}d` : "14d"],
    ["sort", "-count()"],
    ["per_page", "100"],
  ]);
}

export async function readSentryIssues({ token, releases, fetchImpl = fetch, base = SENTRY_API_BASE, org = SENTRY_ORG_SLUG }) {
  if (!token) return { read: false, reason: "no SENTRY_READ_TOKEN, so Sentry was NOT read" };
  async function discover(params, what) {
    let res;
    try {
      res = await fetchImpl(`${base}/organizations/${org}/events/?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      return { failed: `Sentry did not answer the ${what} read (${error instanceof Error ? error.message : String(error)})` };
    }
    if (!res.ok) {
      const refused = res.status === 401 || res.status === 403 ? `: the token cannot read events in ${org}` : "";
      return { failed: `Sentry answered HTTP ${res.status} to the ${what} read${refused}` };
    }
    const body = await res.json();
    return { rows: Array.isArray(body?.data) ? body.data : [] };
  }
  const examined = await discover(sentryEventParams({ releases }), "release");
  if (examined.failed) return { read: false, reason: examined.failed };
  const issues = examined.rows
    .filter((row) => row.issue)
    .map((row) => ({
      shortId: String(row.issue),
      issueId: row["issue.id"] ?? null,
      title: String(row.title ?? "").slice(0, SHOWN_MESSAGE_CHARS),
      level: row.level ?? null,
      count: Number(row["count()"]) || 0,
      users: Number(row["count_unique(user)"]) || 0,
      firstSeen: row["min(timestamp)"] ?? null,
      lastSeen: row["max(timestamp)"] ?? null,
      link: row["issue.id"] ? `https://${org}.sentry.io/issues/${row["issue.id"]}/` : null,
    }));
  if (issues.length === 0) return { read: true, fresh: [], recurring: [], capped: false };
  const baseline = await discover(sentryEventParams({ releases, issueIds: issues.map((i) => i.shortId) }), "baseline");
  if (baseline.failed) return { read: false, reason: baseline.failed };
  const known = new Set(baseline.rows.map((row) => String(row.issue)));
  return {
    read: true,
    fresh: issues.filter((i) => !known.has(i.shortId)),
    recurring: issues.filter((i) => known.has(i.shortId)),
    capped: examined.rows.length >= 100,
  };
}

/**
 * The earliest moment a release carrying the merge is KNOWN to have served production: the first `success` status of
 * its production deployment, or the first reading of this run that saw production serving it (`observedServingAt`).
 * Both can only trail the real serving moment (the status once by 17 minutes,
 * `a-slow-railway-day-is-measured-from-the-build-log-not-the-github-status`), so the window can only close late,
 * never early.
 *
 * The observation is there because Railway does not always post a `success`. #6432's merge (24 Oct 2026) got one
 * production row, `failure` at 17:49:33 Cairo, and production served that very commit from 17:50:03: a CARRIED row
 * (AGENTS.md 2.3). With success rows alone there was no go-live time, and the whole 30-minute watch read CANNOT TELL.
 * A failure row's own time is NOT used: it landed 30 s BEFORE the container went live, and a real failure later
 * carried by another deploy would date the merge from a moment nothing of it was serving.
 *
 * @param {Array<{ environment?: unknown, statuses?: Array<{ state?: string, created_at?: string }> }>} deploymentsWithStatuses
 * @param {string | null} [observedServingAt]
 * @returns {string | null}
 */
export function goLiveFrom(deploymentsWithStatuses, observedServingAt = null) {
  let earliest = observedServingAt ?? null;
  for (const { environment, statuses } of deploymentsWithStatuses) {
    if (!/production/i.test(String(environment ?? "")) || /staging/i.test(String(environment ?? ""))) continue;
    for (const status of statuses ?? []) {
      if (status.state !== "success" || !status.created_at) continue;
      if (earliest === null || status.created_at < earliest) earliest = status.created_at;
    }
  }
  return earliest;
}

/** True when some production deployment of these releases posted a `success`, so the go-live time is Railway's. */
export function hasProductionSuccess(deploymentsWithStatuses) {
  return deploymentsWithStatuses.some(
    ({ environment, statuses }) =>
      /production/i.test(String(environment ?? "")) &&
      !/staging/i.test(String(environment ?? "")) &&
      (statuses ?? []).some((status) => status.state === "success" && status.created_at),
  );
}

/**
 * The defaults below would otherwise be read as the TYPES (`fresh` as never[], `liveMinutes` as null) by a TypeScript
 * caller, since the repo compiles this file with allowJs; this says what each field really holds.
 * @param {{
 *   merged?: boolean,
 *   live?: boolean,
 *   appRead?: boolean,
 *   fresh?: unknown[],
 *   sentry?: { read: boolean, reason?: string, fresh?: unknown[] },
 *   liveMinutes?: number | null,
 *   windowMinutes?: number,
 * }} reading
 * @returns {{ code: number, label: string, note: string }}
 */
export function postDeployVerdict({ merged = true, live = true, appRead = true, fresh = [], sentry = { read: false }, liveMinutes = null, windowMinutes = DEFAULT_WINDOW_MINUTES }) {
  if (!merged) return { code: EXIT.NOT_MERGED, label: "NOT MERGED", note: "the PR is not merged, so nothing of it can be serving" };
  if (!live) return { code: EXIT.NOT_LIVE, label: "NOT LIVE", note: "production is not serving this merge yet; verify-shipped.mjs answers that" };
  const sentryNew = sentry.read ? sentry.fresh.length : 0;
  if (fresh.length || sentryNew) {
    const parts = [];
    if (fresh.length) parts.push(`${fresh.length} new in the app's error table`);
    if (sentryNew) parts.push(`${sentryNew} new in Sentry`);
    return { code: EXIT.NEW, label: "NEW ERRORS", note: `${parts.join(", ")} since the merge went live` };
  }
  if (!appRead) return { code: EXIT.CANNOT_TELL, label: "CANNOT TELL", note: "the app's error table could not be read" };
  if (liveMinutes === null) return { code: EXIT.CANNOT_TELL, label: "CANNOT TELL", note: "no production go-live time was found for the releases carrying the merge" };
  if (liveMinutes < windowMinutes) {
    return { code: EXIT.TOO_EARLY, label: "TOO EARLY", note: `serving ${liveMinutes} of the ${windowMinutes} minutes the window needs, nothing new so far, NOT a pass` };
  }
  const sentryPart = sentry.read ? "or in Sentry" : `(Sentry not read: ${sentry.reason})`;
  return { code: EXIT.CLEAN, label: "CLEAN", note: `no new error in the app's error table ${sentryPart} after ${liveMinutes} minutes serving` };
}
