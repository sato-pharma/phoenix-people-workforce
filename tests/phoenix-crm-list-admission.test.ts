import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as listRules from "../src/lib/phoenix-crm/list-request-rules.ts";
import type { PhoenixCrmRequestKind } from "../src/lib/phoenix-crm/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a customer's life on the rep's list (owner, 2026-09-29, the rep's flow rebuilt).
 *
 *   iReports360 row ─▶ pending ──Validate──▶ active (on the list)
 *                                              └ Ask to drop ─▶ [manager ▶ SFE] ─▶ Archive
 *   Out of list / Add new customer (validated at the door) ─▶ outside
 *      ├ Request to add ─▶ [manager: A/B/C + potential ▶ SFE] ─▶ active
 *      └ Drop (the rep, no approval) ─▶ Archive
 *   Archive ─▶ Ask to bring back ─▶ [manager ▶ SFE] ─▶ active, or pending if never validated
 *            · a customer who was never admitted shows "Request to add" instead
 *
 * Two halves, because it breaks in two places:
 *
 *   1. THE RULE (`src/lib/phoenix-crm/list-request-rules.ts`) — which section a customer sits in, the
 *      ONE button his row carries, and the list moves his page offers. Every screen reads these; a
 *      wrong answer here offers a step the database then refuses, or hides one the rep needs.
 *   2. THE SCREENS — which fail silently: put "Add a visit" back on a row, or a second button, and
 *      every screen still renders, every save still works, and the owner's "Validate or Open —
 *      nothing else" is simply gone. So the screens are pinned to the rule by source.
 *
 * Plus the database's two refusals the manager's card depends on.
 */

type Rules = typeof listRules;
type Facts = listRules.ListCustomerFacts;

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function raw(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

const fact = (status: Facts["status"], origin: Facts["origin"] = "reference", validatedAt: string | null = null): Facts => ({
  status,
  origin,
  validatedAt,
});

/** No request waiting on the customer. */
const none: ReadonlySet<PhoenixCrmRequestKind> = new Set();

/** The rule itself. Takes the module so a check can be proven to fire against a broken copy. */
export function checkListAdmissionRules(rules: Rules = listRules): void {
  // ── Every status has exactly one section ──────────────────────────────────────────────────────
  assert.equal(rules.listSectionOf(fact("pending")), "to_validate", "a carried-over customer waits under To validate");
  assert.equal(rules.listSectionOf(fact("active", "reference", "2026-09-01T09:00:00Z")), "your_list", "a validated customer is on Your list");
  assert.equal(rules.listSectionOf(fact("outside", "new")), "outside", "a customer met at the door waits Outside the list");
  assert.equal(rules.listSectionOf(fact("dropped")), "archive", "a dropped customer is in the Archive");

  // ── One button per row: Validate while not validated, Open once he is ────────────────────────
  assert.equal(rules.listRowAction(fact("pending")), "validate", "a customer not validated yet offers Validate");
  for (const status of ["active", "outside", "dropped"] as const) {
    assert.equal(rules.listRowAction(fact(status, "new")), "open", `a ${status} customer offers Open — never Validate, never a visit`);
  }

  // ── The moves each customer's page offers ─────────────────────────────────────────────────────
  assert.deepEqual(
    rules.listMovesFor(fact("outside", "new"), none),
    ["request_add", "drop_outside"],
    "a customer outside the list is asked to be added, or dropped to the Archive by the rep himself",
  );
  assert.deepEqual(rules.listMovesFor(fact("outside", "new"), new Set(["add"] as const)), [], "an add already waiting is never offered twice");
  assert.deepEqual(rules.listMovesFor(fact("active", "reference", "2026-09-01T09:00:00Z"), none), ["ask_to_drop"], "a listed customer can be asked to be dropped");
  assert.deepEqual(rules.listMovesFor(fact("pending"), none), ["ask_to_drop"], "so can one not validated yet");
  assert.deepEqual(rules.listMovesFor(fact("active", "reference", "2026-09-01T09:00:00Z"), new Set(["drop"] as const)), [], "a drop already waiting is never offered twice");
  assert.deepEqual(
    rules.listMovesFor(fact("dropped", "reference", "2026-09-01T09:00:00Z"), none),
    ["ask_to_bring_back"],
    "a customer who left the list is asked back",
  );
  assert.deepEqual(
    rules.listMovesFor(fact("dropped", "new", null), none),
    ["request_add"],
    "a customer in the Archive who was NEVER admitted is asked to be added — never brought back to a list he was never on",
  );
  assert.ok(!rules.listMovesFor(fact("dropped", "new", null), none).includes("ask_to_bring_back"), "a never-admitted customer is not offered a bring-back");
  assert.deepEqual(
    rules.listMovesFor(fact("dropped", "new", "2026-09-01T09:00:00Z"), none),
    ["ask_to_bring_back"],
    "a new customer who WAS admitted and then dropped is brought back like anyone else",
  );
  assert.deepEqual(rules.listMovesFor(fact("dropped"), new Set(["restore"] as const)), [], "a bring-back already waiting is never offered twice");
  assert.equal(rules.neverAdmitted(fact("dropped", "new", null)), true);
  assert.equal(rules.neverAdmitted(fact("dropped", "reference", null)), false, "a carried-over customer was on the list from day one");

  // ── Two steps for everything but a grade ──────────────────────────────────────────────────────
  assert.equal(rules.isTwoStepKind("grade"), false, "a grade change stays the district manager's one step");
  for (const kind of ["drop", "add", "restore"] as const) {
    assert.equal(rules.isTwoStepKind(kind), true, `a ${kind} goes to the district manager, then SFE`);
  }
  assert.equal(rules.firstRequestStage(true), "manager", "a territory with a manager starts with him");
  assert.equal(rules.firstRequestStage(false), "sfe", "a territory with no manager seat starts at SFE");
  assert.equal(rules.nextRequestStage("manager"), "sfe", "the district manager's approval hands it to SFE");
  assert.equal(rules.nextRequestStage("sfe"), null, "SFE's step is the last");
  assert.equal(rules.nextRequestStage(null), null);

  // ── The words the stage pill and the card use ─────────────────────────────────────────────────
  assert.equal(rules.requestStageLabel("manager"), "Waiting for the district manager");
  assert.equal(rules.requestStageLabel("sfe"), "Waiting for SFE");
  assert.equal(rules.requestStageLabel(null), null, "a decided request carries no stage");
  assert.equal(rules.requestKindLabel("grade"), "Grade change");
  assert.equal(rules.requestKindLabel("drop"), "Drop from the list");
  assert.equal(rules.requestKindLabel("add"), "Add to the list");
  assert.equal(rules.requestKindLabel("restore"), "Bring back to the list");
  assert.equal(rules.archiveReasonLabel("not_added"), "Dropped instead of added to your list");
  assert.equal(rules.archiveReasonLabel("not_admitted"), "Adding this customer to your list was not approved");
  assert.equal(rules.archiveReasonLabel("moved"), null, "a drop reason is labelled by the drop reasons, not the Archive's own");
}

const LIST_SCREENS = [
  "src/components/phoenix-crm/list-tab.tsx",
  "src/components/phoenix-crm/list-screens.tsx",
  "src/components/phoenix-crm/list-customer.tsx",
  "src/components/phoenix-crm/customer-list-board.tsx",
] as const;

/** The screens, pinned to the rule by source. */
export function checkListAdmissionScreens(): void {
  // ── 1. No "Add visit" anywhere on the List ─────────────────────────────────────────────────────
  for (const path of LIST_SCREENS) {
    const source = read(path);
    assert.doesNotMatch(
      source,
      /\bAdd (?:a |today(?:'|&apos;)s )?visit\b/i,
      `${path} offers a visit — a visit starts from Visits, Today or the portal's "+", never from the List (owner, 2026-09-29)`,
    );
    assert.doesNotMatch(source, /\bonStartVisit\s*\(/, `${path} starts a visit`);
    assert.doesNotMatch(source, /\bonVisitCustomer\b/, `${path} still wires a visit onto a customer`);
  }

  // ── 2. One button per row, drawn from the rule ────────────────────────────────────────────────
  const board = read("src/components/phoenix-crm/customer-list-board.tsx");
  assert.match(board, /const action = listRowAction\(customer\);/, "the row's button comes from listRowAction, never a rule of its own");
  assert.match(
    board,
    /if \(action === "validate" && \(!canValidate \|\| customer\.referenceContactCrmId === null\)\) return "open";/,
    "only the territory's rep validates; anyone else is offered Open on the same row",
  );
  assert.doesNotMatch(board, /\browActions\s*[:?]/, "a section can no longer hand the row buttons of its own");
  assert.equal(
    (board.match(/<CustomerRowAction\b/g) ?? []).length,
    1,
    "the card and the table both draw the one CustomerRowAction, through one helper",
  );
  assert.match(board, /actions=\{rowAction\(customer\)\}/, "the phone card carries the one button");
  assert.match(board, /\[&>button\]:w-full">\{rowAction\(customer\)\}/, "and so does the desktop table");

  const tab = read("src/components/phoenix-crm/list-tab.tsx");
  // The board the owner kept ("The list"): its customer rows carry the same one button, its pharmacy
  // rows none at all.
  assert.match(tab, /<CustomerRowAction canValidate=\{view\.canEdit\} customer=\{customer\} onAction=\{onRowAction\} \/>/, "The list board's customer rows carry the one button");
  assert.match(tab, /row\.listType === "Pharmacy" \? "Pharmacy · not on the CRM list"/, "its pharmacy rows stay read-only");

  // ── 3. The sections come from the server's `section`, never re-derived from a status ──────────
  for (const section of ["to_validate", "your_list", "outside", "archive"]) {
    assert.ok(tab.includes(`customer.section === "${section}"`), `the ${section} part lists the customers the server put there`);
  }
  for (const label of ["The list", "To validate", "Your list", "Outside the list", "Requests", "Archive", "Timetable"]) {
    assert.ok(tab.includes(`label: "${label}"`), `the List home offers ${label}`);
  }
  assert.match(
    tab,
    /onOpen\(\{ name: "new" \}\)\} variant="primary">\s*<Plus aria-hidden className="h-4 w-4" \/>\s*Add new customer\s*<\/CrmButton>/,
    "Add new customer stays on the List home, for the rep",
  );

  // ── 4. The customer's page offers the moves listMovesFor decides, nothing re-derived ──────────
  const screens = read("src/components/phoenix-crm/list-screens.tsx");
  assert.match(screens, /return listMovesFor\(customer, waitingKinds\(customer\)\);/, "the moves are the pure rule's");
  const customerPage = read("src/components/phoenix-crm/list-customer.tsx");
  assert.match(customerPage, /const moves = view\.canEdit \? movesOf\(customer\) : \[\];/, "the customer's page reads the moves from the rule, for the rep only");
  for (const [move, what] of [
    ["request_add", "Ask to add to your list"],
    ["ask_to_bring_back", "Ask to bring back"],
    ["drop_outside", "Drop"],
    ["ask_to_drop", "Ask to drop"],
  ] as const) {
    assert.ok(customerPage.includes(`moves.includes("${move}")`), `the page offers ${what} only where the rule says ${move}`);
  }
  assert.ok(customerPage.includes('"/api/phoenix-crm/list/outside/drop"'), "dropping an outside customer goes to the Archive through its own route");
  assert.ok(screens.includes('kind: "add"') && screens.includes('kind: "restore"'), "ask to add and ask to bring back are requests");
  // The rep no longer removes a clinic: that is a change of WHERE the customer is, the movers' alone.
  assert.doesNotMatch(customerPage, /places\/update"[^;]*action: "retire"/, "the rep's page never removes a clinic");

  // ── 5. Validate carries BOTH readings, and the rep never reads how well ───────────────────────
  const editor = read("src/components/phoenix-crm/place-editor.tsx");
  const payload = /export function placePayload\([\s\S]*?\n\}/.exec(editor);
  assert.ok(payload, "the place payload is built in one place");
  for (const key of ["shutterLat: photo.shutterLat", "shutterLon: photo.shutterLon", "shutterAccuracyMeters: photo.shutterAccuracyMeters", "shutterCapturedAt: photo.shutterCapturedAt"]) {
    assert.ok(payload[0].includes(key), `the photo's own reading travels with the place (${key.split(":")[0]}, read by parseCapturedFix)`);
  }
  assert.doesNotMatch(payload[0], /shutter\w*: [^,\n]*\?\?/, "a missing photo reading is sent as null — never a copy of the pin");
  const camera = read("src/components/phoenix-crm/live-photo-capture.tsx");
  assert.doesNotMatch(camera, /Location is rough|Location found \(|accuracyText|formatDistance/, "the capture tells the rep nothing about how good his reading is");
  assert.match(camera, />Photo location found<\/span>/, "a plain \"Photo location found\" is what he reads while the camera is open");
  assert.match(
    camera,
    /return address \? `Photo location · \$\{address\}` : "Photo location found";/,
    "and once the photo is taken — where, never how well",
  );
  assert.match(camera, /\{photoLocationText\(value\.address\)\}/, "the taken photo shows that line and no other reading");

  // ── 5b. The place is read TWICE, by two acts (owner, 2026-09-30) ──────────────────────────────
  // "a live capture photo with its own location and a capture location button to capture the same
  // location twice once by photo and the other by gps". The photo carries the camera's reading; the
  // pin is its own button, read fresh — never the camera's, never a copy of the photo's.
  assert.doesNotMatch(camera, /Start camera and location/, "the camera no longer claims to take the location for the place");
  assert.match(camera, /const photoFix: Fix = hasPosition\(shutterFix\)/, "the photo's reading is the fresh shutter read, else the camera's own");
  assert.match(camera, /shutterFix: \{ latitude: photoFix\.lat, longitude: photoFix\.lon, accuracy: photoFix\.accuracyMeters \}/, "and it is what the photo carries to the server");
  assert.match(camera, /fetchEvidenceLocation\(LOCATION_ENDPOINT, usedFix\.lat, usedFix\.lon, null\)/, "the picture is stamped with the camera's own reading and its own time");
  const button = read("src/components/phoenix-crm/capture-location.tsx");
  assert.match(button, /\{busy \? "Capturing the location" : "Capture location"\}/, "the pin is its own Capture location button");
  assert.match(button, /maximumAge: 0/, "read fresh — never the reading the camera already holds");
  assert.match(button, />Location captured<\/span>/, "and he reads \"Location captured\"");
  assert.doesNotMatch(button, /accuracyMeters\}|within|meters away|formatDistance/, "never how good it is, or how far it is from the photo's");
  assert.match(payload[0], /lat: draft\.pin \? draft\.pin\.lat : null,/, "the payload's pin is the button's reading");
  assert.doesNotMatch(payload[0], /lat: photo\.lat/, "never the photo's reading passed off as the pin");
  assert.match(editor, /if \(options\.needsPhoto && !draft\.pin\) return "Press Capture location while you stand at the clinic\.";/, "no pin, no validation");
  assert.match(editor, /title=\{`\$\{pinStep\} · Capture location`\}/, "a step of its own on the screen, after the photo");

  // ── 6. The manager's card: stage, grade and potential ─────────────────────────────────────────
  const card = read("src/components/phoenix-crm/request-card.tsx");
  const decide = /"\/api\/phoenix-crm\/list\/requests\/decide",\s*\{([\s\S]*?)\},\s*"request"/.exec(card);
  assert.ok(decide, "the card decides through the one route");
  assert.match(decide[1], /\bapprovedGrade:/, "an add's approval sends the A/B/C the district manager confirmed");
  assert.match(decide[1], /\bpotentialGrade:/, "and the potential he set");
  assert.match(decide[1], /\bstage: request\.stage\b/, "and the step the card was showing, so two deciders cannot both decide it");
  assert.match(card, /const decides = pending && canDecide && request\.canDecide;/, "Approve and Refuse are offered only where the server says this viewer decides this step");
  // The grading step of an add is the district manager's — and SFE's where the territory has no manager
  // at all (owner's pick, 2026-10-02), which is the only reason this is a shared rule and not a literal
  // `stage === "manager"` here. `setsAdmissionGrades` is pinned by tests/phoenix-crm-list-edges.test.ts.
  assert.match(
    card,
    /setsAdmissionGrades\(\{ kind: request\.kind, stage: request\.stage, managerDecidedAt: request\.managerDecision\?\.at \?\? null \}\)/,
    "the grade and potential are asked of whoever takes the grading step of an add",
  );
  assert.match(card, /POTENTIAL_GRADES\.map/, "the potential is chosen from AA to BC");
  assert.match(
    card,
    /const MOVED_ON = new Set\(\["phoenix_crm_request_decided", "phoenix_crm_request_wrong_stage"\]\);/,
    "a request that moved on reloads the list like one already decided",
  );
  assert.match(card, /if \(code && MOVED_ON\.has\(code\)\) \{/, "and the card acts on both answers");
  assert.ok(card.includes("Approved — now waiting for SFE"), "the district manager is told the request moved on to SFE");

  // ── 7. The database's refusals the card and the screens depend on ─────────────────────────────
  const migration = raw("supabase/migrations/20260929235106_phoenix_crm_list_admission.sql");
  assert.match(migration, /raise exception 'phoenix_crm:potential_grade_required';/, "an add cannot pass the district manager without a potential");
  assert.match(migration, /raise exception 'phoenix_crm:request_wrong_stage';/, "a decision on a step that already moved on is refused");
}

export function runPhoenixCrmListAdmissionTests(): void {
  checkListAdmissionRules();
  checkListAdmissionScreens();
}
