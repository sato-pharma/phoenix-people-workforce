import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  approvalNeedsFullName,
  boardNamesOf,
  doctorFullNameProblem,
  doctorNamePartProblem,
  doctorNameWordCount,
  doctorNeedsFullName,
  FULL_NAME_APPROVE_AT,
  FULL_NAME_WRITE_BUTTON,
  FULL_NAME_WRITE_SENTENCE,
  fullNameMatchPercent,
  fullNameRuling,
  joinDoctorName,
  parseDoctorFullName,
  splitDoctorName,
  VALIDATION_FULL_NAME_CODE,
  validationNeedsFullName,
} from "@/lib/phoenix-crm/pm-name-rules";
import { reasonsFor } from "@/lib/phoenix-crm/validation-feedback";
import { parseNewCustomer, parseOutsideCustomer } from "@/lib/phoenix-crm/entry-rules";
import { buildDayCopyPlacements } from "@/lib/phoenix-crm/plan-copy";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";

/**
 * Owner, 2026-11-07 (pm-name-rules.ts): a clinic doctor's name is first, middle and last — three
 * required boxes, each a real name; any doctor on the list with one or two names is planned as normal
 * (owner, 2026-11-08) but never visited until the full name is written; the full name is held against his signboard — 60%+
 * saved, anything less waits for the Super Admin, never refused — "do not strict rejection or foolish
 * approvals", and "let a refused full name wait for my decision instead of blocking the rep".
 */

function checkEachBoxIsARealName(): void {
  assert.equal(doctorNamePartProblem("أحمد", "First name"), null);
  assert.equal(doctorNamePartProblem("Kamal", "Middle name"), null);
  // A compound written with a space is one name.
  assert.equal(doctorNamePartProblem("عبد العزيز", "Middle name"), null);
  assert.match(doctorNamePartProblem("", "First name") ?? "", /Write the first name/);
  assert.match(doctorNamePartProblem("د", "First name") ?? "", /without Dr/);
  assert.match(doctorNamePartProblem("أحمد كمال", "First name") ?? "", /one name/);
  assert.match(doctorNamePartProblem("Ahmed1", "First name") ?? "", /letters only/);
  assert.match(doctorNamePartProblem("sdfg", "Last name") ?? "", /does not look like a name/);
  assert.match(doctorNamePartProblem("ههه", "Last name") ?? "", /does not look like a name/);
  assert.match(doctorNamePartProblem("مستشفي", "Last name") ?? "", /names a place/);
  assert.match(doctorNamePartProblem("ا", "Last name") ?? "", /too short/);

  assert.equal(doctorFullNameProblem({ first: "أحمد", middle: "كمال", last: "حسن" }), null);
  assert.match(doctorFullNameProblem({ first: "أحمد", middle: "", last: "حسن" }) ?? "", /middle name/);
  assert.equal(joinDoctorName({ first: " أحمد ", middle: "كمال", last: "حسن" }), "أحمد كمال حسن");
}

function checkTheServerTakesThreeNamesForAClinicDoctor(): void {
  const parts = parseDoctorFullName({ first: "Ahmed", middle: "Kamal", last: "Hassan" }, "ignored");
  assert.deepEqual(parts, { ok: true, value: "Ahmed Kamal Hassan" });
  // A caller one release behind sends the whole name: three words pass, two never do.
  assert.equal(parseDoctorFullName(undefined, "Ahmed Kamal Hassan").ok, true);
  assert.equal(parseDoctorFullName(undefined, "Dr. Ahmed Kamal").ok, false);

  // PM: the three names; AM: the one name box as before.
  assert.equal(parseOutsideCustomer({ listType: "PM", name: "Omar" }).ok, false);
  assert.equal(parseOutsideCustomer({ listType: "PM", name: "Omar Hardan" }).ok, false);
  const pm = parseOutsideCustomer({ listType: "PM", name: "x", nameParts: { first: "Omar", middle: "Ali", last: "Hardan" } });
  assert.equal(pm.ok && pm.value.name, "Omar Ali Hardan");
  assert.equal(parseNewCustomer({ listType: "PM", name: "Tarek", proposedGrade: "A" }).ok, false);
  assert.equal(parseOutsideCustomer({ listType: "AM", name: "Al Salam Hospital" }).ok, true);
}

function checkTheEditOpensOnWhatHeWrote(): void {
  assert.deepEqual(splitDoctorName("د. أحمد محمد"), { first: "أحمد", middle: "", last: "محمد" });
  assert.deepEqual(splitDoctorName("Ahmed Kamal Hassan Ali"), { first: "Ahmed", middle: "Kamal", last: "Hassan Ali" });
  assert.deepEqual(splitDoctorName("عبد الله محمد سعيد"), { first: "عبد الله", middle: "محمد", last: "سعيد" });
  assert.deepEqual(splitDoctorName("طارق"), { first: "طارق", middle: "", last: "" });
}

function checkWhoIsBlocked(): void {
  const base = { listType: "PM", origin: "new", status: "active", name: "عمر حردان", fullNameHeld: null };
  assert.equal(doctorNeedsFullName(base), true);
  assert.equal(doctorNeedsFullName({ ...base, status: "pending" }), true, "every status, the owner's choice");
  assert.equal(doctorNeedsFullName({ ...base, name: "Dr. Omar Hardan" }), true, "the title is not a name");
  assert.equal(doctorNeedsFullName({ ...base, name: "عمر علي حردان" }), false);
  assert.equal(doctorNeedsFullName({ ...base, origin: "reference" }), true, "any doctor on the list, the iReports360 list too");
  assert.equal(doctorNeedsFullName({ ...base, listType: "AM" }), false);
  assert.equal(doctorNeedsFullName({ ...base, status: "dropped" }), false);
  assert.equal(doctorNeedsFullName({ ...base, fullNameHeld: "عمر علي حردان" }), false, "a name waiting for a decision unblocks him");
}

function checkTheBoardMatch(): void {
  // Counted over the words the board shows: a two-name plate matching both is 100%.
  assert.equal(fullNameMatchPercent("أحمد كمال حسن", ["أحمد كمال"]), 100);
  assert.equal(fullNameMatchPercent("Ahmed Kamal Hassan", ["Ahmed Kamal Hassan"]), 100);
  // A board showing one word cannot confirm three.
  assert.equal(fullNameMatchPercent("أحمد كمال حسن", ["أحمد"]), 50);
  // His father's and family name behind another given name never passes alone.
  assert.equal(fullNameMatchPercent("أحمد كمال حسن", ["محمد كمال حسن"]), 50);
  assert.equal(fullNameMatchPercent("أحمد كمال حسن", ["سامي فؤاد"]), 0);
  // The best board wins.
  assert.equal(fullNameMatchPercent("أحمد كمال حسن", ["سامي فؤاد", "أحمد كمال"]), 100);
  assert.equal(fullNameMatchPercent("أحمد كمال حسن", []), null);

  assert.equal(FULL_NAME_APPROVE_AT, 60);
  assert.equal(fullNameRuling(60, true), "save");
  assert.equal(fullNameRuling(60, false), "save");
  // Never refused (owner, 2026-11-07: "let a refused full name wait for my decision instead of blocking
  // the rep") — a misread sign scored her correct name 0%, and the refusal stranded her.
  for (const percent of [0, 39, 59]) {
    assert.equal(fullNameRuling(percent, true), "hold", `${percent}% on a validated doctor waits for the Super Admin`);
    assert.equal(fullNameRuling(percent, false), "hold", `${percent}% on a doctor not validated yet waits for the Super Admin`);
  }
  assert.equal(fullNameRuling(null, true), "hold", "a validated doctor with no board read waits for a person");
  assert.equal(fullNameRuling(null, false), "save", "his door will hold the name against the sign");

  assert.deepEqual(boardNamesOf({ personNames: ["أحمد كمال"], signText: "عيادة" }), ["أحمد كمال"]);
  assert.deepEqual(boardNamesOf({ signs: [{ personNames: ["Ahmed Kamal"] }] }), ["Ahmed Kamal"]);
  assert.deepEqual(boardNamesOf({ personNames: [], signText: "د أحمد كمال" }), ["د أحمد كمال"]);
  assert.deepEqual(boardNamesOf(null), []);
}

function checkTheRenameNeverRefusesABoardMismatch(): void {
  // The server's rename used to throw "This name does not match the name on the signboard…" under 40%.
  // A board-mismatch now waits for the Super Admin; only the format checks may still refuse.
  const source = readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("async function fullNameForRename(");
  assert.ok(start >= 0, "fullNameForRename is in list.ts");
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "fullNameForRename ends where the next function begins");
  const body = source.slice(start, end);
  assert.ok(!source.includes("FULL_NAME_REFUSED"), "list.ts names no board-mismatch refusal");
  assert.ok(!body.includes('=== "refuse"'), "fullNameForRename never refuses on the board match");
  assert.match(body, /if \(ruling === "hold"\) return \{ name: String\(current\.name\), hold:/, "a low match keeps the old name and waits");
}

function checkAShortNamedDoctorIsPlannedButNotVisited(): void {
  // Owner, 2026-11-08: reps could not save an edited plan because of a short-named doctor on it — the
  // plan works as it did before, and only the VISIT waits for the full name.
  const doctor = (customerId: string, needsFullName: boolean): PlannerCustomer => ({
    customerId,
    name: customerId,
    listType: "PM",
    grade: "A",
    speciality: null,
    visitsThisMonth: 0,
    pending: true,
    needsFullName,
    places: [],
  });
  const drafts = buildDayCopyPlacements(
    ["blocked", "named"],
    [doctor("blocked", true), doctor("named", false)],
    { date: "2026-11-09", listTypes: ["AM", "PM"], editable: true, items: [] },
    { amDailyCap: 5, pmDailyCap: 5 },
  );
  assert.deepEqual(
    drafts.map((draft) => draft.customerId),
    ["blocked", "named"],
    "a copy places a short-named doctor like any other",
  );
  const rules = readFileSync("src/lib/phoenix-crm/plan-rules.ts", "utf8");
  assert.ok(!rules.includes("fullNameNeededSentence"), "the plan save never refuses a short name");
  const panel = readFileSync("src/components/phoenix-crm/plan-day-panel.tsx", "utf8");
  assert.ok(panel.includes("return locked || (!row.placed && room[row.listType] <= 0);"), "the plan day ticks him on");
  for (const path of ["src/lib/phoenix-crm/plan-suggest.ts", "src/lib/phoenix-crm/suggestions.ts"]) {
    assert.ok(!readFileSync(path, "utf8").includes("if (customer.needsFullName) continue;"), `${path} suggests him`);
  }
  // The visit is still refused, at the server and on both of the rep's visit screens.
  const visits = readFileSync("src/lib/phoenix-crm/server/visits.ts", "utf8");
  assert.ok(visits.includes("throw validationError(fullNameNeededSentence(String(customer.name)));"), "the visit save refuses him");
  const picker = readFileSync("src/components/phoenix-crm/visit-customer-picker.tsx", "utf8");
  assert.ok(picker.includes("customer.needsFullName === true}"), "Add visit cannot pick him");
  const tab = readFileSync("src/components/phoenix-crm/visits-tab.tsx", "utf8");
  assert.ok(tab.includes("if (customer.needsFullName) return fullNameFirst(customer);"), "a planned visit asks for the full name first");
}

/** One function body out of a source file, from its signature to the next top-level close. */
function bodyOf(path: string, signature: string): string {
  const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is in ${path}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${signature} ends`);
  return source.slice(start, end);
}

function checkTheThreeNamesAreAskedAtValidation(): void {
  // Owner, 2026-11-07: "Don't accept from the beginning the two names. Must enter the three names."
  assert.equal(validationNeedsFullName({ listType: "PM", name: "سامي فؤاد" }), true, "two names on a clinic customer are asked for three");
  assert.equal(validationNeedsFullName({ listType: "PM", name: "سامي" }), true, "and one name too");
  assert.equal(validationNeedsFullName({ listType: "pm", name: "Dr. Sami Fouad" }), true, "the title is not a name");
  assert.equal(validationNeedsFullName({ listType: "PM", name: "سامي فؤاد منصور" }), false, "three names validate as before");
  assert.equal(validationNeedsFullName({ listType: "AM", name: "مستشفى السلام" }), false, "an AM place is never asked");
  assert.equal(validationNeedsFullName({ listType: "Pharmacy", name: "صيدلية" }), false, "nor a pharmacy");
  assert.equal(approvalNeedsFullName({ listType: "PM", customerName: "سامي فؤاد" }), true, "Place checks never approves a short name");
  assert.equal(approvalNeedsFullName({ listType: "PM", customerName: "سامي فؤاد منصور" }), false);
  assert.equal(approvalNeedsFullName({ listType: "AM", customerName: "عيادة" }), false);

  // The server: a short-named listed doctor sent without the three names is refused before any check or
  // write, with the code that returns the rep to the step holding the boxes.
  const asked = bodyOf("src/lib/phoenix-crm/server/list.ts", "function fullNameAtValidation(");
  assert.ok(asked.includes("validationNeedsFullName(subject)"), "asked only of a short-named clinic customer");
  assert.match(asked, /if \(!body\.nameParts[^\n]*throw validationError\(VALIDATION_FULL_NAME_MISSING, VALIDATION_FULL_NAME_CODE\)/, "no three names, no validation");
  assert.ok(asked.includes("parseDoctorFullName(body.nameParts, null)"), "each box is judged as a real name; a whole-name string never stands in");
  const validate = bodyOf("src/lib/phoenix-crm/server/list.ts", "export async function validateCustomer(");
  const askedAt = validate.indexOf("fullNameAtValidation(onListSubject, body)");
  assert.ok(askedAt > 0, "validateCustomer asks it");
  assert.ok(askedAt < validate.indexOf("refuseSeatingAwayFromBuilding("), "before the building distance is measured");
  assert.ok(askedAt < validate.indexOf("placePayload("), "and before the place row is built");
  // The full name is what the board is judged against, and it is saved with the validation, in one step.
  assert.match(validate, /onListSubject && fullName\s*\? \{ \.\.\.onListSubject, name: fullName \}/, "the signboard and the timetable read the full name");
  assert.ok(validate.includes("if (fullName) payload.full_name = fullName;"), "and the save carries it");

  // The database renames him inside the same validation, through the one rename door.
  const migration = readFileSync("supabase/migrations/20261107195700_phoenix_crm_three_names_at_validation.sql", "utf8");
  const renameAt = migration.indexOf("perform public.phoenix_crm_rename_customer(");
  assert.ok(renameAt > 0, "the validation renames through phoenix_crm_rename_customer");
  assert.ok(migration.lastIndexOf("v_mode in ('reference', 'listed')", renameAt) > 0, "only a customer already on the list");
  assert.ok(migration.slice(renameAt, renameAt + 600).includes("'allow_same_name', true"), "a namesake on the seat never refuses his own full name");

  // The rep's screen: the three boxes on the first step, sent only when asked, and the refusal returns there.
  const screen = readFileSync("src/components/phoenix-crm/list-screens.tsx", "utf8");
  assert.ok(screen.includes(`idPrefix="phoenix-crm-validate-name"`), "the validation screen draws the three boxes");
  assert.ok(screen.includes("const named = needsFullName ? { nameParts: fullParts } : {};"), "the three names travel only when asked");
  assert.match(screen, /code === VALIDATION_FULL_NAME_CODE\) \{\s*(\/\/[^\n]*\n\s*)*goStep\(1\)/, "a refusal takes him back to the names");
  assert.equal(VALIDATION_FULL_NAME_CODE, "phoenix_crm_full_name_needed");
}

function checkPlaceChecksSendsAShortNameBack(): void {
  // Owner, 2026-11-07, about the validations already waiting: "Send them back to the rep".
  assert.ok(reasonsFor("signboard").some((reason) => reason.key === "short_name"), "the refusal has a reason of its own");
  // Every approve path asks the server first.
  const decide = bodyOf("src/lib/phoenix-crm/server/validation-reviews.ts", "export async function decideValidationReview(");
  assert.ok(decide.includes(`if (decision === "approve") await refuseApprovalOfShortName(await reviewCustomerId(reviewId));`), "a held review");
  // 🔴 EXCEPT a rejection taken back, which is the Super Admin's alone and never blocked (owner, 2026-11-10,
  // "Both"): he approves as it stands, or corrects the name in the same press.
  const restore = bodyOf("src/lib/phoenix-crm/server/validation-reviews.ts", "export async function restoreValidation(");
  assert.ok(!restore.includes("refuseApprovalOfShortName"), "a rejection taken back is never refused for a short name");
  assert.ok(restore.includes("parseDoctorFullName(body.nameParts, null)"), "and a corrected name is held to the rep's own three-box rules");
  const approve = bodyOf("src/lib/phoenix-crm/server/validation-reviews.ts", "export async function approveValidatedPlace(");
  assert.ok(approve.includes("await refuseApprovalOfShortName(place.customer_id);"), "a place the system never questioned");
  const gate = bodyOf("src/lib/phoenix-crm/server/validation-reviews.ts", "async function refuseApprovalOfShortName(");
  assert.ok(gate.includes("approvalNeedsFullName({ listType: customer.list_type, customerName: customer.name })"), "on the customer's own row");
  assert.ok(gate.includes("throw validationError(APPROVAL_NEEDS_FULL_NAME, VALIDATION_FULL_NAME_CODE)"), "the gate refuses");

  // Every screen disables its Approve on the same rule, says why, and no bulk approve takes him.
  // Counted, so one approve losing its gate on a screen that has two still fails: the queue's Decision, a
  // seated customer's Decision, and the in-use place's Approve. The two take-backs left this count on
  // 2026-11-10 — they are the Super Admin's and never greyed out (place-check-restore.tsx).
  const approveButtons: ReadonlyArray<[string, number]> = [
    ["src/components/phoenix-crm/validation-review-queue.tsx", 1],
    ["src/components/phoenix-crm/shared-place-customers.tsx", 1],
    ["src/components/phoenix-crm/validated-place-list.tsx", 1],
  ];
  for (const [path, count] of approveButtons) {
    const source = readFileSync(path, "utf8");
    assert.equal(source.split("= approvalNeedsFullName(").length - 1, count, `${path} asks the rule on each approve`);
    assert.equal(source.split("|| shortName}").length - 1, count, `${path} disables each Approve`);
    assert.equal(source.split("{APPROVAL_NEEDS_FULL_NAME}").length - 1, count, `${path} says why beside each`);
  }
  const queue = readFileSync("src/components/phoenix-crm/validation-review-queue.tsx", "utf8");
  assert.ok(queue.includes(`takes: (row) => row.status === "pending" && !approvalNeedsFullName(row)`), "the waiting bulk approve skips him");
  assert.ok(queue.includes("takes: (row) => row.restorable,"), "the bulk take-back is the Super Admin's and takes him as he stands");
  const restoreScreen = readFileSync("src/components/phoenix-crm/place-check-restore.tsx", "utf8");
  assert.ok(!restoreScreen.includes("|| shortName}"), "the take-back is never disabled for a short name");
  assert.ok(restoreScreen.includes("Edit name"), "and offers Edit name beside it");
  assert.ok(queue.includes(`shortName ? "short_name"`), "the refusal opens on the short-name reason");
  const inUse = readFileSync("src/components/phoenix-crm/validated-place-list.tsx", "utf8");
  assert.ok(inUse.includes("takes: (row) => !approvalNeedsFullName(row)"), "the in-use bulk approve skips him");
}

function checkACompoundIsNeverSplitAcrossTwoBoxes(): void {
  // Proven in production, 8 Nov 2026: علاء / الدين / الجمل passed every box, was saved, counted as two
  // words, and blocked the doctor's visits for ever (seat SEAT-PED-REP-D15).
  const split = { first: "علاء", middle: "الدين", last: "الجمل" };
  assert.equal(doctorNameWordCount(joinDoctorName(split)), 2, "the saved name counts as two words");
  assert.match(doctorFullNameProblem(split) ?? "", /الدين is part of a two-word name like عماد الدين or عبد الله/, "علاء / الدين / الجمل is refused");
  assert.match(doctorNamePartProblem("الدين", "Middle name") ?? "", /Write the whole name in one box, then the father's name and the family name in the next two\./);
  assert.match(doctorNamePartProblem("الله", "Middle name") ?? "", /two-word name/);
  assert.match(doctorNamePartProblem("أبو", "First name") ?? "", /two-word name/, "a head alone too, however its alef is written");
  assert.match(doctorFullNameProblem({ first: "عبد", middle: "الله", last: "علي" }) ?? "", /عبد is part of a two-word name/, "عبد / الله / x is refused");
  // The whole compound in one box is one name, and the full name passes.
  assert.equal(doctorFullNameProblem({ first: "علاء الدين", middle: "محمد", last: "الجمل" }), null, "علاء الدين / محمد / الجمل passes");
  assert.equal(doctorNamePartProblem("عبد الله", "First name"), null);
  assert.equal(doctorNamePartProblem("نور الدين", "First name"), null);
  assert.equal(doctorFullNameProblem({ first: "عماد الدين", middle: "احمد", last: "سالم" }), null);
  // The joined name is counted again: an open compound in the first box swallows the middle name, so
  // every box passes on its own and the saved name would still be two words.
  const swallowed = { first: "عبد ابو", middle: "محمد", last: "علي" };
  assert.equal(doctorNamePartProblem(swallowed.first, "First name"), null, "the box alone passes");
  assert.equal(doctorNameWordCount(joinDoctorName(swallowed)), 2);
  assert.equal(doctorFullNameProblem(swallowed), "Write the first, middle and last name.", "a joined two-word name is refused");
  assert.equal(parseDoctorFullName(split, null).ok, false, "the server refuses it too");
}

function checkAddVisitOffersTheWayToTheFullName(): void {
  // Owner, 2026-11-09: the note repeated the name and offered no way out. Its title is the name,
  // isolated; its body is the fix; the button opens the List on the customer's Change the details.
  const tab = readFileSync("src/components/phoenix-crm/visits-tab.tsx", "utf8").replace(/\r\n/g, "\n");
  const note = tab.slice(tab.indexOf("const fullNameFirst = "), tab.indexOf("// 🔴 A REP THE SUPER ADMIN SWITCHED ON"));
  assert.ok(note.includes("<CrmNote title={bidiIsolate(customer.name)} tone=\"warn\">"), "the title is the name, bidi-isolated");
  assert.ok(note.includes("{FULL_NAME_WRITE_SENTENCE}"), "the body says what to write");
  assert.ok(!note.includes("fullNameNeededSentence"), "the note no longer repeats the name");
  assert.ok(note.includes("<CrmButton onClick={() => onWriteFullName(customer.customerId)} variant=\"primary\">"), "a primary button");
  assert.ok(note.includes("{FULL_NAME_WRITE_BUTTON}"), "the button's words");
  assert.equal(FULL_NAME_WRITE_BUTTON, "Write the full name");
  assert.match(FULL_NAME_WRITE_SENTENCE, /first, middle and last name, as the signboard shows them, and the visit opens\./);
  assert.ok(!/\b(accounts?|doctors?)\b/i.test(FULL_NAME_WRITE_SENTENCE + FULL_NAME_WRITE_BUTTON), "the screen words obey the AM · PM rule");
  assert.ok(tab.includes("onWriteFullName({ seatId, test, customerId });"), "the tab hands the customer to the page");

  // The page: the Validate hand-off's sibling, carried as ?fullname= in single-page mode.
  const app = readFileSync("src/components/phoenix-crm/phoenix-crm-app.tsx", "utf8");
  assert.ok(app.includes("onWriteFullName={startWriteFullName}"), "the page listens");
  assert.ok(app.includes(`openTab("list", { fullname: handoff.customerId });`), "single mode carries it in the address");
  assert.ok(app.includes(`searchParams?.get("fullname")`), "and reads it back");
  assert.ok(app.includes("pendingFullName={arrivedFullName ?? pendingFullName}"), "the List receives it");
  assert.ok(app.includes("onPendingFullNameDone={pendingFullNameDone}"), "and can let it go");
  assert.ok(app.includes("pendingFullName.seatId !== nextListSeat"), "a territory change drops it");

  // The List: the hand-off opens Change the details on that customer, and go() releases it.
  const list = readFileSync("src/components/phoenix-crm/list-tab.tsx", "utf8");
  assert.ok(list.includes(`? { name: "edit-details", customerId: fullNameHandoff.customerId }`), "the List opens on Change the details");
  assert.ok(list.includes("if (fullNameHandoff) onPendingFullNameDone?.();"), "moving anywhere ends the hand-off");
  assert.ok(list.includes("pendingFullName.seatId === seatId && pendingFullName.test === test"), "one territory, one world");
}

function checkANameWrittenTwiceIsRefused(): void {
  // Owner, 2026-11-10: "مصطفي مصطفي شلش" was validated off a sign reading "دكتور مصطفى شلش" — "block later
  // validations like this example mostafa mostafa shalaby … mostafa shalaby shalaby blocked".
  const twice = (first: string, middle: string, last: string) => doctorFullNameProblem({ first, middle, last }) ?? "";
  assert.match(twice("مصطفى", "مصطفي", "شلبي"), /is written twice/, "the first name copied into the middle box is refused, ى and ي alike");
  assert.match(twice("مصطفى", "شلبي", "شلبي"), /is written twice/, "and the family name copied into the middle box");
  assert.match(twice("مصطفى", "شلبي", "الشلبي"), /is written twice/, "with or without its ال it is the same name");
  assert.match(twice("أحمد", "احمد", "سعيد"), /is written twice/, "أ and ا alike");
  assert.match(twice("عبد الله", "عبدالله", "سعيد"), /is written twice/, "a compound written twice too");
  assert.match(twice("على", "محمد", "محمد"), /is written twice/, "محمد is let through as the first and middle name only");
  assert.equal(twice("محمد", "محمد", "عيسى"), "", "محمد محمد as first and middle name is a real name (owner chose \"Block all but محمد محمد\")");
  assert.equal(twice("حسن", "محمد", "حسن"), "", "a son named after his grandfather is not side by side, and stays a name");
  assert.equal(twice("مصطفى", "كامل", "شلبي"), "", "three different names pass as before");
  assert.ok(!/\b(accounts?|doctors?)\b/i.test(twice("مصطفى", "مصطفى", "شلبي")), "the screen words obey the AM · PM rule");

  // The server takes the same answer, from the three boxes and from a caller one release behind.
  assert.equal(parseDoctorFullName({ first: "مصطفى", middle: "مصطفى", last: "شلبي" }, null).ok, false, "the boxes are refused on the server");
  assert.equal(parseDoctorFullName(null, "مصطفى شلبي شلبي").ok, false, "and a whole name too");
  assert.equal(parseDoctorFullName(null, "محمد محمد عيسى").ok, true, "محمد محمد still saves");

  // A doctor already on the list under a doubled name is asked for the three names at his next
  // validation, and Place checks never approves him — sent back, the boxes open on what is there.
  assert.equal(validationNeedsFullName({ listType: "PM", name: "مصطفي مصطفي شلش" }), true, "the doubled name is asked for again");
  assert.equal(validationNeedsFullName({ listType: "PM", name: "ياسر الدغيدي الدغيدي" }), true, "a doubled family name too");
  assert.equal(validationNeedsFullName({ listType: "PM", name: "محمد محمد عيسى" }), false, "محمد محمد validates as before");
  assert.equal(validationNeedsFullName({ listType: "AM", name: "مستشفى مستشفى" }), false, "an AM place is never asked");
  assert.equal(approvalNeedsFullName({ listType: "PM", customerName: "اسامه اسامه يونس" }), true, "Place checks sends it back");
}

export function runPhoenixCrmDoctorFullNameTests(): void {
  checkANameWrittenTwiceIsRefused();
  checkACompoundIsNeverSplitAcrossTwoBoxes();
  checkAddVisitOffersTheWayToTheFullName();
  checkTheThreeNamesAreAskedAtValidation();
  checkPlaceChecksSendsAShortNameBack();
  checkEachBoxIsARealName();
  checkTheServerTakesThreeNamesForAClinicDoctor();
  checkTheEditOpensOnWhatHeWrote();
  checkWhoIsBlocked();
  checkTheBoardMatch();
  checkTheRenameNeverRefusesABoardMismatch();
  checkAShortNamedDoctorIsPlannedButNotVisited();
}
