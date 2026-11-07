import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { emailKeepsLineBreaks } from "@/lib/notifications/attendance-digest-channels";
import {
  formatOutstationDescriptionInline,
  formatOutstationDescriptionText,
  humanizeOutstationCode,
  parseOutstationDescription,
  tidyOutstationAddress,
} from "@/lib/outstation/description-format";

const DASHBOARD = "src/components/employee-portal/personal-expense-workload-dashboard.tsx";
const SERVICE = "src/lib/outstation/service.ts";

/**
 * An outstation request's description, as people read it. `service.ts` appends a machine audit
 * line to the employee's own note — `Car live evidence: source=live_camera hr_id=B-119
 * captured_at=2026-09-19T09:33:25.968Z location=… gps=31.19,29.91 draft_id=<uuid> request_id=153` —
 * and the Expense Dashboard, its spreadsheet and the emails printed that string as it was. The owner
 * (2026-09-21): the description "must be tidied and premium polished".
 *
 * The stored text is not changed (other readers parse it); every display goes through
 * `parseOutstationDescription`. These cases are real production strings, both shapes: the request's
 * `notes` (newline-separated) and the expense row's `description` (newlines collapsed to spaces).
 */

const ALEX_CAR =
  "Car live evidence: source=live_camera hr_id=B-119 captured_at=2026-09-19T09:33:25.968Z " +
  "location=40 Ahmed Mohammed Ismail St, Moharram Bek, Alexandria Governorate 5413426, Egypt · Brick محرم بك · " +
  "Area Alex West · Region Alex-BHR gps=31.1956674,29.9139614 " +
  "draft_id=b45c0953-2900-40f3-a147-fc46b3d72dc0 request_id=153";

const MACHINE_TOKENS = [/source=/, /hr_id=/, /captured_at=/, /location=/, /gps=/, /draft_id=/, /request_id=/, /live_camera/, /\d{4}-\d{2}-\d{2}T/];

function assertNoMachineText(text: string, what: string) {
  for (const token of MACHINE_TOKENS) {
    assert.ok(!token.test(text), `${what} still shows machine text ${token}: ${JSON.stringify(text)}`);
  }
}

export function runOutstationDescriptionFormatTests() {
  // 1. The evidence line alone becomes a stamp: Cairo time (UTC+3 in September), clean address,
  //    territory, and a map link built from the coordinates. No codes, no UUID, no raw key=value.
  const alex = parseOutstationDescription(ALEX_CAR);
  assert.equal(alex.note, null, "an evidence-only description has no note of the employee's own");
  assert.equal(alex.evidence.length, 1);
  const [stamp] = alex.evidence;
  assert.equal(stamp.title, "Car photo");
  assert.equal(stamp.sourceLabel, "taken live in the app");
  assert.equal(stamp.capturedAtLabel, "19 Sept 2026 · 12:33", "09:33 UTC is 12:33 in Cairo in September");
  assert.equal(stamp.place, "40 Ahmed Mohammed Ismail St, Moharram Bek, Alexandria Governorate");
  assert.equal(stamp.brick, "محرم بك");
  assert.equal(stamp.area, "Alex West");
  assert.equal(stamp.region, "Alex-BHR");
  assert.equal(stamp.mapUrl, "https://www.google.com/maps?q=31.1956674,29.9139614");
  assertNoMachineText(formatOutstationDescriptionText(ALEX_CAR), "the plain-text description");
  assert.ok(!formatOutstationDescriptionText(ALEX_CAR).includes("B-119"), "the HR id is not shown");

  // 2. The expense row's flattened shape: the note, the allowance guard and the evidence all run
  //    on one line. Each is still found, in order, and the note keeps only the employee's words.
  const flattened =
    "Business review Allowance guard: No allowance: a trip to Cairo from a regional base does not earn an " +
    "outstation per-diem allowance. Arrival photo evidence: source=upload hr_id=B-76 " +
    "captured_at=2026-09-08T09:21:12.018Z location=492J+HRF, Sheraton Al Matar, El Nozha, Cairo Governorate " +
    "4471430, Egypt · Brick مساكن شيراتون · Area Heliopolis · Region Cairo gps=30.101379,31.3824444 " +
    "draft_id=78951f38-f407-4e57-b842-872636ad179c request_id=130";
  const flat = parseOutstationDescription(flattened);
  assert.equal(flat.note, "Business review");
  assert.deepEqual(flat.allowanceNotices, [
    "No allowance — a trip to Cairo from a regional base does not earn an outstation per-diem allowance.",
  ]);
  assert.equal(flat.evidence[0]?.title, "Arrival photo");
  assert.equal(flat.evidence[0]?.sourceLabel, "uploaded");
  assert.equal(flat.evidence[0]?.place, "Sheraton Al Matar, El Nozha, Cairo Governorate", "plus code, postcode and Egypt dropped");
  assert.equal(
    formatOutstationDescriptionText(flattened),
    [
      "Business review",
      "No allowance — a trip to Cairo from a regional base does not earn an outstation per-diem allowance.",
      "Arrival photo, uploaded — 08 Sept 2026 · 12:21",
      "Sheraton Al Matar, El Nozha, Cairo Governorate",
      "Brick مساكن شيراتون · Area Heliopolis · Region Cairo",
    ].join("\n"),
  );
  assertNoMachineText(formatOutstationDescriptionInline(flattened), "the spreadsheet cell");

  // 3. The request's newline shape, with an Arabic note, gives the same parts.
  const arabic = parseOutstationDescription(
    "كارتة رايح جاي ٣٠\nCar live evidence: source=live_camera hr_id=A-7 captured_at=2026-09-09T07:31:55.910Z " +
      "location=FWCH+G9W, Al Mostashfa, Madinet Menuf, Menouf City, Menofia Governorate 6052432, Egypt · Brick منوف · " +
      "Area Menoufia 2 · Region Delta (1) gps=30.47168109803985,30.928756687089926 " +
      "draft_id=2c0c421d-fd0d-4149-ab27-b2892abb5d7c request_id=133",
  );
  assert.equal(arabic.note, "كارتة رايح جاي ٣٠");
  assert.equal(arabic.evidence[0]?.region, "Delta (1)");
  assert.equal(arabic.evidence[0]?.place, "Al Mostashfa, Madinet Menuf, Menouf City, Menofia Governorate");

  // 4. An allowance date is written out; the employee's note before it is untouched.
  const guard = parseOutstationDescription(
    "Meeting 510 + 40 parking Allowance guard: Allowance for 2026-08-06 was already granted on request #52 — not paid twice.",
  );
  assert.equal(guard.note, "Meeting 510 + 40 parking");
  assert.deepEqual(guard.allowanceNotices, ["Allowance for 06 Aug 2026 was already granted on request #52 — not paid twice."]);

  // 5. A plus code glued to an Arabic address, with an Arabic comma after it.
  assert.equal(
    tidyOutstationAddress("4RRJ+QQ9، طريق الاسكندرية مرسي مطروح، Al Meks, Dekhela, Alexandria Governorate 5312664, Egypt"),
    "طريق الاسكندرية مرسي مطروح, Al Meks, Dekhela, Alexandria Governorate",
  );
  assert.equal(
    tidyOutstationAddress("H246+W4P شارع الأمين ، فوق مركز النخبه للاشعه, Qism Shebeen El-Kom, Menofia Governorate 6131341, Egypt"),
    "شارع الأمين, فوق مركز النخبه للاشعه, Qism Shebeen El-Kom, Menofia Governorate",
  );

  // 6. Plain notes pass through; the "-" placeholder and emptiness read as nothing.
  assert.equal(formatOutstationDescriptionText("BRM for delta 1 team7"), "BRM for delta 1 team7");
  assert.equal(formatOutstationDescriptionText("-"), "");
  assert.equal(formatOutstationDescriptionText(null), "");
  assert.deepEqual(parseOutstationDescription(""), { allowanceNotices: [], evidence: [], note: null });

  // 7. A zero or missing coordinate gives no map link rather than a pin in the Gulf of Guinea.
  const noPoint = parseOutstationDescription(ALEX_CAR.replace("gps=31.1956674,29.9139614", "gps=0,0"));
  assert.equal(noPoint.evidence[0]?.mapUrl, null);
  const blankPoint = parseOutstationDescription(ALEX_CAR.replace("gps=31.1956674,29.9139614", "gps=,"));
  assert.equal(blankPoint.evidence[0]?.mapUrl, null);

  assert.equal(humanizeOutstationCode("manager_review"), "Manager review");
  assert.equal(humanizeOutstationCode("car"), "Car");
  assert.equal(humanizeOutstationCode(""), null);

  // 8. Every surface that showed the raw string now reads it through the formatter. The Expense
  //    Dashboard (the SAME component serves the admin shell and the employee portal) and its
  //    spreadsheet; the submit email's summary and its Notes row.
  const dashboard = readFileSync(DASHBOARD, "utf8");
  assert.ok(
    dashboard.includes("<OutstationDescription className=\"mt-1\" value={trip.description} />") &&
      !/\{trip\.description \|\| "—"\}/.test(dashboard),
    `${DASHBOARD}: the expanded trip's Description prints trip.description raw again — it carries ` +
      `"Car live evidence: source=… hr_id=… gps=… draft_id=…". Render it with <OutstationDescription>.`,
  );
  assert.ok(
    dashboard.includes("description: formatOutstationDescriptionInline(trip.description),") &&
      dashboard.includes("hrNotes: formatOutstationDescriptionInline(trip.hrNotes),"),
    `${DASHBOARD}: the Excel export's Description / HR Notes columns are raw again. HR Notes falls ` +
      `back to the description when empty, so it carried the same audit line.`,
  );

  const service = readFileSync(SERVICE, "utf8");
  const submit = service.slice(
    service.indexOf("async function notifyOutstationSubmitted("),
    service.indexOf("async function notifyOutstationDecision("),
  );
  assert.ok(submit.length > 0, `${SERVICE}: could not find notifyOutstationSubmitted.`);
  assert.ok(
    submit.includes('{ label: "Notes", value: formatOutstationDescriptionInline(request.notes) || "—" }') &&
      !submit.includes("text(request.notes)"),
    `${SERVICE}: the submit email's Notes row prints the stored notes raw again.`,
  );
  for (const raw of [
    "Transportation: ${request.transportationType}",
    "Eligibility: ${request.eligibilityStatus}",
    "Recommendation: ${request.approvalRecommendation}",
    'value: request.transportationType }',
  ]) {
    assert.ok(!submit.includes(raw), `${SERVICE}: the submit email prints a stored code again (${raw}) — "manager_review", "car".`);
  }
  assert.match(
    submit,
    /const destination =\s*tidyOutstationAddress\(request\.toLabel\)/,
    `${SERVICE}: the submit email's destination is the raw geocoder label again ("CMWC+993, … 8024807, Egypt").`,
  );

  // 9. The email keeps the summary's line breaks; without them the five facts arrive as one block.
  assert.equal(emailKeepsLineBreaks("outstation"), true, "the outstation email keeps its line breaks");
  assert.equal(emailKeepsLineBreaks("payroll"), false, "other modules keep one block, as before");

  // 10. A lead of punctuation only is no note (owner's review, 2026-11-07: a note box reading "..").
  for (const lead of [".", "..", "-", " . - "]) {
    assert.equal(
      parseOutstationDescription(`${lead} Arrival photo evidence: source=camera gps=31.2,29.9`).note,
      null,
      `HEADLINE: a "${lead}" lead is not the employee's note`,
    );
  }
  assert.equal(parseOutstationDescription("Met Dr. Hany.").note, "Met Dr. Hany.", "a real sentence with dots stays whole");
}
