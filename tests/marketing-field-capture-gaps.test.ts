import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DESK_VALIDATION_MARKER,
  INFERRED_HISTORY_MARKER,
  SECOND_CODE_BACKFILL_MARKER,
  isDeskValidated,
  isInferredFromHistory,
  isNotFieldValidated,
  isSecondCodeBackfill,
} from "../src/lib/customer-pharmacy-mapping/readiness.ts";
import {
  fieldCaptureNudgeMessage,
  groupFieldCaptureBacklog,
  type FieldCaptureBacklogInput,
} from "../src/lib/marketing-requests/field-capture-backlog.ts";
import type { MarketingValidationReportRow } from "../src/lib/marketing-requests/types.ts";
import {
  customerFieldEvidenceGap,
  fieldEvidenceGapInput,
  type FieldEvidenceGapInput,
} from "../src/lib/marketing-requests/validation-report.ts";

// Two gaps in the "not GPS field-validated" badge and the daily field-capture nudge, both measured
// read-only on production on 2026-09-17.
//
//   1. The 2026-09-08 hand backfill wrote 81 links adding a second distributor code onto pairings
//      that already existed. Their notes carry neither the history marker nor the desk marker, so
//      each read as a live capture — and one of them beside an unproven link cleared the badge and
//      dropped the nudge for 39 customers.
//   2. The nudge went to the row's `owner_hr_id` even after that rep had resigned: 23 unproven
//      customers were being chased only at somebody who no longer works here.

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// The note the backfill wrote, verbatim apart from being built from the marker, and the variant six
// of those links carry since they were held pending on 2026-09-17 with a sentence appended.
const SECOND_CODE_NOTE =
  `${SECOND_CODE_BACKFILL_MARKER} The venue already carried this confirmed code, but no customer link pointed at it, ` +
  "so no marketing request could target it and none of its sales could be credited. Validation status inherited " +
  "from this customer's existing link to the same venue - nothing was elevated.";
const SECOND_CODE_HELD_NOTE =
  `${SECOND_CODE_NOTE} Held 2026-09-17 by owner decision: this is a second distributor code for a customer and ` +
  "pharmacy pairing held on 2026-08-21, so it waits for the same release as that pairing.";
const INFERRED_NOTE = `Inferred from approved historical marketing requests — ${INFERRED_HISTORY_MARKER}. Backfill script 2026-07-02.`;
const DESK_NOTE = `Location chosen from map search — ${DESK_VALIDATION_MARKER}`;

const noEvidence = { customerEvidenceStatus: "missing", pharmacyEvidenceStatus: "missing" } as const;

function link(notes: string | null, evidence: Partial<FieldEvidenceGapInput> = {}): FieldEvidenceGapInput {
  return {
    ...noEvidence,
    deskValidated: isDeskValidated(notes),
    inferredFromHistory: isInferredFromHistory(notes),
    secondCodeBackfill: isSecondCodeBackfill(notes),
    ...evidence,
  };
}

function customer(overrides: Partial<FieldCaptureBacklogInput> = {}): FieldCaptureBacklogInput {
  return {
    areaId: null,
    customerCode: "ROI-C-0001",
    customerEvidenceStatus: "missing",
    customerId: "c1",
    customerName: "Mostafa Soliman",
    links: [{ pharmacyEvidenceStatus: "missing", pharmacyName: "El Ezaby Qena", validationNotes: INFERRED_NOTE }],
    managerHrId: null,
    ownerHrId: "HR-100",
    ...overrides,
  };
}

export function runMarketingFieldCaptureGapsTests() {
  // ── 1a. The recogniser ─────────────────────────────────────────────────────────────────────
  assert.equal(isSecondCodeBackfill(SECOND_CODE_NOTE), true, "the 2026-09-08 backfill note is recognised");
  assert.equal(
    isSecondCodeBackfill(SECOND_CODE_HELD_NOTE),
    true,
    "a held link keeps the sentence at the front and gains one at the end — still the same backfill",
  );
  assert.equal(isSecondCodeBackfill(INFERRED_NOTE), false, "a 2026-07-02 history note is not the second-code backfill");
  assert.equal(isSecondCodeBackfill(DESK_NOTE), false, "a desk note is not the second-code backfill");
  assert.equal(isSecondCodeBackfill(null), false, "a note-less link makes no claim either way");
  assert.equal(
    isNotFieldValidated(SECOND_CODE_NOTE),
    true,
    "a second-code backfill link carries no field evidence of its own",
  );
  // Origin stays origin: the Customer Pharmacy Mapping page's "Inferred" filter means the 2026-07-02
  // history backfill and nothing else, so these 81 links must not start appearing under it.
  assert.equal(isInferredFromHistory(SECOND_CODE_NOTE), false, "the Inferred filter is about origin and must not widen");
  assert.equal(isDeskValidated(SECOND_CODE_NOTE), false, "nor is a second-code link a desk entry");

  // ── 1b. The badge ──────────────────────────────────────────────────────────────────────────
  // Production 2026-09-17: 62 of the 81 sit beside an inferred or desk link to the same shop with
  // nothing captured on either half. This is that shape, and it is what the fix exists for.
  assert.equal(
    customerFieldEvidenceGap([link(INFERRED_NOTE), link(SECOND_CODE_NOTE)]),
    "inferred",
    "a second-code backfill link must NOT clear the badge beside an unproven inferred link — it copied that link's status, it did not visit",
  );
  assert.equal(
    customerFieldEvidenceGap([link(DESK_NOTE), link(SECOND_CODE_NOTE)]),
    "desk",
    "beside a desk link it takes the desk link's reason, because that link's origin is its origin",
  );
  assert.equal(
    customerFieldEvidenceGap([link(SECOND_CODE_NOTE)]),
    "second_code",
    "read on its own, as the Customer Database's one-card-per-link view does, it names its own reason rather than guessing",
  );
  // Nothing about the older rules moves.
  assert.equal(
    customerFieldEvidenceGap([link(INFERRED_NOTE), link(SECOND_CODE_NOTE), link(null)]),
    null,
    "EVERY, never SOME: one genuine capture still clears the customer",
  );
  assert.equal(
    customerFieldEvidenceGap([link(SECOND_CODE_NOTE, { pharmacyEvidenceStatus: "complete" })]),
    null,
    "a shop photographed in the field clears a second-code link exactly as it clears the other two — 19 of the 81 in production",
  );
  assert.equal(
    customerFieldEvidenceGap([link(SECOND_CODE_NOTE, { customerEvidenceStatus: "pending" })]),
    "second_code",
    "a PENDING half is still not proof",
  );

  // The workspace narrows report rows through `fieldEvidenceGapInput`; a flag that stopped at the row
  // would leave the Validation Workspace on the old reading while the unit rule above passed.
  const reportRow = {
    customer: { evidenceStatus: "missing" },
    deskValidated: false,
    inferredFromHistory: false,
    pharmacy: { evidenceStatus: "missing" },
    secondCodeBackfill: true,
  } as unknown as MarketingValidationReportRow;
  assert.equal(
    fieldEvidenceGapInput(reportRow).secondCodeBackfill,
    true,
    "the report-row narrowing must carry the second-code flag through to the badge",
  );

  // Every place that builds a report or database row reads the flag from the notes. Four sites:
  // the validation report, the customer database, a reused link, and a fresh submission.
  const serviceSource = source("src/lib/marketing-requests/service.ts");
  assert.equal(
    serviceSource.match(/secondCodeBackfill: isSecondCodeBackfill\(/g)?.length ?? 0,
    4,
    "all four row builders in service.ts must read the second-code flag from the link's notes",
  );
  // A badge reason with no label renders an empty badge; the Record type gates typecheck only.
  const badgeSource = source("src/components/marketing-requests/not-field-validated-badge.tsx");
  assert.equal(
    badgeSource.match(/^\s*second_code:/gm)?.length ?? 0,
    2,
    "the shared badge must give the second_code reason both a label and a tooltip",
  );

  // ── 1c. The nudge follows the badge ────────────────────────────────────────────────────────
  const directory = [{ areaId: null, hrId: "HR-100", role: "District Manager" as const }];
  const backfilledBesideInferred = groupFieldCaptureBacklog(
    [
      customer({
        links: [
          { pharmacyEvidenceStatus: "missing", pharmacyName: "El Ezaby Qena", validationNotes: INFERRED_NOTE },
          { pharmacyEvidenceStatus: "missing", pharmacyName: "El Ezaby Qena", validationNotes: SECOND_CODE_NOTE },
        ],
      }),
    ],
    directory,
  );
  assert.equal(
    backfilledBesideInferred.totals.customers,
    1,
    "a customer whose only 'capture' is a second-code backfill link is still owed a visit, and its rep is still told",
  );
  assert.equal(backfilledBesideInferred.owners[0].hrId, "HR-100");
  assert.equal(backfilledBesideInferred.owners[0].customers[0].gap, "inferred");
  assert.deepEqual(
    backfilledBesideInferred.owners[0].customers[0].venueNames,
    ["El Ezaby Qena"],
    "two codes for one shop are one shop to photograph",
  );

  // ── 2. A leaver is not an owner ────────────────────────────────────────────────────────────
  // The active directory the nudge is given. HR-LEFT and HR-GONE have resigned, so they are absent
  // from it — the loader passes `getEmployeeDirectoryRows()`, which returns active employees only.
  // Everyone still here is a manager: since 2026-09-25 a Medical Rep is excluded from the nudge the
  // same way a leaver is, so the recipients here are all District/Regional Managers.
  const activeDirectory = [
    { areaId: null, hrId: "HR-100", role: "District Manager" as const },
    { areaId: null, hrId: "HR-900", role: "Regional Manager" as const },
    { areaId: 7, hrId: "HR-701", role: "District Manager" as const },
    { areaId: 7, hrId: "HR-702", role: "District Manager" as const },
  ];

  const leaverWithActiveManager = groupFieldCaptureBacklog(
    [customer({ areaId: 7, managerHrId: "HR-900", ownerHrId: "HR-LEFT" })],
    activeDirectory,
  );
  assert.deepEqual(
    leaverWithActiveManager.owners.map((owner) => owner.hrId),
    ["HR-900"],
    "an owner who has left is never nudged — the customer falls through to the active manager named on it",
  );
  assert.equal(leaverWithActiveManager.owners[0].customers[0].routedVia, "manager");
  assert.equal(leaverWithActiveManager.totals.unassignedCustomers, 0);

  const leaverAndManagerGone = groupFieldCaptureBacklog(
    [customer({ areaId: 7, managerHrId: "HR-GONE", ownerHrId: "HR-LEFT" })],
    activeDirectory,
  );
  assert.deepEqual(
    leaverAndManagerGone.owners.map((owner) => owner.hrId),
    ["HR-701", "HR-702"],
    "when the manager has left too, the customer belongs to its territory: everyone active in the area is told",
  );
  assert.equal(leaverAndManagerGone.owners[0].customers[0].routedVia, "area");
  assert.ok(
    fieldCaptureNudgeMessage(leaverAndManagerGone.owners[0]).startsWith("1 marketing customer in your area"),
    "a colleague reached past a leaver is told it is in their area, never that it is theirs",
  );

  // Qena 1 on 2026-09-17: rep resigned, district manager resigned, every rep seat vacant.
  const vacantTerritory = groupFieldCaptureBacklog(
    [customer({ areaId: 42, managerHrId: "HR-GONE", ownerHrId: "HR-LEFT" })],
    activeDirectory,
  );
  assert.deepEqual(vacantTerritory.owners, [], "nobody who has left is nudged, even when nobody else can be");
  assert.equal(
    vacantTerritory.totals.unassignedCustomers,
    1,
    "with nobody active to tell, the customer is reported as unassigned rather than sent to a leaver",
  );

  const managerOnlyGone = groupFieldCaptureBacklog(
    [customer({ areaId: 7, managerHrId: "HR-GONE", ownerHrId: null })],
    activeDirectory,
  );
  assert.equal(
    managerOnlyGone.owners[0]?.customers[0]?.routedVia,
    "area",
    "a row naming only a manager who has left falls through to the territory too",
  );

  // Controls: the fix must not route an active, eligible owner's customers away.
  const activeOwner = groupFieldCaptureBacklog(
    [customer({ areaId: 7, managerHrId: "HR-900", ownerHrId: "HR-100" })],
    activeDirectory,
  );
  assert.deepEqual(activeOwner.owners.map((owner) => owner.hrId), ["HR-100"], "an active eligible owner is still chased first");
  assert.equal(activeOwner.owners[0].customers[0].routedVia, "owner");

  const casing = groupFieldCaptureBacklog(
    [customer({ ownerHrId: "hr-100" })],
    [{ areaId: null, hrId: "Hr-100", role: "District Manager" as const }],
  );
  assert.deepEqual(
    casing.owners.map((owner) => owner.hrId),
    ["HR-100"],
    "hr_id casing differs between tables — a case mismatch must never make an active owner look like a leaver",
  );

  const legacyAlias = groupFieldCaptureBacklog([customer({ ownerHrId: "AAA" })], [{ areaId: null, hrId: "AA", role: "District Manager" as const }]);
  assert.deepEqual(
    legacyAlias.owners.map((owner) => owner.hrId),
    ["AA"],
    "a legacy HR id alias resolves to the person the directory knows, not to a leaver",
  );

  // An empty directory would make every named person a leaver. The pure function does what it is
  // told; the loader is what refuses, so a failed directory read fails the cron loudly instead of
  // reporting a run that nudged nobody.
  const noDirectory = groupFieldCaptureBacklog([customer()], []);
  assert.equal(noDirectory.totals.unassignedCustomers, 1);
  assert.match(
    source("src/lib/marketing-requests/field-capture-backlog.ts"),
    /if \(employees\.length === 0\) \{\s*throw new Error\(/,
    "the loader must refuse an empty active directory rather than route every customer to nobody",
  );
}
