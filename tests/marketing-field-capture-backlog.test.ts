import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { DESK_VALIDATION_MARKER, INFERRED_HISTORY_MARKER } from "../src/lib/customer-pharmacy-mapping/readiness.ts";
import { marketingCreatorRoles } from "../src/lib/marketing-requests/service.ts";
import {
  FIELD_CAPTURE_ACTION_URL,
  FIELD_CAPTURE_CHANNELS,
  fieldCaptureNudgeMessage,
  groupFieldCaptureBacklog,
  type FieldCaptureBacklogInput,
} from "../src/lib/marketing-requests/field-capture-backlog.ts";

// The two notes production actually holds, built from the markers themselves so that renaming a
// marker breaks this test loudly instead of quietly making every case below stop matching.
const BACKFILL_NOTE = `Inferred from pending/rejected historical marketing requests — ${INFERRED_HISTORY_MARKER}. Backfill script 2026-07-02.`;
const DESK_NOTE = `Location chosen from map search — ${DESK_VALIDATION_MARKER}`;

function customer(overrides: Partial<FieldCaptureBacklogInput> = {}): FieldCaptureBacklogInput {
  return {
    areaId: null,
    customerCode: "MKT-C-0001",
    customerEvidenceStatus: "missing",
    customerId: "c1",
    customerName: "Ahmed Fouad",
    links: [{ pharmacyEvidenceStatus: "missing", pharmacyName: "El Ezaby Nasr City", validationNotes: BACKFILL_NOTE }],
    managerHrId: null,
    ownerHrId: "HR-100",
    ...overrides,
  };
}

export function runMarketingFieldCaptureBacklogTests() {
  // ── The nudge can never disagree with the badge ────────────────────────────────────────────
  // This is the whole design: the backlog delegates the WHETHER to `customerFieldEvidenceGap`,
  // the badge's own function. A rep must never be chased about a row showing no badge on screen.
  const unproven = groupFieldCaptureBacklog([customer()]);
  assert.equal(unproven.totals.customers, 1, "a backfilled customer with no evidence is unproven");

  // Evidence on the VENUE half alone clears it — which is what #2352 made possible long after the
  // visit, and precisely the 15 links that PR #2354 cleared in production.
  const venueProven = groupFieldCaptureBacklog([
    customer({
      links: [{ pharmacyEvidenceStatus: "complete", pharmacyName: "El Ezaby Nasr City", validationNotes: BACKFILL_NOTE }],
    }),
  ]);
  assert.equal(venueProven.totals.customers, 0, "a captured venue clears the customer");
  assert.deepEqual(venueProven.owners, [], "nobody is nudged about a proven customer");

  // Evidence on the CUSTOMER half alone clears it too.
  const customerProven = groupFieldCaptureBacklog([customer({ customerEvidenceStatus: "complete" })]);
  assert.equal(customerProven.totals.customers, 0, "a captured customer clears itself");

  // "pending" is not "complete" — a half-finished capture proves nothing.
  const pending = groupFieldCaptureBacklog([customer({ customerEvidenceStatus: "pending" })]);
  assert.equal(pending.totals.customers, 1, "a pending capture is not proof");

  // ── EVERY, never SOME ─────────────────────────────────────────────────────────────────────
  // One link a rep really walked to is enough. Chasing this customer would call that rep a liar.
  const oneRealVisit = groupFieldCaptureBacklog([
    customer({
      links: [
        { pharmacyEvidenceStatus: "missing", pharmacyName: "El Ezaby Nasr City", validationNotes: BACKFILL_NOTE },
        { pharmacyEvidenceStatus: "missing", pharmacyName: "Seif Heliopolis", validationNotes: null },
      ],
    }),
  ]);
  assert.equal(oneRealVisit.totals.customers, 0, "one genuinely captured link clears the customer");

  // ── The reason survives the trip ──────────────────────────────────────────────────────────
  assert.equal(unproven.owners[0].customers[0].gap, "inferred");
  const desk = groupFieldCaptureBacklog([
    customer({
      links: [{ pharmacyEvidenceStatus: "missing", pharmacyName: "Seif Heliopolis", validationNotes: DESK_NOTE }],
    }),
  ]);
  assert.equal(desk.owners[0].customers[0].gap, "desk", "a desk validation is its own reason, not backfill");
  const mixed = groupFieldCaptureBacklog([
    customer({
      links: [
        { pharmacyEvidenceStatus: "missing", pharmacyName: "El Ezaby Nasr City", validationNotes: BACKFILL_NOTE },
        { pharmacyEvidenceStatus: "missing", pharmacyName: "Seif Heliopolis", validationNotes: DESK_NOTE },
      ],
    }),
  ]);
  assert.equal(mixed.owners[0].customers[0].gap, "mixed");
  assert.deepEqual(
    mixed.owners[0].customers[0].venueNames,
    ["El Ezaby Nasr City", "Seif Heliopolis"],
    "the rep is told which shops to photograph",
  );

  // ── Who gets chased ───────────────────────────────────────────────────────────────────────
  const owned = groupFieldCaptureBacklog([customer({ managerHrId: "HR-900", ownerHrId: "HR-100" })]);
  assert.equal(owned.owners[0].hrId, "HR-100", "the rep who owns it is chased, not their manager");
  assert.equal(owned.owners[0].routedVia, "owner");

  const managed = groupFieldCaptureBacklog([customer({ managerHrId: "HR-900", ownerHrId: null })]);
  assert.equal(managed.owners[0].hrId, "HR-900", "with no rep named, the manager is chased");
  assert.equal(managed.owners[0].routedVia, "manager");

  // An empty string is not an owner — the column is free text, and a blank is not a person.
  const blank = groupFieldCaptureBacklog([customer({ managerHrId: "HR-900", ownerHrId: "   " })]);
  assert.equal(blank.owners[0].hrId, "HR-900", "a blank owner falls through to the manager");

  // ── Nobody is dropped ─────────────────────────────────────────────────────────────────────
  // Production held 53 such links on 2026-08-23. A naive group-by-owner loses them in silence,
  // and the covered count then reads as though the whole backlog were assigned to somebody.
  const orphaned = groupFieldCaptureBacklog([
    customer({ customerCode: "MKT-C-0002", customerId: "c2", managerHrId: null, ownerHrId: null }),
    customer(),
  ]);
  assert.equal(orphaned.totals.customers, 2, "an unassigned customer still counts as backlog");
  assert.equal(orphaned.totals.unassignedCustomers, 1, "the count of nudgeable-by-nobody customers is reported");
  assert.equal(orphaned.unassigned.length, 1, "it is returned, not dropped");
  assert.equal(orphaned.unassigned[0].customerCode, "MKT-C-0002");
  assert.equal(orphaned.owners.length, 1, "and it is billed to nobody");

  // ── A customer belongs to a TERRITORY, not to a person ───────────────────────────
  // Owner's ruling, 2026-08-19. Production 2026-08-23 held 20 customers naming neither a rep nor a
  // manager, and every one of them carried an area — so stopping at owner/manager would abandon
  // all 20 to nobody. The area test mirrors `canSeeMarketingCustomer` exactly, which is what makes
  // it safe: everyone reached this way can actually see the row on the page the nudge links to.
  const byArea = groupFieldCaptureBacklog(
    [customer({ areaId: 7, customerCode: "MKT-C-0010", customerId: "c10", managerHrId: null, ownerHrId: null })],
    [
      { areaId: 7, hrId: "HR-701" },
      { areaId: 7, hrId: "hr-702" },
      { areaId: 9, hrId: "HR-901" },
    ],
  );
  assert.equal(byArea.totals.unassignedCustomers, 0, "an ownerless customer in a staffed area is not abandoned");
  assert.deepEqual(
    byArea.owners.map((owner) => owner.hrId),
    ["HR-701", "HR-702"],
    "every colleague working that territory is told, and nobody from another area is",
  );
  assert.equal(byArea.owners[0].routedVia, "area", "the run says WHY this person was picked");

  // Fanning one customer out to several colleagues must not inflate the backlog: it is still ONE
  // customer of work, however many people can see it.
  assert.equal(byArea.totals.customers, 1, "one customer stays one customer, however many are told");

  // A named owner still wins outright — the territory is a fallback, not an override. Chasing a
  // whole area about a customer that already names its rep is noise.
  const ownerBeatsArea = groupFieldCaptureBacklog(
    [customer({ areaId: 7, ownerHrId: "HR-100" })],
    [{ areaId: 7, hrId: "HR-701" }],
  );
  assert.deepEqual(ownerBeatsArea.owners.map((owner) => owner.hrId), ["HR-100"], "a named rep is not diluted");

  // An area with nobody in it is a STAFFING fact, and is reported rather than silently swallowed.
  const emptyArea = groupFieldCaptureBacklog(
    [customer({ areaId: 42, managerHrId: null, ownerHrId: null })],
    [{ areaId: 7, hrId: "HR-701" }],
  );
  assert.equal(emptyArea.unassigned.length, 1, "an unstaffed area is still reported, not dropped");

  // An employee with no area of their own matches nothing — the same way the visibility rule
  // treats head office. Otherwise every arealess employee would be nudged about every customer.
  const areallessStaff = groupFieldCaptureBacklog(
    [customer({ areaId: 7, managerHrId: null, ownerHrId: null })],
    [{ areaId: null, hrId: "HR-800" }],
  );
  assert.equal(areallessStaff.unassigned.length, 1, "an employee with no area is not everybody's rep");

  // ── HR id casing ──────────────────────────────────────────────────────────────────────────
  // This schema stores hr_id in mixed case. Two spellings of one rep must be ONE notification and
  // not two — the same trap that once hid 28% of a rep's own direct orders.
  const mixedCase = groupFieldCaptureBacklog([
    customer({ customerCode: "MKT-C-0003", customerId: "c3", ownerHrId: "hr-100" }),
    customer(),
  ]);
  assert.equal(mixedCase.owners.length, 1, "one rep, one bucket, whatever the casing");
  assert.equal(mixedCase.owners[0].customers.length, 2);

  // Busiest rep first, so a run can be read top-down.
  const ranked = groupFieldCaptureBacklog([
    customer({ customerCode: "MKT-C-0004", customerId: "c4", ownerHrId: "HR-200" }),
    customer({ customerCode: "MKT-C-0005", customerId: "c5", ownerHrId: "HR-100" }),
    customer(),
  ]);
  assert.deepEqual(
    ranked.owners.map((owner) => owner.hrId),
    ["HR-100", "HR-200"],
  );
  assert.equal(ranked.totals.owners, 2);

  // ── What the rep is told ──────────────────────────────────────────────────────────────────
  const message = fieldCaptureNudgeMessage(ranked.owners[0]);
  assert.ok(message.includes("Ahmed Fouad"), "the message names the customer, never a bare code");
  assert.ok(!message.includes("…") && !message.includes("..."), "never truncate with an ellipsis");
  assert.ok(
    fieldCaptureNudgeMessage(unproven.owners[0]).startsWith("1 of your marketing customer "),
    "one customer reads as English, not as a plural",
  );

  // ── The rep must be able to OPEN what the nudge links to ────────────────────────
  // The Customer Database screen is the obvious-looking destination and a 403 for every one of
  // them: `assertMarketingCustomerDatabaseAccess` admits Super Admin and SFE Manager ONLY. A
  // daily notification to 51 medical reps pointing at a forbidden page is worse than no
  // notification at all, because it teaches them to ignore the next one.
  assert.ok(FIELD_CAPTURE_ACTION_URL.startsWith("/employee-portals/"), "a rep cannot open an admin route");
  assert.ok(
    !FIELD_CAPTURE_ACTION_URL.includes("customer-database"),
    "the customer database is Super Admin / SFE Manager only, so the nudge must not land there",
  );
  assert.ok(
    marketingCreatorRoles.has("Medical Rep"),
    "the destination gate must admit the people being nudged",
  );
  assert.ok(
    existsSync(new URL(`../app${FIELD_CAPTURE_ACTION_URL}/page.tsx`, import.meta.url)),
    "the nudge links to a page that actually exists",
  );

  // A colleague reached through the territory is not told the customer is theirs — it is not, and
  // a nudge that misstates the relationship gets dismissed as wrong rather than acted on.
  const areaMessage = fieldCaptureNudgeMessage(byArea.owners[0]);
  assert.ok(areaMessage.startsWith("1 marketing customer in your area"), "territory wording, not ownership");
  assert.ok(!areaMessage.includes("your marketing"), "a colleague is never told the customer is theirs");
  assert.ok(
    fieldCaptureNudgeMessage(owned.owners[0]).startsWith("1 of your marketing customer"),
    "a named owner IS told it is theirs",
  );

  // ── Never email ───────────────────────────────────────────────────────────────────────────
  // A daily job addressing 51 reps is bulk email by any reading, and bulk email is never fired
  // from this system. The list is pinned here so that reinstating email has to be deliberate.
  assert.ok(!(FIELD_CAPTURE_CHANNELS as readonly string[]).includes("email"), "the daily nudge must never email");
  assert.deepEqual([...FIELD_CAPTURE_CHANNELS], ["in_app", "telegram", "push"]);

  // An empty database is not an error.
  assert.deepEqual(groupFieldCaptureBacklog([]), {
    owners: [],
    totals: { customers: 0, owners: 0, unassignedCustomers: 0 },
    unassigned: [],
  });
}
