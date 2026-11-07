import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  approvalNeedsFullName,
  boardNamesOf,
  doctorFullNameProblem,
  doctorNamePartProblem,
  doctorNeedsFullName,
  FULL_NAME_APPROVE_AT,
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
 * required boxes, each a real name; any doctor on the list with one or two names is blocked from the plan
 * and Add visit until the full name is written; the full name is held against his signboard — 60%+
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

function checkACopyNeverPlacesABlockedDoctor(): void {
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
    ["named"],
  );
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
  const restore = bodyOf("src/lib/phoenix-crm/server/validation-reviews.ts", "export async function restoreValidation(");
  assert.ok(restore.includes("await refuseApprovalOfShortName(await reviewCustomerId("), "a rejection taken back");
  const approve = bodyOf("src/lib/phoenix-crm/server/validation-reviews.ts", "export async function approveValidatedPlace(");
  assert.ok(approve.includes("await refuseApprovalOfShortName(place.customer_id);"), "a place the system never questioned");
  const gate = bodyOf("src/lib/phoenix-crm/server/validation-reviews.ts", "async function refuseApprovalOfShortName(");
  assert.ok(gate.includes("approvalNeedsFullName({ listType: customer.list_type, customerName: customer.name })"), "on the customer's own row");
  assert.ok(gate.includes("throw validationError(APPROVAL_NEEDS_FULL_NAME, VALIDATION_FULL_NAME_CODE)"), "the gate refuses");

  // Every screen disables its Approve on the same rule, says why, and no bulk approve takes him.
  // Counted, so one approve losing its gate on a screen that has two still fails: the queue's Decision and
  // Restore, a seated customer's Decision and take-back, and the in-use place's Approve.
  const approveButtons: ReadonlyArray<[string, number]> = [
    ["src/components/phoenix-crm/validation-review-queue.tsx", 2],
    ["src/components/phoenix-crm/shared-place-customers.tsx", 2],
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
  assert.ok(queue.includes("takes: (row) => row.restorable && !approvalNeedsFullName(row)"), "and so does the bulk take-back");
  assert.ok(queue.includes(`shortName ? "short_name"`), "the refusal opens on the short-name reason");
  const inUse = readFileSync("src/components/phoenix-crm/validated-place-list.tsx", "utf8");
  assert.ok(inUse.includes("takes: (row) => !approvalNeedsFullName(row)"), "the in-use bulk approve skips him");
}

export function runPhoenixCrmDoctorFullNameTests(): void {
  checkTheThreeNamesAreAskedAtValidation();
  checkPlaceChecksSendsAShortNameBack();
  checkEachBoxIsARealName();
  checkTheServerTakesThreeNamesForAClinicDoctor();
  checkTheEditOpensOnWhatHeWrote();
  checkWhoIsBlocked();
  checkTheBoardMatch();
  checkTheRenameNeverRefusesABoardMismatch();
  checkACopyNeverPlacesABlockedDoctor();
}
