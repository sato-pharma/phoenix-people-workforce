import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { purgeExpiredTabletRecordings, TABLET_RECORDING_RETENTION_DAYS } from "../src/lib/devices/headwind/recordings.ts";
import { sentFiguresClearedPayload } from "../src/lib/notifications/sent-figures.ts";

// REC-059. Two stated periods, each enforced by code (owner, 2026-11-13): an email's figures leave
// the outbox the moment it is marked sent, and a tablet screen recording is kept 90 days.

const SUPABASE = "https://retention-check.invalid";
const STAND_IN_SETTINGS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
};

type Seen = { body: string; method: string; path: string; search: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function withStandIn(
  options: { rows: Array<{ id: string; storage_path: string | null }>; storageFails?: boolean },
  run: (seen: Seen[]) => Promise<void>,
) {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.keys(STAND_IN_SETTINGS).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const seen: Seen[] = [];
  Object.assign(env, STAND_IN_SETTINGS);
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : request ? await request.clone().text() : "";
    seen.push({ body, method, path: url.pathname, search: url.search });
    if (url.pathname === "/rest/v1/device_screen_recordings" && method === "GET") return json(200, options.rows);
    if (url.pathname === "/rest/v1/device_screen_recordings" && method === "DELETE") {
      return json(200, options.rows.map((row) => ({ id: row.id })));
    }
    if (url.pathname.startsWith("/storage/v1/object/device-screen-recordings") && method === "DELETE") {
      if (options.storageFails) return json(500, { error: "stand-in", message: "stand-in storage failure", statusCode: "500" });
      const prefixes = (JSON.parse(body || "{}") as { prefixes?: string[] }).prefixes ?? [];
      return json(200, prefixes.map((name) => ({ name })));
    }
    throw new Error(`the stand-in refuses ${method} ${url.pathname}`);
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

export async function runRetentionSentFiguresAndRecordingsTests() {
  // ── 1. A sent email keeps no figures ─────────────────────────────────────────────────────────
  const payload = {
    metrics: [
      { label: "Employee", value: "Stand In (T-1)" },
      { label: "Net salary", value: 12345 },
      { label: "Score", value: "87%" },
    ],
    notificationType: "payroll",
    planTableHtml: "<table><tr><td>row</td></tr></table>",
    planTableText: "row",
    recipients: ["someone@example.invalid"],
    subject: "Your payslip",
    summary: "Your payslip is ready.",
    templateContext: { netSalary: "12,345" },
    title: "Payslip",
  };
  const cleared = sentFiguresClearedPayload(payload);
  assert.ok(cleared, "HEADLINE: a sent email carrying figures is rewritten");
  assert.deepEqual(cleared!.metrics, [{ label: "Employee", value: "Stand In (T-1)" }], "only the Employee name survives in metrics");
  assert.equal(cleared!.templateContext, undefined, "the template context (financials, scores) is gone");
  assert.equal(cleared!.planTableHtml, undefined, "the plan table is gone");
  assert.equal(cleared!.planTableText, undefined, "the plan table text is gone");
  assert.equal(cleared!.figuresCleared, true, "the row says its figures were cleared");
  for (const kept of ["subject", "title", "summary", "recipients", "notificationType"] as const) {
    assert.deepEqual(cleared![kept], payload[kept], `${kept} stays — Email Activity and the outbox stats read it`);
  }
  assert.equal(JSON.stringify(cleared).includes("12345") || JSON.stringify(cleared).includes("12,345"), false, "no figure text survives anywhere");
  assert.equal(sentFiguresClearedPayload({ metrics: [], subject: "x", title: "y" }), null, "an email with no figures is not rewritten");
  assert.equal(
    sentFiguresClearedPayload({ metrics: [{ label: "Employee", value: "A (B-1)" }] }),
    null,
    "an email whose only metric is the name is not rewritten",
  );

  // The outbox applies it when — and only when — a row is marked SENT, after the credential seal.
  const email = readFileSync("src/lib/notifications/email.ts", "utf8");
  const sentStart = email.indexOf("async function markNotificationOutboxSent");
  const sentBody = email.slice(sentStart, email.indexOf("\n}\n", sentStart));
  assert.match(sentBody, /\.\.\.sentRowPayload\(row\.payload\)/, "markNotificationOutboxSent clears the figures");
  const helper = email.slice(email.indexOf("function sentRowPayload"), email.indexOf("async function markNotificationOutboxSent"));
  assert.match(helper, /redactedCredentialPayload\(payload\) \?\? payload/, "the credential redaction still runs first");
  assert.equal((email.match(/sentRowPayload\(/g) ?? []).length, 2, "defined once and used once — a failed or skipped row keeps its figures");

  // ── 2. Recordings are kept 90 days: the file, then the row ─────────────────────────────────────
  assert.equal(TABLET_RECORDING_RETENTION_DAYS, 90, "the owner's period");
  const now = Date.UTC(2026, 10, 13, 6, 0, 0);
  const rows = [
    { id: "11111111-1111-4111-8111-111111111111", storage_path: "PHX-TAB-0001/11111111-1111-4111-8111-111111111111.mp4" },
    { id: "22222222-2222-4222-8222-222222222222", storage_path: "PHX-TAB-0002/22222222-2222-4222-8222-222222222222.mp4" },
  ];
  await withStandIn({ rows }, async (seen) => {
    const result = await purgeExpiredTabletRecordings(undefined, now);
    assert.equal(result.cutoffIso, "2026-08-15T06:00:00.000Z", "the cutoff is exactly 90 days back");
    const read = seen.find((entry) => entry.method === "GET");
    assert.ok(read && decodeURIComponent(read.search).includes("requested_at=lt.2026-08-15T06:00:00.000Z"), "only rows older than the cutoff are read");
    const fileAt = seen.findIndex((entry) => entry.path.startsWith("/storage/") && entry.method === "DELETE");
    const rowAt = seen.findIndex((entry) => entry.path === "/rest/v1/device_screen_recordings" && entry.method === "DELETE");
    assert.ok(fileAt >= 0 && rowAt > fileAt, "HEADLINE: the file is removed before its row");
    assert.deepEqual(JSON.parse(seen[fileAt].body).prefixes, rows.map((row) => row.storage_path), "each expired file is named");
    assert.deepEqual({ expired: result.expired, filesRemoved: result.filesRemoved, rowsDeleted: result.rowsDeleted }, { expired: 2, filesRemoved: 2, rowsDeleted: 2 }, "the run reports what it removed");
  });

  // A failed file removal keeps every row, so no file is left without the record naming it.
  await withStandIn({ rows, storageFails: true }, async (seen) => {
    const result = await purgeExpiredTabletRecordings(undefined, now);
    assert.equal(seen.some((entry) => entry.path === "/rest/v1/device_screen_recordings" && entry.method === "DELETE"), false, "no row is deleted when its file could not be");
    assert.equal(result.rowsDeleted, 0);
    assert.match(result.error ?? "", /could not be removed/);
  });

  // Nothing old, nothing touched.
  await withStandIn({ rows: [] }, async (seen) => {
    const result = await purgeExpiredTabletRecordings(undefined, now);
    assert.equal(seen.filter((entry) => entry.method !== "GET").length, 0, "an empty pass deletes nothing");
    assert.equal(result.expired, 0);
  });

  // The morning job calls it, with its own catch, and its answer names the result.
  const daily = readFileSync("app/api/cron/daily/_lib/daily-job-runners.ts", "utf8");
  assert.match(daily, /purgeExpiredTabletRecordings\(\)\.catch\(\s*onJobFailure\("tablet-recording-retention"/, "the daily run purges recordings");
  assert.match(daily, /"tablet-recording-retention": \{\s*resultName: "tabletRecordingRetention",/, "and its answer carries the result");
}
