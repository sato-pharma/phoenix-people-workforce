import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyVisitFilter,
  collapseDuplicateVisitSubmissions,
  hasDoublePartner,
  markPartnerCreditOnlyRows,
  REAL_DOUBLE_PARTNER_OR_FILTER,
  withExclusionCrmIdColumn,
  type VisitFilterableQuery,
} from "../src/lib/crm/reads.ts";
import {
  buildIReports360FieldWorkforceMatrix,
  visitFromMirrorRow,
  type FieldWorkforceEmployeeInput,
  type FieldWorkforceMatrixVisit,
  type VisitsMirrorRow,
} from "../src/lib/field-workforce-compliance/ireports360-source.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

/**
 * A MANAGER'S DOUBLE VISIT WITH A REP WHO LATER RESIGNED IS STILL HIS WORKING DAY.
 *
 * The defect (owner report 2026-10-07, measured on production the same day). A manager logs nothing
 * himself: his fieldwork is recorded on the REP's visit row, as that row's `double_hr_id`. The
 * exclusion that hides a departed rep's visits from every live CRM read is keyed on
 * `exclusion_crm_id`, which `crm_visits_unified` defines as `agent_crm_id` — the person who LOGGED
 * the row. So the day a rep resigned, every double visit his manager had done with him disappeared,
 * and the manager's own working day read as "no CRM activity": a deduction. It is RETROACTIVE — the
 * day was correct until the resignation rewrote it.
 *
 * Measured on production, June–September 2026 (56 excluded crm ids): 100 person-days across 18
 * ACTIVE employees lost every scrap of their CRM evidence this way, and 78 more had their visit
 * count understated. Eleven of those days reached a deduction candidate, and two of them — Salim
 * Salim Abdo Ibrahim Gomaa, 7 and 13 September, 933.33 EGP each — were approved for payroll. On 7
 * September he was the double partner on nine visits logged by Aml Mohamed Mohamed Eid elmashad,
 * whose last working day was 17 September: she was still employed on the day he worked, and her
 * later resignation is what erased his evidence.
 *
 * The fix is in the read door (`scanVisitsForRangeCreditingPartners`, and `queryVisits`'
 * `creditDepartedAgentPartners` for the bounded per-employee read): a departed agent's row survives
 * when it names a real partner, with the agent side ANONYMISED — `agent_hr_id` nulled and
 * `partner_credit_only` set — so the partner keeps his day and the departed rep still gains nothing.
 */
export function runCrmDoubleVisitWithDepartedPartnerTests() {
  // ── 1. The manager keeps his day; the departed rep gains nothing ───────────────────────────────

  const employees: FieldWorkforceEmployeeInput[] = [
    // The rep who logged the visits and has since left. Deliberately still `active` in the
    // directory here: the exclusion is computed from lifecycle elsewhere, and this test must prove
    // the rescue marker — not a missing directory row — is what keeps him off the matrix.
    {
      crmId: "1",
      crmUsername: "Rep.One",
      employmentStatus: "active",
      fullName: "Rep One",
      displayName: "Rep One",
      hireDate: "2024-01-01",
      hrId: "A-1",
      jobTitle: "Medical Representative",
      positionTitle: null,
    },
    // The district manager who spent the day with him and logs nothing of his own.
    {
      crmId: "7",
      crmUsername: "Mgr.Seven",
      employmentStatus: "active",
      fullName: "Mgr Seven",
      displayName: "Mgr Seven",
      hireDate: "2024-01-01",
      hrId: "A-6",
      jobTitle: "District Sales Manager",
      positionTitle: null,
    },
  ];

  /** One regular visit the departed rep logged with the manager riding along, in the shape the read
   * door hands over: `agentHrId` nulled, `agentID` still present (it is the duplicate-collapse key). */
  const rescuedVisit = (partnerCreditOnly: boolean): FieldWorkforceMatrixVisit => ({
    agentHrId: null,
    agentID: 1,
    agentName: "Rep.One ( Cairo / A )",
    ampm: null,
    attendance: null,
    callType: null,
    comment: null,
    contactID: 5001,
    contactName: "Dr. One",
    contactGrade: null,
    customerName: null,
    doubleHrId: "A-6",
    doubleID: 7,
    doubleName: "Mgr Seven",
    id: 0,
    partnerCreditOnly,
    region: null,
    regionID: null,
    saveDate: null,
    speciality: null,
    visitDate: "2026-09-07",
    visitType: 0,
    visitTypeDescription: null,
  });

  // Column layout: [TM, HR ID, Hiring Date, Month, Year, day1..dayN] — 7 September is index 11.
  const DAY_7 = 11;
  const rowOf = (matrix: unknown[][], hrId: string) => matrix.find((row) => row[1] === hrId)!;

  const rescued = buildIReports360FieldWorkforceMatrix({
    employees,
    month: 9,
    year: 2026,
    todayIso: "2026-09-30",
    visits: [rescuedVisit(true)],
  });

  assert.equal(
    rowOf(rescued.matrix, "A-6")[DAY_7],
    1,
    "THE MANAGER'S DAY: the double visit his rep logged is his working day, and a rep resigning months later must never take it away from him",
  );
  assert.equal(
    rowOf(rescued.matrix, "A-1")[DAY_7],
    "N",
    "THE DEPARTED REP STAYS INVISIBLE: partnerCreditOnly beats resolveHrKey's crm-id fallback, so the rescue never puts a departed rep back on the matrix — the one thing the exclusion exists to prevent",
  );
  assert.equal(
    rescued.ownRegularCountByHrKeyAndDate.get(`${canonicalHrIdKey("A-6")}|2026-09-07`),
    undefined,
    "the manager is credited the day as a ride-along, with ZERO own visits — the portal reads this as a DV coaching day, never a duplicated visit count",
  );
  assert.equal(
    rescued.ownRegularCountByHrKeyAndDate.get(`${canonicalHrIdKey("A-1")}|2026-09-07`),
    undefined,
    "a rescued row gives the departed rep no own-visit count either",
  );

  // The same row WITHOUT the marker: the agent resolves through `agentID` even with `agentHrId`
  // nulled. Pins that the assertion above passes because of the marker, not because the hr id is
  // missing — nulling alone would leave the departed rep creditable here.
  const unmarked = buildIReports360FieldWorkforceMatrix({
    employees,
    month: 9,
    year: 2026,
    todayIso: "2026-09-30",
    visits: [rescuedVisit(false)],
  });
  assert.equal(
    rowOf(unmarked.matrix, "A-1")[DAY_7],
    1,
    "without the marker the crm-id fallback still resolves the agent — which is exactly why nulling agent_hr_id alone is not enough for this consumer",
  );
  assert.equal(
    rowOf(unmarked.matrix, "A-6")[DAY_7],
    1,
    "the partner's credit is unchanged by the marker — it only ever removes the AGENT's",
  );

  // ── 1b. A CHAIN VISIT'S SECOND MANAGER KEEPS HIS DAY TOO ──────────────────────────────────────
  //
  // The same defect, from the other direction. The vendor split a chain into two rows, so each
  // manager had his own. Phoenix CRM saves ONE row carrying both, and the credit loop read slot 1
  // only — so a senior who spent the whole day riding along read as having done nothing, on the very
  // matrix a payroll deduction candidate is drawn from. Slot 2 often has NO CRM account, so it is
  // gated on the hr id, not on a CRM id like slot 1.
  const chainEmployees: FieldWorkforceEmployeeInput[] = [
    ...employees,
    {
      // Deliberately NO crmId: a Phoenix-only product manager, which is the common case for slot 2.
      crmId: null,
      crmUsername: null,
      employmentStatus: "active",
      fullName: "PM Nine",
      displayName: "PM Nine",
      hireDate: "2024-01-01",
      hrId: "A-9",
      jobTitle: "Product Manager",
      positionTitle: null,
    },
  ];
  const chain = buildIReports360FieldWorkforceMatrix({
    employees: chainEmployees,
    month: 9,
    year: 2026,
    todayIso: "2026-09-30",
    visits: [{ ...rescuedVisit(false), agentHrId: "A-1", double2HrId: "A-9", double2Name: "PM Nine" }],
  });
  assert.equal(
    rowOf(chain.matrix, "A-9")[DAY_7],
    1,
    "THE SECOND MANAGER'S DAY: a chain visit's slot-2 manager rode along, so the day is worked — reading slot 1 alone is a no-activity deduction for a day he spent in the field",
  );
  assert.equal(
    rowOf(chain.matrix, "A-6")[DAY_7],
    1,
    "and slot 1 keeps his, unchanged",
  );
  assert.equal(
    rowOf(chain.matrix, "A-1")[DAY_7],
    1,
    "and the rep who logged it keeps his own day — crediting a second manager moves nobody else's figure",
  );
  assert.equal(
    chain.ownRegularCountByHrKeyAndDate.get(`${canonicalHrIdKey("A-9")}|2026-09-07`),
    undefined,
    "the second manager's is a ride-along day with ZERO own visits, exactly as slot 1's is — never a duplicated visit count",
  );

  // Slot 2 naming the SAME person as slot 1 must credit that person ONCE. It cannot happen in the
  // data (slot 2 is never filled while slot 1 is empty), and the guard is what makes that a promise:
  // the row lands on a person's day list, so a duplicate would count one visit twice for them.
  const sameTwice = buildIReports360FieldWorkforceMatrix({
    employees: chainEmployees,
    month: 9,
    year: 2026,
    todayIso: "2026-09-30",
    visits: [{ ...rescuedVisit(false), agentHrId: "A-1", double2HrId: "A-6", double2Name: "Mgr Seven" }],
  });
  assert.equal(
    rowOf(sameTwice.matrix, "A-6")[DAY_7],
    1,
    "one person named in both slots is credited the day once, not twice",
  );

  // Slot 1 naming a manager with NO CRM account (re-audit, 2026-10-22): a Phoenix double visit carries
  // him by HR ID only. The old `doubleID != null` gate left his ride-along day uncredited — Nahed
  // Tarek's five October double visits — while slot 2 already reached its manager by HR ID.
  const slotOneNoAccount = buildIReports360FieldWorkforceMatrix({
    employees: chainEmployees,
    month: 9,
    year: 2026,
    todayIso: "2026-09-30",
    visits: [{ ...rescuedVisit(false), agentHrId: "A-1", doubleID: null, doubleHrId: "A-9", doubleName: "PM Nine" }],
  });
  assert.equal(
    rowOf(slotOneNoAccount.matrix, "A-9")[DAY_7],
    1,
    "THE SLOT-1 MANAGER WITH NO CRM ACCOUNT: his ride-along day is worked, reached by his HR ID",
  );
  assert.equal(
    rowOf(slotOneNoAccount.matrix, "A-1")[DAY_7],
    1,
    "and the rep who logged it keeps his own day",
  );
  const selfAsPartner = buildIReports360FieldWorkforceMatrix({
    employees: chainEmployees,
    month: 9,
    year: 2026,
    todayIso: "2026-09-30",
    visits: [{ ...rescuedVisit(false), agentHrId: "A-1", doubleID: 1, doubleHrId: "A-1", doubleName: "Rep.One" }],
  });
  assert.equal(
    rowOf(selfAsPartner.matrix, "A-1")[DAY_7],
    1,
    "a partner CRM id equal to the agent's is still the agent himself — never a second credit",
  );

  // ── 2. The marker survives the mirror-row mapping ─────────────────────────────────────────────

  const mirrorRow: VisitsMirrorRow = {
    agent_crm_id: 1,
    agent_hr_id: null,
    agent_name: "Rep.One ( Cairo / A )",
    double_crm_id: 7,
    double_hr_id: "A-6",
    double_name: "Mgr Seven",
    double2_hr_id: "A-9",
    double2_name: "PM Nine",
    partner_credit_only: true,
    visit_date: "2026-09-07",
    visit_type: 0,
  };
  assert.equal(
    visitFromMirrorRow(mirrorRow).partnerCreditOnly,
    true,
    "visitFromMirrorRow must carry the read door's marker through to the matrix builder, or the credit loop can never see it",
  );
  assert.equal(
    visitFromMirrorRow({ ...mirrorRow, partner_credit_only: undefined }).partnerCreditOnly,
    false,
    "an ordinary row is not partner-credit-only — the mapping defaults to false, never undefined-as-truthy",
  );
  assert.equal(
    visitFromMirrorRow(mirrorRow).double2HrId,
    "A-9",
    "and it carries slot 2 through as well, or the credit loop above can never see the second manager",
  );

  // ── 3. What the marking pass does, and what it must not touch ────────────────────────────────

  const excludedCrmIds = [1399, 1207];
  const departedRow = { agent_crm_id: 1399, agent_hr_id: "B-15", exclusion_crm_id: 1399, visit_date: "2026-09-07" };
  const workingRow = { agent_crm_id: 1361, agent_hr_id: "B-76", exclusion_crm_id: 1361, visit_date: "2026-09-07" };
  const sourcelessRow = { agent_crm_id: null, agent_hr_id: "B-99", exclusion_crm_id: null, visit_date: "2026-09-07" };
  markPartnerCreditOnlyRows([departedRow, workingRow, sourcelessRow], excludedCrmIds);

  assert.deepEqual(
    departedRow,
    { agent_crm_id: 1399, agent_hr_id: null, exclusion_crm_id: 1399, visit_date: "2026-09-07", partner_credit_only: true },
    "THE DEDUPE KEY: a departed agent's row is marked and its agent_hr_id nulled, but agent_crm_id is LEFT INTACT — it is what collapseDuplicateVisitSubmissions groups a re-saved stop by",
  );
  assert.deepEqual(
    workingRow,
    { agent_crm_id: 1361, agent_hr_id: "B-76", exclusion_crm_id: 1361, visit_date: "2026-09-07" },
    "a working agent's row is not touched at all — no marker, no nulled hr id",
  );
  assert.deepEqual(
    sourcelessRow,
    { agent_crm_id: null, agent_hr_id: "B-99", exclusion_crm_id: null, visit_date: "2026-09-07" },
    "a null exclusion_crm_id matches nobody — never coerced to 0, which is the vendor's own sentinel",
  );

  // A bigint delivered as a string (PostgREST does this) must still match its excluded id.
  const stringIdRow = { agent_hr_id: "B-15", exclusion_crm_id: "1207" as unknown as number };
  markPartnerCreditOnlyRows([stringIdRow], excludedCrmIds);
  assert.equal(stringIdRow.agent_hr_id, null, "an exclusion_crm_id arriving as a string still matches — compared as numbers, not by identity");

  // Nothing to do, nothing done.
  const untouched = { agent_hr_id: "B-15", exclusion_crm_id: 1399 };
  markPartnerCreditOnlyRows([untouched], []);
  assert.deepEqual(untouched, { agent_hr_id: "B-15", exclusion_crm_id: 1399 }, "with no excluded ids the pass is a no-op");

  // ── 4. The duplicate collapse still works on marked rows ─────────────────────────────────────
  // iReports360's client re-saves one real stop as several rows. The collapse keys on
  // (agent_crm_id, contact, date, type), so nulling the crm id in the marking pass would make every
  // rescued row ungroupable and inflate the partner's visit count for that day.

  const duplicate = (crmSaveDate: string) => ({
    agent_crm_id: 1399,
    agent_hr_id: "B-15",
    contact_crm_id: 5001,
    crm_save_date: crmSaveDate,
    crm_visit_id: crmSaveDate === "2026-09-07T08:00:00" ? 11 : 12,
    double_crm_id: 7,
    exclusion_crm_id: 1399,
    visit_date: "2026-09-07",
    visit_type: 0,
  });
  const burst = [duplicate("2026-09-07T08:00:00"), duplicate("2026-09-07T08:00:40")];
  markPartnerCreditOnlyRows(burst, excludedCrmIds);
  assert.equal(
    collapseDuplicateVisitSubmissions(burst).length,
    1,
    "THE COLLAPSE SURVIVES: two re-saves of one stop are still one visit after marking, because agent_crm_id survived the pass",
  );

  // ── 5. The rescue's projection and its partner test ──────────────────────────────────────────

  assert.equal(
    withExclusionCrmIdColumn("agent_hr_id, double_hr_id, visit_date"),
    "agent_hr_id, double_hr_id, visit_date, exclusion_crm_id",
    "the marking pass needs exclusion_crm_id whatever the caller projected",
  );
  assert.equal(
    withExclusionCrmIdColumn("exclusion_crm_id, visit_date"),
    "exclusion_crm_id, visit_date",
    "already present → unchanged, never requested twice",
  );
  assert.equal(withExclusionCrmIdColumn("*"), "*", "a star projection already has every column");

  assert.equal(
    REAL_DOUBLE_PARTNER_OR_FILTER,
    "and(source.eq.phoenix,double_hr_id.not.is.null),and(source.neq.phoenix,double_crm_id.not.is.null,double_crm_id.neq.0)",
    "the rescue keeps only rows naming a REAL partner: the crm-id half, or a resolved partner hr id on a Phoenix native row — a vendor row's stray double_hr_id beside a 0 partner is not a double visit",
  );
  for (const half of REAL_DOUBLE_PARTNER_OR_FILTER.match(/and\([^)]*\)/g) ?? []) {
    assert.match(
      half,
      /^and\(source\.(eq|neq)\.phoenix,/,
      `each half of the real-partner test names its source (${half}): an open crm-id half makes Postgres join the partner, and look up the customer, of every Phoenix visit before it can test it — 9,807 pages for one Double Visit Analytics week against 3,360 (infrastructure audit, 2026-10-28)`,
    );
  }

  // The `doubleOnly` filter and the rescue must use ONE definition, or a row that counts as a
  // double visit in Double Visit Analytics could be a row the rescue throws away.
  const doubleOnlyCalls: Array<[string, ...unknown[]]> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      doubleOnlyCalls.push([method, ...args]);
      return recordingQuery;
    };
  const recordingQuery: VisitFilterableQuery = {
    eq: record("eq"),
    gte: record("gte"),
    ilike: record("ilike"),
    in: record("in"),
    is: record("is"),
    lte: record("lte"),
    neq: record("neq"),
    not: record("not"),
    or: record("or"),
  };
  applyVisitFilter(recordingQuery, { doubleOnly: true }, "");
  assert.deepEqual(
    doubleOnlyCalls,
    [["or", REAL_DOUBLE_PARTNER_OR_FILTER]],
    "applyVisitFilter's doubleOnly and the rescue share the one constant, so the two tests of 'a real partner' cannot drift apart",
  );

  // ── 6. The read door's own shape ─────────────────────────────────────────────────────────────

  const reads = readFileSync("src/lib/crm/reads.ts", "utf8");
  assert.match(
    reads,
    /export async function scanVisitsForRangeCreditingPartners\b/,
    "crm/reads.ts exposes the partner-crediting scan door",
  );
  assert.match(
    reads,
    /onlyExcludedCrmIds: excludedCrmIds,\s*\n\s*requireRealDoublePartner: true,/,
    "the rescue scan reads ONLY the excluded agents' rows, and only those naming a real partner — never a second full company scan",
  );
  assert.match(
    reads,
    /const visible = await keysetScanVisitsForRange<T & PartnerCreditOnlyRow>\(\{ \.\.\.options, excludedInList \}\);/,
    "the visible half of the door is the plain excluded scan, unchanged — the rescue is additive, so no departed rep's solo visit becomes visible",
  );
  assert.match(
    reads,
    /if \(excludedCrmIds\.length === 0\) return visible;/,
    "with nobody excluded the door is exactly scanVisitsForRange and costs one query, not two",
  );
  assert.match(
    reads,
    /return \[\.\.\.visible, \.\.\.rescued\]\.sort\(\(a, b\) =>\s*\n?\s*compareUuidText\(/,
    "the two halves merge back into the single scan's id order — appending the rescued rows at the end would change what a mixed day's label says about itself",
  );
  assert.match(
    reads,
    /options\.includeResignedAgents \|\| options\.creditDepartedAgentPartners \? "" : await getEffectiveExcludedInList\(\)/,
    "the visit door's resigned-agent exclusion stays ON by default — only an explicit, documented opt-in skips it",
  );
  assert.match(
    reads,
    /if \(excludedCrmIds\.length > 0\) markPartnerCreditOnlyRows\(rows, excludedCrmIds\);/,
    "creditDepartedAgentPartners must anonymise the agent side of what it lets through; without the marking pass it is just includeResignedAgents under a kinder name",
  );

  // ── 7. Every path that decides whether somebody WORKED goes through the new door ─────────────
  // Each of these charges money, or supplies the evidence a charge is judged against.

  for (const [path, why] of [
    [
      "src/lib/field-workforce-compliance/ireports360-source.ts",
      "the FWC matrix — the CRM no-activity deduction reads it, and it is where Salim Salim's two days were lost",
    ],
    ["src/lib/deductions/connectors/dsm-no-record.ts", "the DSM no-record deduction, whose whole subject is managers riding along"],
    ["src/lib/deductions/connectors/holiday-bridge.ts", "the bridge-day no-record deduction"],
    ["src/lib/attendance/crm-day-maps.ts", "the CRM day maps, which supply the field-day evidence a fingerprint charge is weighed against"],
  ] as const) {
    const source = readFileSync(path, "utf8");
    assert.match(
      source,
      /scanVisitsForRangeCreditingPartners</,
      `${path} must read company-wide visits through the partner-crediting door — ${why}`,
    );
    assert.doesNotMatch(
      source,
      /\bscanVisitsForRange</,
      `${path} must not fall back to the plain scan, which erases a manager's day the moment his rep resigns — ${why}`,
    );
  }

  const dayMaps = readFileSync("src/lib/attendance/crm-day-maps.ts", "utf8");
  assert.match(
    dayMaps,
    /doubleHrIds: wantedIds,\s*\n\s*creditDepartedAgentPartners: true,/,
    "the bounded per-employee read asks about the people on the DOUBLE side, so it must keep a departed agent's row too — a one-employee fingerprint re-scan goes down this branch, not the company scan",
  );

  // ── The duplicate collapse keeps a ride-along whose manager has NO CRM account (re-audit 2026-10-22) ─
  // One stop saved twice: first solo, then as a Phoenix double naming the manager by HR id only. The
  // CRM-id-only partner test let the solo save win and erased the manager's coaching credit.
  assert.equal(hasDoublePartner({ source: "phoenix", crm_visit_id: -5, double_crm_id: null, double_hr_id: "A-10" }), true);
  assert.equal(hasDoublePartner({ crm_visit_id: -5, double_crm_id: null, double_hr_id: "A-10" }), true, "a negative visit id is a Phoenix row");
  assert.equal(
    hasDoublePartner({ source: "ireports360", crm_visit_id: 77, double_crm_id: null, double_hr_id: "A-10" }),
    false,
    "a stray resolved HR id on a vendor row is not a partner",
  );
  const soloThenRideAlong = collapseDuplicateVisitSubmissions([
    { agent_crm_id: 1403, contact_crm_id: 5001, visit_date: "2026-10-14", visit_type: 0, crm_visit_id: -10, crm_save_date: "2026-10-14T09:00:00", double_crm_id: null, double_hr_id: null },
    { agent_crm_id: 1403, contact_crm_id: 5001, visit_date: "2026-10-14", visit_type: 0, crm_visit_id: -11, crm_save_date: "2026-10-14T09:05:00", double_crm_id: null, double_hr_id: "A-10" },
  ]);
  assert.equal(soloThenRideAlong.length, 1, "one real stop");
  assert.equal(soloThenRideAlong[0].double_hr_id, "A-10", "the ride-along survives, so the manager keeps the day");
  assert.match(
    readFileSync("src/lib/crm/reads.ts", "utf8"),
    /const DUPLICATE_DETECTION_COLUMNS = \[[^\]]*"double_hr_id"/,
    "the collapse widens every projection with double_hr_id, or the partner test above reads undefined",
  );
}
