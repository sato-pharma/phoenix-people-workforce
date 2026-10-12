import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { deviceInstallId } from "../src/lib/phoenix-crm/device-install.ts";
import { parseCapturedFix, parseDeviceInstallId } from "../src/lib/phoenix-crm/entry-rules.ts";
import { fixAgeSeconds } from "../src/lib/phoenix-crm/server/capture-provenance.ts";

/**
 * Phoenix CRM — the two things a one-tap visit knew and threw away (gaps 1 and 3 of the second-pass
 * audit, 2026-10-12).
 *
 * ## 1 · WHEN the phone took the position
 *
 * `use-silent-fix.ts` has always read `position.timestamp` — the instant the PHONE took the reading —
 * and dropped it on the floor. What the visit stored was `captured_at`, the moment the tap reached the
 * server, and module memory is explicit that `captured_at` must not be read as a position in time. The
 * two are genuinely different: the hook keeps the sharpest reading it has seen and replaces it only
 * with a sharper one or once it is 15 seconds old, so a form left open sends a reading older than the
 * tap.
 *
 * 🔴 THE AGE IS MEASURED PHONE-CLOCK TO PHONE-CLOCK, which is the whole reason it is trustworthy: the
 * reading's own stamp and the tap's own stamp come from the same handset, so a phone whose clock is an
 * hour out still reports the age correctly. That is pinned below, because it is the property somebody
 * "simplifying" this against the server's clock would destroy without any test going red.
 *
 * ## 2 · WHICH install sent it
 *
 * Nothing on a capture named the device, so "two reps saving from one phone" was unanswerable. The
 * answer is a random id a browser keeps in its own storage — a BROWSER INSTALL, never a person and
 * never a handset. 🔴 NOT A PACKAGE OR APK SCAN, which the owner forbids by name, and nothing here
 * reads one.
 *
 * ## What makes all of it safe
 *
 * GOLDEN RULE #1's blind half: both facts are written AFTER the save, by a function that returns
 * nothing and swallows its own failures, into a table no rep-facing surface reads (the registries in
 * `phoenix-crm-blind-half.test.ts` are what hold that). Nothing here refuses a visit, flags one, or
 * puts a word in front of a rep — a browser with storage switched off saves exactly as it always did.
 */

const MIGRATION = "supabase/migrations/20261012233000_phoenix_crm_visit_capture_provenance.sql";
const TABLE = "phoenix_crm_visit_capture_provenance";

function source(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** A localStorage stand-in, so the browser half is EXERCISED rather than grepped. */
function fakeStore(options: { throws?: boolean } = {}) {
  const held = new Map<string, string>();
  return {
    held,
    getItem: (key: string) => {
      if (options.throws) throw new Error("site data is blocked");
      return held.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.throws) throw new Error("site data is blocked");
      held.set(key, value);
    },
  };
}

function withStore<T>(store: unknown, run: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = store;
  try {
    return run();
  } finally {
    if (had) (globalThis as { localStorage?: unknown }).localStorage = previous;
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

export function runPhoenixCrmCaptureProvenanceTests(): void {
  // ── 1 · The age of the reading, measured on one clock ──────────────────────────────────────────
  // 🔴 THE LOAD-BEARING ONE, AND IT GOES FIRST so that a break of this arithmetic is answered by the
  // assertion that explains it. Both stamps come from the same handset, so a clock an hour out
  // reports the same age; anchored to the SERVER's clock this reading would have looked an hour old.
  assert.equal(
    fixAgeSeconds("2026-10-12T16:00:00Z", "2026-10-12T16:00:09Z"),
    9,
    "a phone whose clock is an hour wrong still reports the reading's age correctly — the error is in both terms and cancels",
  );
  assert.equal(fixAgeSeconds("2026-10-12T15:00:00Z", "2026-10-12T15:00:09Z"), 9, "nine seconds between the reading and the tap");
  assert.equal(fixAgeSeconds("2026-10-12T15:00:00Z", "2026-10-12T15:00:00Z"), 0, "a reading taken at the tap is 0, which is why NULL may never be read as 0");

  // A reading stamped AFTER the tap measures nothing, so it is NOT MEASURED rather than a clamped 0
  // that would read as a perfect capture. The raw instant is stored beside it either way.
  assert.equal(fixAgeSeconds("2026-10-12T15:00:09Z", "2026-10-12T15:00:00Z"), null, "a negative age is not a measurement");
  for (const [taken, tapped] of [
    [null, "2026-10-12T15:00:09Z"],
    ["2026-10-12T15:00:00Z", null],
    ["this morning", "2026-10-12T15:00:09Z"],
    ["", ""],
  ] as Array<[string | null, string | null]>) {
    assert.equal(fixAgeSeconds(taken, tapped), null, `(${String(taken)}, ${String(tapped)}) is NOT MEASURED`);
  }

  // ── 2 · The fix time travels, read through the same guard as the tap's own stamp ───────────────
  const fix = parseCapturedFix({ lat: 30.05, lon: 31.23, deviceCapturedAt: "2026-10-12T15:00:09Z", fixTakenAt: "2026-10-12T15:00:00Z" });
  if (!fix.ok) throw new Error("a visit's fix must still parse");
  assert.equal(fix.value.fixTakenAt, "2026-10-12T15:00:00Z", "parseCapturedFix carries the phone's own reading time");
  assert.equal(fixAgeSeconds(fix.value.fixTakenAt, fix.value.deviceCapturedAt), 9, "and the pair measures the age the server files");

  const hook = source("src/components/phoenix-crm/use-silent-fix.ts");
  assert.match(
    stripComments(hook),
    /fixTakenAt: takenAt !== null && !Number\.isNaN\(takenAt\.getTime\(\)\) \? takenAt\.toISOString\(\) : null,/,
    "the hook sends the reading's own time, and a reading with no usable clock sends none rather than throwing",
  );
  assert.match(stripComments(hook), /const takenAt = Number\.isFinite\(fix\.at\) \? new Date\(fix\.at\) : null;/, "it is fix.at — position.timestamp — never the tap");

  // ── 3 · The install id: a browser install, nothing more ───────────────────────────────────────
  const id = withStore(fakeStore(), () => deviceInstallId());
  assert.ok(id, "a browser with storage gets an id");
  assert.equal(parseDeviceInstallId(id), id, "and the server's own guard accepts exactly what the browser writes — the two ends agree");

  const store = fakeStore();
  const first = withStore(store, () => deviceInstallId());
  const second = withStore(store, () => deviceInstallId());
  assert.equal(second, first, "the same install answers the same id, which is the only reason it can corroborate anything");
  assert.equal(store.held.size, 1, "one key, written once");

  // 🔴 SILENT AND UNABLE TO REFUSE A VISIT. Storage blocked, a private window, a quota error: null.
  assert.equal(withStore(fakeStore({ throws: true }), () => deviceInstallId()), null, "a browser that refuses storage still saves its visit");
  assert.equal(withStore(undefined, () => deviceInstallId()), null, "and so does one with no storage at all");

  for (const junk of ["Ahmed's phone", "", "   ", "not-a-uuid", "x".repeat(400), 12, null, undefined, {}]) {
    assert.equal(parseDeviceInstallId(junk), null, `${JSON.stringify(junk) ?? String(junk)} is not an install id`);
  }
  assert.equal(parseDeviceInstallId(" 7F3A9B21-4C5D-4E6F-8A9B-0C1D2E3F4A5B "), "7f3a9b21-4c5d-4e6f-8a9b-0c1d2e3f4a5b", "padded and upper case is the same install");

  // 🔴 NOT A DEVICE SCAN (owner's rule, named in the module's memory). The client file reads one
  // random value out of its own storage and nothing else about the handset.
  const client = source("src/lib/phoenix-crm/device-install.ts");
  for (const forbidden of [/getInstalledRelatedApps/, /PackageManager/i, /\.apk\b/i, /navigator\.plugins/, /userAgentData/, /\bimei\b/i, /serialNumber/i]) {
    assert.doesNotMatch(stripComments(client), forbidden, `the install id must not read ${forbidden} — it names a browser install, never a device`);
  }

  // ── 4 · Written after the save, by a function that can never cost a rep his visit ─────────────
  const writer = source("src/lib/phoenix-crm/server/capture-provenance.ts");
  assert.match(writer, /export async function recordCaptureProvenance\([\s\S]*?\): Promise<void> \{\s*try \{/, "the writer answers nothing and wraps everything");
  assert.match(stripComments(writer), /\.upsert\(\s*\{[\s\S]*?\},\s*\{ onConflict: "visit_id" \},?\s*\)/, "a re-save upserts on the visit's own id rather than piling rows up");
  assert.doesNotMatch(stripComments(writer), /\bthrow\b/, "nothing here throws — it runs one line after a save that has already answered the rep");
  // The two facts a patched client could lie about are the two read on the SERVER.
  assert.match(stripComments(writer), /app_revision: getDeployRevision\(\),/, "the build is read from the running server");
  assert.match(stripComments(writer), /user_agent: await userAgent\(\),/, "and the user agent from the request's own headers");

  const visits = stripComments(source("src/lib/phoenix-crm/server/visits.ts"));
  const saveFrom = visits.indexOf("export async function saveVisit");
  assert.ok(saveFrom > 0, "saveVisit is still the one door");
  const calls = [...visits.matchAll(/recordCaptureProvenance\(\{/g)];
  assert.equal(calls.length, 1, "it is called once");
  assert.ok((calls[0].index ?? 0) > saveFrom, "and inside saveVisit — the provenance of a visit is written where the visit is");
  const judged = visits.indexOf("await judgeCapture({");
  assert.ok(judged > 0 && (calls[0].index ?? 0) > judged, "after the judgement, which is itself after the save");
  for (const field of ["fixTakenAt: visit.fixTakenAt,", "deviceCapturedAt: visit.deviceCapturedAt,", "deviceInstallId: visit.deviceInstallId,"]) {
    assert.ok(visits.includes(field), `the call passes ${field} — a field dropped here is a column that is always null`);
  }

  // ── 5 · The migration adds ONE table, locked, and re-emits no function ────────────────────────
  const sql = stripSqlComments(source(MIGRATION));
  assert.match(sql, new RegExp(`create table if not exists public\\.${TABLE} \\(`), "one new table");
  assert.doesNotMatch(sql, /create or replace function/, "🔴 phoenix_crm_save_visit is NOT re-emitted — a 300-line function is not put at risk for evidence the save never reads");
  assert.doesNotMatch(sql, /alter table public\.phoenix_crm_visits/, "and no column is added to the visit itself");
  assert.match(sql, /fix_age_seconds integer check \(fix_age_seconds is null or fix_age_seconds >= 0\)/, "the age is null or non-negative, never a negative that would read as a measurement");
  assert.match(sql, /visit_id uuid primary key/, "one row per visit");
  for (const statement of [
    `alter table public.${TABLE} enable row level security;`,
    `create policy ${TABLE}_service_role\n  on public.${TABLE} for all to service_role using (true) with check (true);`,
    `revoke all on table public.${TABLE} from public, anon, authenticated;`,
    `grant all on table public.${TABLE} to service_role;`,
  ]) {
    assert.ok(sql.includes(statement), `the table is locked to the service role — missing: ${statement.split("\n")[0]}`);
  }

  console.log("phoenix-crm capture provenance: OK");
}
