import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  parseVisitDetailEdit,
  PHARMACY_IS_THE_CUSTOMER,
  PHARMACY_NAME_IS_ADD_ONLY,
  pharmacyNameAddable,
  VISIT_DETAIL_COMMENT_MAX,
  VISIT_DETAIL_EDIT_AGAIN,
  VISIT_DETAIL_EDIT_PROMPT,
  VISIT_DETAIL_FIXED_LINKED,
  VISIT_DETAIL_FIXED_NO_REP,
  VISIT_DETAIL_FIXED_OTHER_REP,
  visitDetailEditable,
  visitDetailEditedLine,
} from "../src/lib/phoenix-crm/visit-detail-edit-rules.ts";

/**
 * The rep writes up his OWN saved visit afterwards (owner, 2026-10-15).
 *
 * He walks from door to door and has no time between two of them for the company's full report, so
 * logging stays one tap — the location and the time — and the soft detail is written later. His three
 * answers, asked directly that day: ANY TIME (no deadline), the pharmacy name is ADD-ONLY, and ONLY
 * THE REP may write it.
 *
 * WHAT EACH SECTION CATCHES, in the words of the change that would break it:
 *
 *  1. A field of the parse widened, an over-long account accepted, or an unknown chip value REFUSING
 *     the save rather than being dropped — he is typing this up at the end of a long day and a chip key
 *     from a build one release behind must not cost him the paragraph he just wrote.
 *  2. The door comment becoming editable, or a visit that is not his becoming his. "Leave it and make
 *     them able to add another detailed comment" is his own wording.
 *  3. A pharmacy name being CHANGED or cleared. A name files a real visit to that pharmacy, so this
 *     would delete a logged visit — and a refusal said in a SENTENCE rather than a silent drop, or he
 *     believes he changed it.
 *  4. The marker losing its date and time ("anything edited, it should appear that this is edited in
 *     the date and time").
 *  5. THE EVIDENCE OR THE TWO SETTLED RULINGS moving: the customer, the day, the time, the location,
 *     the photo, the voice note, AM/PM, who was on the visit, the products. The SQL update is the one
 *     place that can move them, so it is read column by column.
 *  6. A MEASUREMENT reaching the rep's browser through the new read (Golden Rule #1: a field a browser
 *     receives counts as shown).
 *  7. The gate widening past the territory's own rep, in TypeScript or in SQL — or the route reading a
 *     body before it asserts.
 *  8. The before-image stopping being written BEFORE the update, or a no-op writing an audit row.
 *     Production has no point-in-time recovery.
 *  9. The card and the table disagreeing about the same visit, or the write-up door appearing on a
 *     manager's screen.
 * 10. A notice. A rep completing his own report is not a check on him, in either direction.
 */

const ROOT = new URL("../", import.meta.url);
const MIGRATION = "supabase/migrations/20261015110300_phoenix_crm_visit_detail_edit.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function rawSource(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

function parsed(patch: Record<string, unknown>) {
  const result = parseVisitDetailEdit({ visitId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", ...patch });
  assert.equal(result.ok, true, `expected this edit to parse: ${JSON.stringify(patch)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

export function runPhoenixCrmVisitDetailEditTests(): void {
  // ── 1. One edit off the wire ──────────────────────────────────────────────────────────────────
  {
    const bad = parseVisitDetailEdit({ visitId: "not-a-uuid" });
    assert.equal(bad.ok, false, "a visit id that is not a uuid is refused");

    const whole = parsed({
      detailComment: "  Asked for the 30-tablet pack, and the nurse took two leaflets.  ",
      objection: "price",
      objectionNote: "  the pack is too big  ",
      nextStep: "send_data",
      nextStepOn: "2026-10-20",
      samplesGiven: { Saginko: 3 },
      productAvailability: { Saginko: "has" },
      pharmacyName: "  El Ezaby — Nasr City  ",
    });
    assert.equal(whole.detailComment, "Asked for the 30-tablet pack, and the nurse took two leaflets.", "the account is trimmed, never clipped");
    assert.equal(whole.outcome.objection, "price");
    assert.equal(whole.outcome.objectionNote, "the pack is too big");
    assert.equal(whole.outcome.nextStep, "send_data");
    assert.equal(whole.outcome.nextStepOn, "2026-10-20", "the day he means to do it — asked here and nowhere else");
    assert.deepEqual(whole.samplesGiven, { Saginko: 3 });
    assert.deepEqual(whole.productAvailability, { Saginko: "has" });
    assert.equal(whole.pharmacyName, "El Ezaby — Nasr City");

    assert.equal(parsed({ detailComment: "   " }).detailComment, null, "an empty account is null, so a cleared box clears the column");
    assert.equal(
      parseVisitDetailEdit({ visitId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", detailComment: "x".repeat(VISIT_DETAIL_COMMENT_MAX + 1) }).ok,
      false,
      "an account longer than the cap is refused, because the database would refuse it too",
    );
    assert.equal(VISIT_DETAIL_COMMENT_MAX, 2000, "twice the door comment's 1,000: this is the long account the door had no time for");

    // 🔴 DROPPED, NEVER REFUSED — and each dependant goes with its parent.
    const unknown = parsed({ objection: "vibes", objectionNote: "kept nothing", nextStep: "teleport", nextStepOn: "2026-10-20" });
    assert.equal(unknown.outcome.objection, null, "an objection value this build does not know is dropped");
    assert.equal(unknown.outcome.objectionNote, null, "and its note goes with it");
    assert.equal(unknown.outcome.nextStep, null, "an unknown next step is dropped");
    assert.equal(unknown.outcome.nextStepOn, null, "and so is the day under it");
    const none = parsed({ objection: "none", objectionNote: "should not survive", nextStep: "none", nextStepOn: "2026-10-20" });
    assert.equal(none.outcome.objectionNote, null, '"No objection" carries no note');
    assert.equal(none.outcome.nextStepOn, null, '"Nothing to follow" carries no day');

    const junk = parsed({ samplesGiven: { Saginko: 0, Other: -2 }, productAvailability: { Saginko: "maybe" } });
    assert.deepEqual(junk.samplesGiven, {}, "a zero or negative count is not a thing he left");
    assert.deepEqual(junk.productAvailability, {}, "and an answer that is neither has nor missing is dropped");
  }

  // ── 2. Whose visit it is ──────────────────────────────────────────────────────────────────────
  {
    assert.deepEqual(
      visitDetailEditable({ repHrId: "AI-0025", linkedFromVisitId: null, actorHrId: "ai-0025" }),
      { editable: true },
      "his own visit, however the two ids are cased",
    );
    assert.deepEqual(
      visitDetailEditable({ repHrId: "AI-0026", linkedFromVisitId: null, actorHrId: "AI-0025" }),
      { editable: false, reason: VISIT_DETAIL_FIXED_OTHER_REP },
      "another rep's visit stays as they recorded it",
    );
    assert.deepEqual(
      visitDetailEditable({ repHrId: null, linkedFromVisitId: null, actorHrId: "B-10" }),
      { editable: false, reason: VISIT_DETAIL_FIXED_NO_REP },
      "a manager's own single visit carries no rep, so it has no rep's detail to write up",
    );
    // The pharmacy visit a doctor's visit filed is part of that one submission.
    assert.deepEqual(
      visitDetailEditable({ repHrId: "AI-0025", linkedFromVisitId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", actorHrId: "AI-0025" }),
      { editable: false, reason: VISIT_DETAIL_FIXED_LINKED },
      "and the linked pharmacy visit sends him to the visit it came from",
    );
    assert.match(VISIT_DETAIL_FIXED_LINKED, /Add the detail on that visit/, "the sentence says where to go, not just no");
  }

  // ── 3. The pharmacy name is add-only ──────────────────────────────────────────────────────────
  {
    assert.deepEqual(pharmacyNameAddable({ listType: "PM", pharmacyName: null }), { addable: true }, "a doctor's visit with no pharmacy named may take one");
    assert.deepEqual(
      pharmacyNameAddable({ listType: "PM", pharmacyName: "El Ezaby" }),
      { addable: false, reason: PHARMACY_NAME_IS_ADD_ONLY },
      "a name already recorded is never changed — it filed a real visit",
    );
    assert.deepEqual(
      pharmacyNameAddable({ listType: "Pharmacy", pharmacyName: "Seif" }),
      { addable: false, reason: PHARMACY_IS_THE_CUSTOMER },
      "at a pharmacy the pharmacy IS the customer",
    );
    assert.match(PHARMACY_NAME_IS_ADD_ONLY, /You can still change what it has/, "refusing the FIELD is not refusing the edit");
  }

  // ── 4. The marker ─────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(visitDetailEditedLine(null, () => "never asked"), null, "a visit nobody has written up carries no marker");
    assert.equal(
      visitDetailEditedLine("2026-10-15T16:30:00.000Z", (iso) => (iso === "2026-10-15T16:30:00.000Z" ? "Thu 15 Oct, 6:30 PM" : "wrong instant")),
      "Edited · Thu 15 Oct, 6:30 PM",
      "the fact, then the Cairo date and time — his own wording",
    );
    assert.notEqual(VISIT_DETAIL_EDIT_PROMPT, VISIT_DETAIL_EDIT_AGAIN, "the button says which it is before he presses it");
  }

  // ── 5. The evidence and the two settled rulings do not move ───────────────────────────────────
  {
    const sql = source(MIGRATION);
    const update = sql.slice(sql.indexOf("update public.phoenix_crm_visits"), sql.indexOf("where id = v_id;"));
    assert.ok(update.length > 0, "the migration still updates the visit");
    const moved = [
      "detail_comment",
      "next_step",
      "next_step_on",
      "objection",
      "objection_note",
      "samples_given",
      "product_availability",
      "pharmacy_name",
      "detail_edited_at",
      "detail_edited_by_hr_id",
    ];
    // Read the update COLUMN BY COLUMN, never as a substring: `detail_comment =` holds `comment =`
    // inside it, so a substring sweep both false-accuses this edit and would miss `set comment=`.
    const assigned = new Set(
      [...update.matchAll(/(?:^|[\s,])([a-z_][a-z0-9_]*)\s*=/gm)].map((match) => match[1]),
    );
    for (const column of moved) assert.ok(assigned.has(column), `the rep's own edit must still write ${column}`);
    for (const frozen of [
      "customer_id",
      "visit_date",
      "captured_at",
      "list_type",
      "kind",
      "products",
      "comment",
      "manager_hr_id",
      "senior_hr_id",
      "product_manager_hr_id",
      "lat",
      "lon",
      "accuracy_meters",
      "place_id",
      "distance_meters",
      "location_flag",
      "photo_path",
      "voice_note_path",
      "dwell_seconds",
      "capture_source",
      "is_unplanned",
      "unplanned_kind",
    ]) {
      assert.ok(!assigned.has(frozen), `${frozen} is evidence or the Super Admin's to correct — the rep's own edit may never write it`);
    }
    // The three new columns and the account's own cap.
    assert.match(sql, /add column if not exists detail_comment text/);
    assert.match(sql, /add column if not exists detail_edited_at timestamptz/);
    assert.match(sql, /add column if not exists detail_edited_by_hr_id text/);
    assert.match(sql, /char_length\(detail_comment\) <= 2000/, "the database holds the same cap the parse does");
    assert.match(sql, /revoke execute on function public\.phoenix_crm_edit_visit_detail\(jsonb\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function public\.phoenix_crm_edit_visit_detail\(jsonb\) to service_role;/);
  }

  // ── 6. The read names no measurement at all ───────────────────────────────────────────────────
  {
    const service = source("src/lib/phoenix-crm/server/visit-detail-edit.ts");
    for (const column of [
      "distance_meters",
      "accuracy_meters",
      "location_flag",
      "capture_source",
      "device_skew_minutes",
      "dwell_seconds",
      "form_open_seconds",
      "lat,",
      "lon,",
      "place_id",
    ]) {
      assert.ok(!service.includes(column), `the write-up form must never read ${column} — a field his browser receives counts as shown`);
    }
    const panel = source("src/components/phoenix-crm/visit-detail-panel.tsx");
    assert.doesNotMatch(panel, /distance|accuracy|locationFlag|formatDistance/i, "and the panel shows no check of any kind");
  }

  // ── 7. The gate, twice, and the route ─────────────────────────────────────────────────────────
  {
    const service = source("src/lib/phoenix-crm/server/visit-detail-edit.ts");
    assert.match(service, /territoryForRepWrite\(viewer, raw\.seatId, readTestFlag\(raw\.test\)\)/, "the read is gated on his own seat");
    assert.match(service, /territoryForRepWrite\(viewer, body\.seatId, readTestFlag\(body\.test\)\)/, "and so is the save");
    assert.ok(!service.includes("territoryForVisitEdit"), "territoryForVisitEdit is the Super Admin's correction door, never this one");

    const sql = source(MIGRATION);
    assert.match(sql, /v_visit\.rep_hr_id is null or v_visit\.rep_hr_id <> v_actor/, "SQL re-checks that the visit is the actor's own");
    assert.match(sql, /phoenix_crm:visit_not_yours/);
    assert.match(sql, /v_visit\.linked_from_visit_id is not null/, "and that it is not the visit another visit filed");
    assert.match(sql, /phoenix_crm:pharmacy_name_fixed/, "and refuses a second pharmacy name by name");
    assert.match(sql, /pg_advisory_xact_lock\(hashtext\('phoenix_crm:seat:' \|\| v_seat\)\)/, "under the same per-seat lock the rep's own save takes");

    const route = source("app/api/phoenix-crm/visit-detail/route.ts");
    const get = route.slice(route.indexOf("export async function GET("), route.indexOf("export async function POST("));
    const post = route.slice(route.indexOf("export async function POST("));
    assert.ok(
      get.indexOf('assertPermission(access, "phoenix_crm", "read")') < get.indexOf("loadVisitDetailForm"),
      "the GET asserts before it reads anything",
    );
    assert.ok(
      post.indexOf('assertPermission(access, "phoenix_crm", "create")') < post.indexOf("request.json()"),
      "and the POST asserts before it reads the body",
    );
    assert.match(post, /assertSameOriginMutation\(request\)/, "the save carries the module's CSRF layer");
    assert.ok(!route.includes('"update"'), "the rep holds no `update` — that is the Super Admin's separate door");
  }

  // ── 8. Nothing is lost, and a no-op writes nothing ────────────────────────────────────────────
  {
    const sql = source(MIGRATION);
    const insertAt = sql.indexOf("insert into public.phoenix_crm_visit_edits");
    const updateAt = sql.indexOf("update public.phoenix_crm_visits");
    assert.ok(insertAt > 0 && updateAt > insertAt, "the copy is inserted BEFORE the update — production has no point-in-time recovery");
    const noop = sql.slice(sql.indexOf("if v_detail is not distinct from"), insertAt);
    assert.ok(noop.includes("'changed', false"), "a save with nothing different answers changed = false");
    assert.ok(noop.includes("return jsonb_build_object"), "and returns before the copy, so a no-op writes no audit row");
    for (const column of ["detail_comment", "next_step", "next_step_on", "objection", "objection_note", "samples_given", "product_availability", "pharmacy_name"]) {
      assert.ok(noop.includes(`v_visit.${column}`), `the no-op check must compare ${column}, or a change to it writes nothing`);
    }
    // A malformed bag LEAVES WHAT THE VISIT HAS. Here an empty object is a real instruction ("I left
    // nothing after all"), so it must not be read as that instruction and wipe his answers.
    assert.match(sql, /v_samples := v_visit\.samples_given;/);
    assert.match(sql, /v_availability := v_visit\.product_availability;/);
  }

  // ── 9. The card and the table say the same thing, and only to him ─────────────────────────────
  {
    const tab = source("src/components/phoenix-crm/visits-tab.tsx");
    assert.equal([...tab.matchAll(/visitDetailEditedText\(visit\.detailEditedAt\)/g)].length >= 2, true, "the marker is on the phone card and the table row");
    assert.equal([...tab.matchAll(/visit\.detailComment/g)].length >= 2, true, "and so is the write-up itself");
    assert.equal([...tab.matchAll(/<VisitDetailEdit\b/g)].length, 2, "the write-up door is on both, and on nothing else");
    assert.match(tab, /detail && visit\.detailEditable/, "and only on a visit that is his own");
    assert.match(
      tab,
      // `reload` is how a written-up visit re-reads its own day (2026-10-16 performance audit); the gate is unchanged.
      /canAddVisitDetail === true \? \{ seatId: view\.territory\.seatId, isTest: view\.isTest(?:, reload: day\.reload)? \} : null/,
      "the door is the server's answer, never the screen's",
    );
    assert.ok(!tab.includes("isToday && view?.canAddVisitDetail"), "and it carries NO day condition — he was asked and answered any time");

    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.match(visits, /canAddVisitDetail: canWriteAsRep\(viewer, seat, isTest\),/, "the day view answers it with his own write gate");
    assert.match(visits, /visitDetailEditable\(\{/, "and each row carries the pure rule's answer");

    // The day page a manager opens, and the customer's own timeline, READ it and never offer the door.
    for (const path of ["src/components/phoenix-crm/day-detail-view.tsx", "src/components/phoenix-crm/customer-timeline.tsx"]) {
      assert.ok(source(path).includes("detailComment"), `${path} reads the write-up back`);
      assert.ok(!source(path).includes("<VisitDetailEdit"), `${path} is somebody else reading the visit — never a door into it`);
    }
    assert.ok(source("src/components/phoenix-crm/day-detail-view.tsx").includes("visitDetailEditedText"), "and the day page prints the marker");
    assert.ok(source("src/components/phoenix-crm/customer-timeline.tsx").includes("detailEditedAt"), "and so does the timeline");
  }

  // ── 10. It notifies nobody, in either direction ───────────────────────────────────────────────
  {
    const service = source("src/lib/phoenix-crm/server/visit-detail-edit.ts");
    assert.ok(!service.includes("notifyPhoenixCrm"), "a rep completing his own report is not a check on him");
    const sql = rawSource(MIGRATION);
    assert.ok(!sql.includes("phoenix_crm_notifications"), "and the function queues nothing");
    // The rep's stamp is HIS alone: the Super Admin's correction stays invisible to him.
    assert.ok(
      !source("src/lib/phoenix-crm/server/visit-edit.ts").includes("detail_edited_at"),
      "the Super Admin's door must never write the rep's stamp — his correction is told to nobody",
    );
  }

  console.log("phoenix-crm visit detail write-up: OK");
}
