import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CRM_VACATION_EMPLOYMENT_JOIN_FROM,
  resolveCrmVacationEmployee,
  type CrmVacationEmployee,
} from "../src/lib/deductions/connectors/vacation.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * WHO A CRM ANNUAL-VACATION (-4) DAY BELONGS TO — owner decision 2026-09-13.
 *
 * Questions workbook: row 1 "Use the new join, but only within each person's own employment dates";
 * rows 2–4 (reused slots 1399, 1475, 1485) "Nobody — drop them". Published months never move.
 *
 * The production shapes, with names kept out of the fixture:
 *   - slot 1399: a resigned rep's slot handed to a new rep hired 5 Sep 2026. Leave logged on it
 *     before 5 Sep must reach NOBODY — not the new rep.
 *   - a resigned rep whose slot was CLEARED: the old join (employees.crm_id) cannot see her at all;
 *     the sync stamp still names her, so her in-employment leave is found.
 */

const NEW_REP: CrmVacationEmployee = { hrId: "AI-0020", name: "New Rep", hireDate: "2026-09-05", lastWorkingDate: null };
const RESIGNED_CLEARED: CrmVacationEmployee = { hrId: "B-97", name: "Resigned Rep", hireDate: "2025-12-14", lastWorkingDate: "2026-09-04" };
const LEAVER_STILL_HOLDING: CrmVacationEmployee = { hrId: "B-50", name: "Leaver", hireDate: "2025-01-01", lastWorkingDate: "2026-09-10" };

const byCrmId = new Map<string, CrmVacationEmployee>([
  ["1399", NEW_REP],
  ["1400", LEAVER_STILL_HOLDING],
]);
const byHrIdKey = new Map<string, CrmVacationEmployee>(
  [NEW_REP, RESIGNED_CLEARED, LEAVER_STILL_HOLDING].map((e) => [canonicalHrIdKey(e.hrId) as string, e]),
);

function resolve(monthKey: string, day: string, crmId: string, agentHrId: string | null) {
  return resolveCrmVacationEmployee({ monthKey, day, crmId, agentHrId, byCrmId, byHrIdKey })?.hrId ?? null;
}

export function runDeductionsCrmVacationEmploymentJoinTests() {
  // ---- THE HEADLINE: a reused slot's pre-hire leave belongs to NOBODY ----------------------------
  assert.equal(
    resolve("2026-09", "2026-09-02", "1399", null),
    null,
    "a leave day on a reused CRM slot BEFORE the current holder's hire date must belong to nobody — never charged to the new joiner",
  );
  assert.equal(resolve("2026-09", "2026-09-05", "1399", null), "AI-0020", "on the hire date itself the day is the holder's");
  assert.equal(resolve("2026-09", "2026-09-20", "1399", null), "AI-0020", "an unstamped in-employment day falls back to the slot holder");

  // ---- the sync stamp wins, and finds a resigned rep whose slot was cleared -----------------------
  assert.equal(
    resolve("2026-09", "2026-09-03", "9999", "b-97"),
    "B-97",
    "a sync-stamped day belongs to the stamped employee even when no one holds the slot today (case-insensitive key)",
  );
  assert.equal(
    resolve("2026-09", "2026-09-02", "1399", "B-97"),
    "B-97",
    "a stamp outranks the slot holder",
  );
  assert.equal(
    resolve("2026-09", "2026-09-08", "9999", "B-97"),
    null,
    "a STAMPED day after that person's last working date belongs to nobody — the sync can keep a stamp past it, the employment window still binds",
  );

  // ---- after the holder's last working date: nobody --------------------------------------------
  assert.equal(resolve("2026-09", "2026-09-10", "1400", null), "B-50", "the last working date itself is inside employment");
  assert.equal(resolve("2026-09", "2026-09-11", "1400", null), null, "an unstamped day after the holder's last working date belongs to nobody");

  // ---- a holder with no hire date is never guessed at ------------------------------------------
  const noHire = new Map([["1500", { hrId: "X-1", name: null, hireDate: null, lastWorkingDate: null }]]);
  assert.equal(
    resolveCrmVacationEmployee({ monthKey: "2026-10", day: "2026-10-01", crmId: "1500", agentHrId: null, byCrmId: noHire, byHrIdKey: new Map() }),
    null,
    "no hire date means no employment span to judge against — the day is not attributed",
  );

  // ---- PUBLISHED MONTHS NEVER MOVE: before the cutover, the old join exactly ----------------------
  assert.equal(CRM_VACATION_EMPLOYMENT_JOIN_FROM, "2026-09", "the new join starts with September 2026 — August payroll is already published");
  assert.equal(
    resolve("2026-08", "2026-08-27", "1399", null),
    "AI-0020",
    "an August day keeps the old slot-as-it-stands join byte-for-byte, so re-collecting a published month adds nothing",
  );
  assert.equal(
    resolve("2026-08", "2026-08-10", "9999", "B-97"),
    null,
    "an August day ignores the stamp — the old join never saw a cleared slot, and a published month must not gain a day",
  );

  // ---- the connector actually routes through the resolver --------------------------------------
  const source = stripComments(readFileSync("src/lib/deductions/connectors/vacation.ts", "utf8")).split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    source.includes("resolveCrmVacationEmployee({"),
    "collectCrmSubmittedUnpaidVacationDays must attribute each -4 day through resolveCrmVacationEmployee",
  );
  assert.ok(
    /columns:\s*"[^"]*agent_hr_id[^"]*"/.test(source),
    "the visit scan must read agent_hr_id — without the stamp the new join silently degrades to the slot holder",
  );
  assert.ok(
    !/employeeByCrmId\.get\(crmId\)/.test(source),
    "no -4 day may be attributed by a bare slot lookup outside the resolver",
  );
}
