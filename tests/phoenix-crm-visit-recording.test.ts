import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeRecordingLength,
  describeRecordingSize,
  isVisitRecordingRefusal,
  recordingDownloadName,
  VISIT_RECORDING_MAX_BYTES,
  VISIT_RECORDING_MAX_SECONDS,
  VISIT_RECORDING_MIN_SECONDS,
  VISIT_RECORDING_REQUIRED_CODE,
  visitRecordingMicrophoneProblem,
} from "../src/lib/phoenix-crm/visit-recording-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the visit recording the Super Admin requires of the reps chosen on one page.
 *
 * Owner, 2026-10-16: "if i switch a toggle for a certain rep he is then required to be able to open a
 * voice recorder to be able to do any step in logging the visit … this only works to who the admin
 * choose not everyone". His answers the same day: no consent tick, doctor AND pharmacy visits, 30
 * seconds to 15 minutes, a blocked microphone blocks the visit, the Super Admin, the SFE managers and
 * the rep's own managers listen, and the Super Admin downloads and deletes at any time.
 *
 * What this pins, in the order a break would hurt:
 *   1. The SERVER refuses a chosen rep's visit with no recording — claimed BEFORE the save writes.
 *   2. Only the rep's own save is asked, and only a switched-on rep is ever shown the recorder.
 *   3. Who hears it: the Super Admin, an SFE manager, the territory's own chain — never the rep.
 *   4. Who manages it: the Super Admin alone, on the page, the routes and inside every service.
 *   5. The bounds, the wording, and the file name a download is saved under.
 */
function read(path: string): string {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

export function runPhoenixCrmVisitRecordingTests(): void {
  // ── 5. The bounds he gave, and the wording ─────────────────────────────────────────────────────
  assert.equal(VISIT_RECORDING_MIN_SECONDS, 30, "his answer 6: at least 30 seconds");
  assert.equal(VISIT_RECORDING_MAX_SECONDS, 15 * 60, "his answer 3: at most 15 minutes");
  assert.equal(VISIT_RECORDING_MAX_BYTES, 16 * 1024 * 1024, "the bucket's own limit");

  assert.equal(isVisitRecordingRefusal(VISIT_RECORDING_REQUIRED_CODE), true);
  for (const code of ["phoenix_crm_recording_used", "phoenix_crm_recording_expired", "phoenix_crm_recording_too_short", "phoenix_crm_recording_missing"]) {
    assert.equal(isVisitRecordingRefusal(code), true, `${code} puts the recorder back in front of the rep`);
  }
  assert.equal(isVisitRecordingRefusal("phoenix_crm_same_name"), false, "an unrelated refusal is not the recorder's");
  assert.equal(isVisitRecordingRefusal(null), false);

  assert.equal(describeRecordingLength(45), "45 s");
  assert.equal(describeRecordingLength(245), "4 min 05 s");
  assert.equal(describeRecordingLength(null), "Length not recorded", "an unknown length is said, never a zero");
  assert.equal(describeRecordingSize(2.4 * 1024 * 1024), "2.4 MB");
  assert.equal(describeRecordingSize(640 * 1024), "640 KB");
  assert.equal(describeRecordingSize(0), "Size not recorded");

  assert.equal(
    recordingDownloadName({ repName: "Aya Ibrahim", customerName: "د. أحمد / سمير", visitDate: "2026-10-16", extension: ".webm" }),
    "2026-10-16 - Aya Ibrahim - د. أحمد سمير.webm",
    "the rep, the customer and the day; a slash is dropped and the Arabic is kept",
  );
  assert.equal(
    recordingDownloadName({ repName: "", customerName: "", visitDate: "", extension: ".m4a" }),
    "visit recording.m4a",
    "nothing to name it by still gives a name",
  );

  const blocked = visitRecordingMicrophoneProblem("NotAllowedError", "{browser}");
  assert.match(blocked, /blocked for \{browser\}/, "the blocked sentence names the browser at the render");
  assert.match(blocked, /allow the microphone/, "his answer 5: the rep is shown how to allow it");
  assert.match(blocked, /can be logged once it is recorded/, "his answer 5: the visit waits for the recording");
  assert.match(visitRecordingMicrophoneProblem("NotFoundError", "{browser}"), /No microphone was found/);
  assert.match(visitRecordingMicrophoneProblem("NotReadableError", "{browser}"), /Another app is using the microphone/);

  // ── 1. The server refuses a chosen rep's visit with no recording, BEFORE the save writes ────────
  const visits = read("src/lib/phoenix-crm/server/visits.ts");
  const saveStart = visits.indexOf("export async function saveVisit(");
  assert.ok(saveStart > 0, "saveVisit is where the claim lives");
  const save = visits.slice(saveStart);
  const claimAt = save.indexOf("claimRequiredRecording(");
  const rpcAt = save.indexOf('"phoenix_crm_save_visit"');
  assert.ok(claimAt > 0, "saveVisit claims the recording");
  assert.ok(rpcAt > 0, "saveVisit calls the save function");
  assert.ok(claimAt < rpcAt, "the claim runs BEFORE the save writes anything, so the visit can never exist without it");
  assert.match(
    save.slice(Math.max(0, claimAt - 120), claimAt),
    /if \(enteredAs === "rep"\) \{\s*await $/,
    "only the rep's own save is asked — a manager's double visit and the Super Admin's entry never are",
  );

  const service = read("src/lib/phoenix-crm/server/visit-recordings.ts");
  const claimFn = service.slice(service.indexOf("export async function claimRequiredRecording("));
  assert.match(claimFn.slice(0, 1600), /isRecordingRequired\(/, "the claim asks the switch itself, never the screen");
  assert.match(claimFn.slice(0, 1600), /VISIT_RECORDING_REQUIRED_CODE/, "a switched-on rep with no recording is refused by name");
  assert.match(
    service,
    /export async function isRecordingRequired\([^)]*\)[^{]*\{[\s\S]{0,400}throwIfError\(error\)/,
    "a failed read of the switch THROWS — answering 'not required' would let the visit through unrecorded",
  );

  // ── 2. Only a switched-on rep is ever shown the recorder ──────────────────────────────────────
  assert.match(
    visits,
    /enteredAs === "rep" \? isRecordingRequired\(viewer\.hrId\) : Promise\.resolve\(false\)/,
    "the form asks the switch for the territory's own rep only",
  );
  const tab = read("src/components/phoenix-crm/visits-tab.tsx");
  assert.match(tab, /if \(loaded\.recordingRequired && !sent\.recording\) \{\s*return shell\(/, "Add visit opens with the recorder for a switched-on rep");
  assert.match(tab, /<VisitRecordingGate/, "the gate is the recorder screen");
  assert.match(tab, /recording=\{loaded\.recordingRequired \? sent\.recording : null\}/, "only a switched-on rep's form carries a recording");

  const form = read("src/components/phoenix-crm/visit-log-form.tsx");
  assert.match(form, /recordingPath: recording\?\.path \?\? null/, "the save carries the stored path");
  assert.match(form, /isVisitRecordingRefusal\(/, "a refused recording sends the rep back to the recorder");

  // ── 3. Who hears it ──────────────────────────────────────────────────────────────────────────
  // The whole body, so a third reader — the rep above all — cannot be added beside the two lines.
  assert.match(
    service,
    /export function hearsVisitRecording\(viewer: PhoenixCrmViewer, seat: OrgSeat\): boolean \{\s*if \(viewer\.isSuperAdmin \|\| viewer\.isSfeManager\) return true;\s*return managerChain\(viewer\.org, seat\.seatId\)\.some\(\(member\) => member\.hrId === viewer\.hrId\);\s*\}/,
    "his answer 4: the Super Admin, the SFE managers and the territory's own managers — and nobody else",
  );
  assert.match(visits, /hearsVisitRecording\(viewer, seat\) \? await loadRecordingSecondsByVisit\(/, "the day reads recordings only for a reader who may hear them");
  const sign = service.slice(service.indexOf("export async function signVisitRecording("));
  assert.match(sign.slice(0, 1600), /hearsVisitRecording\(/, "the play route asks the same question before signing");

  // ── 4. Who manages it: the Super Admin alone ──────────────────────────────────────────────────
  assert.match(
    service,
    /export function canManageVisitRecording\(viewer: PhoenixCrmViewer\): boolean \{\s*return viewer\.isSuperAdmin && viewer\.canUpdate && !viewer\.isTestPersona;/,
  );
  for (const fn of ["loadVisitRecordingAdmin", "setRecordingRequired", "downloadVisitRecording", "deleteVisitRecording"]) {
    const body = service.slice(service.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, 200), /assertManager\(viewer\);/, `${fn} refuses everybody but the Super Admin itself`);
  }
  const page = read("app/(admin)/admin/field-crm/visit-recording/page.tsx");
  assert.match(page, /if \(!viewer \|\| !canManageVisitRecording\(viewer\)\) redirect\("\/admin"\);/, "the page redirects anybody else");
  assert.ok(page.indexOf("canManageVisitRecording(viewer)") < page.indexOf("loadVisitRecordingAdmin("), "the gate runs before the read");

  for (const route of [
    "app/api/phoenix-crm/recording/upload-slot/route.ts",
    "app/api/phoenix-crm/recording/play/route.ts",
    "app/api/phoenix-crm/recording/admin/route.ts",
    "app/api/phoenix-crm/recording/admin/download/route.ts",
    "app/api/phoenix-crm/recording/admin/delete/route.ts",
  ]) {
    const source = read(route);
    assert.match(source, /assertSameOriginMutation\(request\)/, `${route} is a same-origin POST`);
    assert.match(source, /await assertPermission\(access, "phoenix_crm", "(create|read|update)"\)/, `${route} asks the permission first`);
  }

  // Deleting goes through the Storage API, never SQL on storage.objects, and keeps the row stamped.
  const remove = service.slice(service.indexOf("export async function deleteVisitRecording("));
  assert.match(remove, /\.storage\.from\(PHOENIX_CRM_RECORDING_BUCKET\)\.remove\(\[path\]\)/);
  assert.match(remove, /deleted_at: new Date\(\)\.toISOString\(\), deleted_by_hr_id: viewer\.hrId/, "who deleted it and when is kept");

  // ── The page fits the screen ─────────────────────────────────────────────────────────────────
  const admin = read("src/components/phoenix-crm/visit-recording-admin.tsx");
  for (const name of ["REP_COLUMNS", "RECORDING_COLUMNS"]) {
    const block = admin.slice(admin.indexOf(`const ${name} = [`), admin.indexOf("] as const;", admin.indexOf(`const ${name} = [`)));
    const widths = [...block.matchAll(/width: "(\d+)%"/g)].map((match) => Number(match[1]));
    assert.ok(widths.length >= 4, `${name} names its widths`);
    assert.equal(
      widths.reduce((sum, width) => sum + width, 0),
      100,
      `${name} sums to 100% — under table-fixed anything over it is cut, never scrolled`,
    );
  }
  assert.ok(admin.indexOf("<CrmCardsOnPhone>") < admin.indexOf("<CrmTable"), "the phone cards come before the desktop table");
  assert.doesNotMatch(admin, /overflow-x|min-w-\[|truncate|line-clamp/, "no sideways scroll and no ellipsis");

  // ── The database half: the claim function is the service role's alone ───────────────────────
  const sql = stripSqlComments(readFileSync("supabase/migrations/20261016103900_phoenix_crm_visit_recording.sql", "utf8"));
  assert.match(sql, /create table if not exists public\.phoenix_crm_recording_required/);
  assert.match(sql, /create table if not exists public\.phoenix_crm_visit_recordings/);
  assert.match(
    sql,
    /revoke (all|execute) on function public\.phoenix_crm_claim_visit_recording\([^)]*\) from public, anon, authenticated;/,
    "the claim is never callable with the browser key",
  );
  assert.match(sql, /'phoenix-crm-recordings',\s*'phoenix-crm-recordings',\s*false/, "the bucket is private");
}
