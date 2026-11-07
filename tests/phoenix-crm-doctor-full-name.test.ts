import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
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
} from "@/lib/phoenix-crm/pm-name-rules";
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

export function runPhoenixCrmDoctorFullNameTests(): void {
  checkEachBoxIsARealName();
  checkTheServerTakesThreeNamesForAClinicDoctor();
  checkTheEditOpensOnWhatHeWrote();
  checkWhoIsBlocked();
  checkTheBoardMatch();
  checkTheRenameNeverRefusesABoardMismatch();
  checkACopyNeverPlacesABlockedDoctor();
}
