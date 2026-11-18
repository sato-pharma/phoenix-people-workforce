import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CEILING_OVERRIDES } from "../src/lib/notifications/confidence-gate.ts";
import {
  NEW_JOINER_EVENT_TYPE,
  NEW_JOINER_MAX_RECIPIENTS,
  NEW_JOINER_MODULE,
  newJoinerDetails,
  pickHeadOfficeAudience,
  renderNewJoinerAnnouncement,
  type NewJoinerDirectoryRow,
} from "../src/lib/offers/new-joiner-announcement.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE NEW JOINER ANNOUNCEMENT (owner, 18 Nov 2026: "when a new hire accepts the job offer send email
 * to all the head office employees with his details, hiring date, area, line").
 *
 * The audience is Head Office as the organogram draws it (the line plus the marketers reporting into
 * it), never the field force and never the new hire; the email names the line, the area and the
 * hiring date; it fires from the joining form's submit, past the response, once per offer.
 */

const root = process.cwd();
const code = (relative: string) => stripComments(readFileSync(path.join(root, relative), "utf8"));
const flat = (relative: string) => code(relative).replace(/\s+/g, " ");

const person = (overrides: Partial<NewJoinerDirectoryRow> & { hrId: string }): NewJoinerDirectoryRow => ({
  areaName: null,
  displayName: overrides.hrId,
  hireDate: null,
  jobTitle: null,
  lineId: null,
  lineName: null,
  managerHrId: null,
  managerName: null,
  workEmail: `${overrides.hrId.toLowerCase()}@satopharma.com`,
  ...overrides,
});

const isHeadOffice = (row: NewJoinerDirectoryRow) => row.lineId === 4;

export function runNewJoinerAnnouncementTests() {
  // ── 1. Who receives it ──────────────────────────────────────────────────────────────────────
  const rows: NewJoinerDirectoryRow[] = [
    person({ hrId: "AA", jobTitle: "CEO", lineId: 4 }),
    person({ hrId: "A-9", jobTitle: "Marketing Manager", lineId: 4, managerHrId: "AA" }),
    person({ hrId: "B-10", jobTitle: "HR Manager", lineId: 4, managerHrId: "AA" }),
    // Two marketers filed on a product line who report into Head Office: Head Office.
    person({ hrId: "A-8", jobTitle: "Group Product Manager", lineId: 2, managerHrId: "A-9" }),
    person({ hrId: "B-155", jobTitle: "Product Manager", lineId: 2, managerHrId: "a-8" }),
    // A National Sales Manager reports to the CEO alone: NOT Head Office.
    person({ hrId: "N-1", jobTitle: "National Sales Manager", lineId: 1, managerHrId: "AA" }),
    person({ hrId: "D-1", jobTitle: "District Manager", lineId: 1, managerHrId: "N-1" }),
    // A leader whose title no field pattern names, reporting to the CEO alone: still NOT Head Office.
    person({ hrId: "U-1", jobTitle: "Business Unit Director", lineId: 1, managerHrId: "AA" }),
    // A field title under a Head Office manager is still never pulled in.
    person({ hrId: "R-1", jobTitle: "Medical Representative", lineId: 1, managerHrId: "A-9" }),
    // The new hire, on Head Office: never sent their own announcement.
    person({ hrId: "B-200", jobTitle: "Training Manager", lineId: 4, managerHrId: "AA" }),
  ];
  const audience = pickHeadOfficeAudience(rows, { isHeadOffice, newHireHrId: "b-200" })
    .map((row) => row.hrId)
    .sort();
  assert.deepEqual(
    audience,
    ["A-8", "A-9", "AA", "B-10", "B-155"],
    "Head Office is the line (CEO included) plus the marketers reporting into it — never the field force, never the new hire",
  );

  // ── 2. What it says ─────────────────────────────────────────────────────────────────────────
  const hire = person({
    areaName: "Sohag 1",
    displayName: "Mona Adel",
    hireDate: "2026-12-01",
    hrId: "AI-0050",
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Anti Infective",
    managerName: "Karim Fathy",
  });
  const offer = { candidateName: "Mona Adel Hassan", startDate: "2026-12-01", territory: "Sohag", title: "Medical Representative" };
  const details = newJoinerDetails(hire, offer, false);
  assert.deepEqual(details, {
    area: "Sohag 1",
    hiringDate: "01 December 2026",
    jobTitle: "Medical Representative",
    line: "Anti Infective",
    name: "Mona Adel",
    reportsTo: "Karim Fathy",
  });
  const email = renderNewJoinerAnnouncement(details);
  assert.equal(email.subject, "Welcome to Sato Pharma — Mona Adel, Medical Representative");
  for (const words of ["Mona Adel", "Anti Infective", "Sohag 1", "01 December 2026", "Karim Fathy", "Dear colleagues"]) {
    assert.ok(email.html.includes(words), `the email must print "${words}"`);
    assert.ok(email.text.includes(words), `the plain-text email must print "${words}"`);
  }
  for (const label of ["Line", "Area", "Hiring date"]) {
    assert.ok(email.text.includes(label), `the email must label the ${label}`);
  }

  // The record is silent → the offer speaks; a Head Office joiner's area reads Head Office.
  const officeHire = person({ displayName: "Sara Ali", hrId: "B-201", lineId: 4, lineName: "Head Office" });
  const officeDetails = newJoinerDetails(officeHire, { candidateName: "Sara Ali", startDate: "2026-12-07", territory: "", title: "Office Coordinator" }, true);
  assert.equal(officeDetails.area, "Head Office");
  assert.equal(officeDetails.jobTitle, "Office Coordinator");
  assert.equal(officeDetails.hiringDate, "07 December 2026");

  // Every value is escaped: a name is data, never markup.
  const hostile = renderNewJoinerAnnouncement({ ...details, line: "<b>Anti</b> Infective", name: "<b>Mona</b>" });
  assert.ok(!hostile.html.includes("<b>Anti</b>"), "a table value must never reach the email as markup");
  assert.ok(!hostile.html.includes("<b>Mona</b>"), "a name must never reach the email as markup");

  // ── 3. The gate lets the designed audience through ─────────────────────────────────────────
  const override = CEILING_OVERRIDES[`${NEW_JOINER_MODULE}/${NEW_JOINER_EVENT_TYPE}`];
  assert.ok(override, "the announcement needs its own Confidence Gate ceiling, or its first joiner is held");
  assert.equal(override.appliesTo, "always");
  assert.ok(override.ceiling >= NEW_JOINER_MAX_RECIPIENTS, "the gate must never be the thing that stops a send the module allows");

  // ── 4. The wiring: the joining form fires it, past the response, once per offer ─────────────
  const service = flat("src/lib/offers/joining-form-service.ts");
  assert.match(
    service,
    /afterResponse\("offer\.new-joiner-announcement", \(\) => announceNewJoinerToHeadOffice\(\{ hrId, offer: acceptedOffer \}\)\)/,
    "the joining form must announce the new joiner, inside afterResponse",
  );
  assert.ok(
    service.indexOf("announceNewJoinerToHeadOffice(") > service.indexOf("await handoff.flush()"),
    "the announcement goes out after the record and its hand-off, never before",
  );
  const announcer = flat("src/lib/offers/new-joiner-announcement.ts");
  assert.ok(announcer.includes("idempotencyKey: `${NEW_JOINER_EVENT_TYPE}:${offerId}`"), "once per offer");
  assert.ok(announcer.includes("fanoutToBcc: true"), "the addresses go in BCC, so a reply never reaches the whole team");
  assert.ok(announcer.includes("to.length > NEW_JOINER_MAX_RECIPIENTS"), "an audience the size of the company is refused");
}
