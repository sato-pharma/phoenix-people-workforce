import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isUnplannedVisitStatus,
  isUnplannedVisitWaiting,
  unplannedVisitStatusLabel,
  unplannedVisitRepNote,
  unplannedVisitStageOf,
} from "../src/lib/phoenix-crm/unplanned-rules.ts";
import {
  describeRecordingLength,
  describeRecordingSize,
  isRecordingReviewStatus,
  isVisitRecordingRefusal,
  RECORDED_VISIT_REP_NOTE,
  RECORDED_VISIT_DECISION_MANAGER_LEVELS,
  RECORDING_REVIEW_NOTE_MAX,
  recordingDownloadName,
  recordingReviewLabel,
  recordingReviewRepLabel,
  VISIT_RECORDING_ADMIN_PATH,
  VISIT_RECORDING_MAX_BYTES,
  VISIT_RECORDING_MAX_SECONDS,
  VISIT_RECORDING_MIN_SECONDS,
  VISIT_RECORDING_REQUIRED_CODE,
  visitRecordingMicrophoneProblem,
} from "../src/lib/phoenix-crm/visit-recording-rules.ts";
import { PHOENIX_CRM_EMAIL_EVENT_TYPES, phoenixCrmChannels } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { phoenixCrmVisitNoticeKeyPrefix, recordedVisitDecisionDeliveries } from "../src/lib/phoenix-crm/server/notifications.ts";
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
 *   6. A recorded visit of ANY type waits for the Administrator first (owner, 2026-10-16: "any visit any
 *      type which is recorder must go for adminstarator approval first even if in plan"): it counts in
 *      nothing until he approves it, a recorded off-plan visit reaches its manager only after his yes,
 *      and the manager's decide path refuses it while it waits.
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
    /const recorded = enteredAs === "rep" \? await $/,
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
  // The slot row and its signed URL are asked for together (Phoenix CRM performance audit, 2026-10-16) —
  // settled, never raced, and the ROW's error is read first, so a URL for a path with no slot behind it
  // is never handed out: the claim would refuse such a path.
  const slotFn = service.slice(service.indexOf("export async function requestRecordingSlot("), service.indexOf("export function readRecordingClaim("));
  assert.match(slotFn, /await Promise\.allSettled\(\[\s*insertSlot\(\),\s*supabase\.storage\.from\(PHOENIX_CRM_RECORDING_BUCKET\)\.createSignedUploadUrl\(path\),/);
  assert.ok(
    slotFn.indexOf("throwIfError(slot.value.error);") > 0 && slotFn.indexOf("throwIfError(slot.value.error);") < slotFn.indexOf("const { data, error } = signing.value;"),
    "a failed slot row answers before the signed URL is even looked at",
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
  assert.match(tab, /visitRecording=\{loaded\.recordingRequired \? sent\.recording : null\}/, "only a switched-on rep's form carries a recording");

  const form = read("src/components/phoenix-crm/visit-log-form.tsx");
  assert.match(form, /recordingPath: visitRecording\?\.path \?\? null/, "the save carries the stored path");
  assert.match(form, /isVisitRecordingRefusal\(/, "a refused recording sends the rep back to the recorder");

  // ── 3. Who hears it ──────────────────────────────────────────────────────────────────────────
  // The whole body, so a third reader — the rep above all — cannot be added beside the two lines.
  assert.match(
    service,
    /export function hearsVisitRecording\(viewer: PhoenixCrmViewer, seat: OrgSeat\): boolean \{\s*if \(viewer\.isSuperAdmin \|\| viewer\.isSfeManager\) return true;\s*return managerChain\(viewer\.org, seat\.seatId\)\.some\(\(member\) => member\.hrId === viewer\.hrId\);\s*\}/,
    "his answer 4: the Super Admin, the SFE managers and the territory's own managers — and nobody else",
  );
  assert.match(visits, /const hears = hearsVisitRecording\(viewer, seat\);/, "the day asks who may hear the recordings");
  assert.match(
    visits,
    /return hears && recording\.seconds !== null \? \{ \.\.\.reviewed, recordingSeconds: recording\.seconds \} : reviewed;/,
    "the recording's length — what draws the player — goes only to a reader who may hear it",
  );
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

  // ── 6. A recorded visit of ANY type waits for the Administrator first ─────────────────────────
  assert.equal(isRecordingReviewStatus("pending"), true);
  assert.equal(isRecordingReviewStatus("approved"), true);
  assert.equal(isRecordingReviewStatus("refused"), true);
  assert.equal(isRecordingReviewStatus("admin_pending"), false, "the recording's own decision has three states, nothing else");
  assert.equal(RECORDING_REVIEW_NOTE_MAX, 500, "the database's own ceiling");
  assert.equal(recordingReviewLabel("pending"), "Waiting for your approval");
  assert.equal(VISIT_RECORDING_ADMIN_PATH, "/admin/field-crm/visit-recording", "the board links to the page that decides it");

  // The rep is told, in the owner's own words, that his visit is pending admin approval (2026-10-16:
  // "show here ur visit is pending admin approval") — a role, never a person, never a check.
  for (const note of [RECORDED_VISIT_REP_NOTE, unplannedVisitRepNote("admin_pending"), recordingReviewRepLabel("pending")]) {
    assert.match(note, /pending admin approval/i, "the rep reads that his visit is pending admin approval");
    assert.doesNotMatch(note, /Administrator|checked|reviewed|Omar/i, "and never who approves it or that it is checked");
  }
  assert.equal(recordingReviewRepLabel("approved"), "Approved — it counts");
  assert.equal(recordingReviewRepLabel("refused"), "Not approved — it does not count");

  // It shows on his OWN visit list, for every reader, and an out-of-plan visit says it once, in its step pill.
  assert.match(visits, /const reviewed = \{ \.\.\.visit, countsInKpi, recordingReview: recording\.reviewStatus \};/, "the day carries the approval to every reader, the rep included");
  assert.match(tab, /if \(!visit\.recordingReview \|\| visit\.unplanned\) return null;/, "an out-of-plan visit is not told twice");
  assert.match(tab, /\{recording \? <CrmPill tone=\{recording\.tone\}>\{recording\.label\}<\/CrmPill> : null\}/, "the pill is drawn on the visit's own row");
  assert.equal(unplannedVisitStatusLabel("admin_pending"), "Pending admin approval");

  // 🔴 It never stops his next visit: the save path asks nothing about an earlier visit's approval.
  assert.doesNotMatch(save.slice(0, save.indexOf('"phoenix_crm_save_visit"')), /review_status|reviewStatus/, "a pending visit never blocks the next one");

  // An off-plan recorded visit's first step is the Administrator's, and it is still WAITING.
  assert.equal(isUnplannedVisitStatus("admin_pending"), true);
  assert.equal(isUnplannedVisitWaiting("admin_pending"), true, "while he has not decided, it counts in nothing");
  assert.equal(unplannedVisitStageOf("admin_pending"), null, "it is no manager's or SFE's step — they cannot decide it yet");

  // The manager's and SFE's decide path refuses it while it waits for him.
  const unplanned = read("src/lib/phoenix-crm/server/unplanned.ts");
  const decideAt = unplanned.indexOf("export async function decideUnplannedVisit(");
  assert.ok(decideAt > 0, "the decide path could not be located");
  assert.match(
    unplanned.slice(decideAt, decideAt + 3000),
    /if \(status === "admin_pending"\) throw forbiddenError\(/,
    "a manager cannot decide a visit still waiting for the Administrator",
  );

  // The save holds back the manager's notice for a recorded visit; the Administrator's yes sends it.
  assert.match(save, /if \(unplannedKind === "out_of_plan" && result\.duplicate !== true && !recorded\) \{/, "no notice to the manager before the Administrator decides");
  assert.match(save, /recordingNote: recorded \? RECORDED_VISIT_REP_NOTE : null/, "the rep is told it counts once approved");
  const review = service.slice(service.indexOf("export async function reviewRecordedVisit("));
  assert.match(
    review.slice(0, 400),
    /assertManager\(viewer\);\s*if \(!canAdminister\(viewer\)\) throw forbiddenError\(/,
    "the decision is the Administrator's alone, asked inside the service",
  );
  assert.match(review, /if \(decision === "refuse" && note === null\) throw validationError\(/, "a refusal carries a note");
  assert.match(
    review,
    /unplannedStatus === "manager_pending" \|\| unplannedStatus === "sfe_pending"/,
    "his yes hands an off-plan visit to its step, and that step is told then",
  );
  assert.match(review, /kind: "unplanned_visit_raised"/);

  const reviewRoute = read("app/api/phoenix-crm/recording/admin/review/route.ts");
  assert.match(reviewRoute, /assertSameOriginMutation\(request\)/, "the review route is a same-origin POST");
  assert.match(reviewRoute, /await assertPermission\(access, "phoenix_crm", "approve"\)/, "and asks the approve permission first");

  // The Needs You board carries the waiting count to his own lane, asked for him alone.
  const crmNeedsYou = read("src/lib/phoenix-crm/server/needs-you.ts");
  assert.match(
    crmNeedsYou,
    /canAdminister\(viewer\) \? countRecordedVisitsWaiting\(\) : Promise\.resolve\(\{ count: 0, oldestAt: null \}\)/,
    "a true zero with no query for everyone else",
  );
  const countAt = service.indexOf("export async function countRecordedVisitsWaiting(");
  assert.ok(countAt > 0, "the module owns the count");
  const countBody = service.slice(countAt, service.indexOf("\n}\n", countAt));
  assert.match(countBody, /\.eq\("review_status", "pending"\)/);
  assert.match(countBody, /saved\.has\(/, "a claim whose visit was never written is not counted");
  assert.doesNotMatch(countBody, /catch/, "a failed read travels to the board's amber row");

  // The database half.
  const reviewSql = stripSqlComments(
    readFileSync("supabase/migrations/20261016161248_phoenix_crm_recorded_visit_waits_for_the_administrator.sql", "utf8"),
  );
  assert.match(reviewSql, /add column if not exists review_status text not null default 'pending'/, "every recording starts waiting");
  assert.match(reviewSql, /check \(status in \('admin_pending', 'manager_pending', 'sfe_pending', 'approved', 'refused'\)\)/);
  assert.match(
    reviewSql,
    /create or replace trigger phoenix_crm_unplanned_waits_for_the_administrator\s+before insert on public\.phoenix_crm_unplanned_visits/,
    "a recorded off-plan visit is moved to the Administrator's step as it is written, whatever path writes it",
  );
  assert.match(reviewSql, /new\.after_admin_status := new\.status;\s*new\.status := 'admin_pending';/, "the step it was going to start at is kept for his yes");
  assert.match(
    reviewSql,
    /with \(security_invoker = true\) as[\s\S]*and not exists \(\s*select 1 from public\.phoenix_crm_visit_recordings r\s*where r\.visit_id = v\.id and r\.review_status <> 'approved'\s*\)/,
    "the countable view leaves out every recorded visit he has not approved — planned included",
  );
  assert.match(reviewSql, /where r\.visit_id = v_visit_id for update;/, "the decision locks the recording row, so two clicks cannot both decide");
  assert.match(reviewSql, /raise exception 'phoenix_crm:recording_reviewed'/, "a decided recording is never decided twice");
  assert.match(
    reviewSql,
    /revoke execute on function public\.phoenix_crm_review_visit_recording\(jsonb\) from public, anon, authenticated;/,
    "the decision is never callable with the browser key",
  );

  // ── 7. The Administrator's decision, with his comment, reaches the rep and two managers ───────
  // Owner, 2026-10-17: "reject or approve with a comment and this comment goes email and telegram to
  // the rep and his manager and his manager of manager".
  assert.equal(RECORDED_VISIT_DECISION_MANAGER_LEVELS, 2, "his manager and his manager's manager — two seats, not the whole chain");

  const seatOf = (overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat => ({
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  });
  const ceo = seatOf({ seatId: "S-CEO", tier: "CEO", path: ["S-CEO"], occupantHrId: "B-2", lineCode: null, lineName: null });
  const nsm = seatOf({ seatId: "S-NSM", tier: "NSM", path: ["S-CEO", "S-NSM"], occupantHrId: "A-12" });
  const rsm = seatOf({ seatId: "S-RSM", tier: "RSM", path: [...nsm.path, "S-RSM"], occupantHrId: "B-60" });
  const dm = seatOf({ seatId: "S-DM", tier: "DM", path: [...rsm.path, "S-DM"], occupantHrId: "B-61" });
  const rep = seatOf({ seatId: "S-REP", tier: "REP", path: [...dm.path, "S-REP"], occupantHrId: "B-62", areaName: "Minia 1" });
  const emptyDm = seatOf({ seatId: "S-DM-EMPTY", tier: "DM", path: [...nsm.path, "S-DM-EMPTY"], occupantHrId: null });
  const repUnderEmpty = seatOf({ seatId: "S-REP-2", tier: "REP", path: [...emptyDm.path, "S-REP-2"], occupantHrId: "B-80", areaName: "Dokki" });
  const org = buildOrgIndex([ceo, nsm, rsm, dm, rep, emptyDm, repUnderEmpty]);
  const names = new Map([
    ["B-62", "Mohamed Sami"],
    ["B-80", "Nour Hassan"],
  ]);
  const decided = (overrides: Record<string, unknown> = {}) =>
    ({
      kind: "recorded_visit_decided" as const,
      org,
      seat: rep,
      visitId: "8f1b2c3d-0000-4000-8000-00000000abcd",
      repHrId: "B-62",
      customerName: "Dr Hani Farouk",
      visitDate: "2026-10-17",
      decision: "refused" as const,
      deciderHrId: "B-10",
      note: "The visit does not match the plan.",
      ...overrides,
    }) as Parameters<typeof recordedVisitDecisionDeliveries>[0];

  {
    const [toRep, toManagers, ...rest] = recordedVisitDecisionDeliveries(decided(), names);
    assert.equal(rest.length, 0, "two messages: one for the rep, one for the managers above him");
    assert.deepEqual(toRep.recipients, ["B-62"], "the rep is told his own visit was decided");
    assert.deepEqual(
      toManagers.recipients,
      ["B-61", "B-60"],
      "his district manager and the regional manager above him — his manager and his manager's manager; the national manager above that is not told",
    );
    assert.match(toRep.message, /The Administrator did not approve your visit to .*Dr Hani Farouk.* so it does not count\. Comment: .*The visit does not match the plan\./);
    assert.match(toManagers.message, /did not approve Mohamed Sami's visit to .*Dr Hani Farouk/);
    assert.match(toManagers.message, /Comment: .*The visit does not match the plan\./, "the managers read the same comment the rep does");
    assert.equal(toRep.eventType, "recorded_visit_decided");
    assert.equal(toManagers.eventType, "recorded_visit_decided");
    assert.notEqual(toRep.idempotencyKey, toManagers.idempotencyKey, "one key per audience, so neither upserts over the other");
    for (const delivery of [toRep, toManagers]) {
      assert.ok(
        delivery.idempotencyKey.startsWith(phoenixCrmVisitNoticeKeyPrefix("8f1b2c3d-0000-4000-8000-00000000abcd")),
        "keyed under the visit, so a removed visit withdraws it",
      );
      assert.doesNotMatch(delivery.message, /record|listen|heard|check|Omar/i, "Golden Rule #1: it names a role and a decision, never a recording or a check");
    }
  }
  {
    const [toRep, toManagers] = recordedVisitDecisionDeliveries(decided({ decision: "approved", note: null }), names);
    assert.match(toRep.message, /^The Administrator approved your visit to .*Dr Hani Farouk.* on .*\. It counts\.$/, "an approval with no comment says only that it counts");
    assert.doesNotMatch(toRep.message + toManagers.message, /Comment:/, "no comment, no empty Comment: line");
    const [approvedWithNote] = recordedVisitDecisionDeliveries(decided({ decision: "approved", note: "Well done." }), names);
    assert.match(approvedWithNote.message, /It counts\. Comment: .*Well done\./, "an approval may carry a comment too");
    const [refusedRep] = recordedVisitDecisionDeliveries(decided(), names);
    assert.notEqual(approvedWithNote.idempotencyKey, refusedRep.idempotencyKey, "an approval and a refusal never share a key");
  }
  {
    const [toRep, toManagers] = recordedVisitDecisionDeliveries(decided({ seat: repUnderEmpty, repHrId: "B-80" }), names);
    assert.deepEqual(toManagers.recipients, ["A-12"], "a vacant district passes upward: the national manager is then his manager");
    assert.deepEqual(toRep.recipients, ["B-80"]);
    const onlyDecider = recordedVisitDecisionDeliveries(decided({ seat: repUnderEmpty, repHrId: "B-80", deciderHrId: "A-12" }), names);
    assert.equal(onlyDecider.length, 1, "the decider is never told his own decision");
    assert.deepEqual(onlyDecider[0].recipients, ["B-80"]);
  }
  {
    // 🔴 An acting district manager holds a manager seat AND a rep seat: he is told once, as the rep.
    const acting = seatOf({ seatId: "S-ADM", tier: "ACTING_DM", path: [...nsm.path, "S-ADM"], occupantHrId: "B-1" });
    const actingRep = seatOf({ seatId: "S-ADM-REP", tier: "REP", path: [...acting.path, "S-ADM-REP"], occupantHrId: "B-1" });
    const actingOrg = buildOrgIndex([ceo, nsm, acting, actingRep]);
    const deliveries = recordedVisitDecisionDeliveries(decided({ org: actingOrg, seat: actingRep, repHrId: "B-1" }), new Map());
    const everyone = deliveries.flatMap((delivery) => delivery.recipients);
    assert.equal(everyone.filter((hrId) => hrId === "B-1").length, 1, "nobody is named twice, the rep least of all");
  }

  // The notice EMAILS — the one Phoenix CRM notice that does — beside in-app, Telegram and the phone.
  assert.deepEqual([...PHOENIX_CRM_EMAIL_EVENT_TYPES], ["recorded_visit_decided"], "his word, 2026-10-17: the single email exception");
  assert.deepEqual(phoenixCrmChannels("recorded_visit_decided"), ["in_app", "email", "telegram", "push"]);
  assert.deepEqual(phoenixCrmChannels("recorded_visit_decided", true), ["in_app"], "a test entry stays in the app");
  assert.deepEqual(
    resolveNotificationPolicy({ module: "phoenix_crm", eventType: "recorded_visit_decided" }).channels,
    ["in_app", "email", "telegram", "push"],
    "the policy row is the intent and agrees with the guard",
  );

  // The wiring: the decision notifies, and the screen sends the comment on BOTH decisions.
  {
    const service = read("src/lib/phoenix-crm/server/visit-recordings.ts");
    const review = service.slice(service.indexOf("export async function reviewRecordedVisit("));
    assert.match(review, /kind: "recorded_visit_decided"/, "a saved decision tells the rep and the two managers");
    assert.match(review, /decision: decision === "approve" \? "approved" : "refused",\s*deciderHrId: viewer\.hrId,\s*note,/, "with the comment he wrote");
    assert.ok(review.indexOf('kind: "recorded_visit_decided"') > review.indexOf('"phoenix_crm_review_visit_recording"'), "only AFTER the decision is saved");
    assert.match(review, /result\.is_test !== true/, "a test world's entry tells nobody");
    const screen = read("src/components/phoenix-crm/visit-recording-admin.tsx");
    assert.match(screen, /\{ visitId: row\.visitId, decision, note \}/, "the comment travels with an approval as well as a refusal");
    assert.match(screen, /Approve and send/, "and the approve button offers the comment box");
  }
}
