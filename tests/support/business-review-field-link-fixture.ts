import type { ReviewSalesDetail } from "@/lib/business-review/concentration";
import type {
  ContactVisitTally,
  FieldLinkFacts,
  ListedContact,
  RepDayFact,
  RideFact,
} from "@/lib/business-review/field-link";

/**
 * ONE territory with every linked fact, for every test that needs the work-against-results sections.
 *
 * Annotated literals throughout (no `as` casts): the local runner strips types, so a fixture that
 * no longer matches `FieldLinkFacts` would still run green here and fail only in CI's typecheck —
 * annotated, `tsc` names the missing field at THIS file.
 *
 * THE SHAPE IS CHOSEN SO EVERY BRICK READING FIRES EXACTLY ONCE (see field-link.ts):
 *
 *   B1  70,000 sold · 12 class A doctors, 5 reached · 6 visits  → "Big sales, few visits"
 *   B2  20,000 sold ·  4 class A doctors, 4 reached · 12 visits → "In balance"
 *   B3  10,000 sold · 10 class A doctors, 2 reached · 32 visits → "Class A doctors missed"
 *   B5   4,000 sold · nobody on the list                        → "Sales here, nobody on the list"
 *   B4       0 sold ·  3 class A doctors, all reached · 40 visits → "Many visits, small sales"
 *
 * plus 4 visits to a customer the register places on no brick, so the scope total is 94 visits.
 */

export const REP = "REP-1";
export const OTHER_REP = "REP-2";
export const MANAGER = "DM-1";
export const SEAT = "SEAT-DM-1";

const doctor = (
  id: number,
  brickId: string | null,
  grade: string,
  over: Partial<ListedContact> = {},
): ListedContact => ({
  brickId,
  bucket: "PM",
  contactId: id,
  grade,
  lastVisitedOn: null,
  name: `Doctor ${id}`,
  repHrId: REP,
  speciality: "Pediatrics",
  ...over,
});

const tally = (visits: number, brickId: string | null, bucket: "am" | "pm" | "pharmacies" = "pm"): ContactVisitTally => ({
  brickId,
  lastVisit: "2026-08-10",
  split: { am: bucket === "am" ? visits : 0, pharmacies: bucket === "pharmacies" ? visits : 0, pm: bucket === "pm" ? visits : 0 },
  visits,
});

export function fixtureContacts(): ListedContact[] {
  const out: ListedContact[] = [];
  // B1: 12 class A doctors, the first five reached; two grade-B doctors never reached; one pharmacy.
  for (let i = 0; i < 12; i += 1) out.push(doctor(1000 + i, "B1", "A"));
  out.push(doctor(1100, "B1", "B"), doctor(1101, "B1", "B"));
  out.push(doctor(1200, "B1", "A", { bucket: "Pharmacies", name: "Pharmacy One", speciality: "Pharmacy" }));
  // B2: 4 class A doctors, all reached — one of them ALSO on the other rep's list (a list passed on).
  for (let i = 0; i < 4; i += 1) out.push(doctor(2000 + i, "B2", "A"));
  out.push(doctor(2000, "B2", "A", { repHrId: OTHER_REP }));
  // B2 also holds a class A account (AM) that nobody reached.
  out.push(doctor(2100, "B2", "A", { bucket: "AM", name: "General Hospital", speciality: "Hospital" }));
  // B3: 10 class A doctors, two reached.
  for (let i = 0; i < 10; i += 1) out.push(doctor(3000 + i, "B3", "A", { lastVisitedOn: i === 9 ? "2026-05-02" : null }));
  // B4: 3 class A doctors, all reached, and nothing sold there.
  for (let i = 0; i < 3; i += 1) out.push(doctor(4000 + i, "B4", "A"));
  return out;
}

export function fixtureVisits(): Record<string, ContactVisitTally> {
  const visits: Record<string, ContactVisitTally> = {};
  for (let i = 0; i < 5; i += 1) visits[String(1000 + i)] = tally(1, "B1");
  visits["1200"] = tally(1, "B1", "pharmacies");
  for (let i = 0; i < 4; i += 1) visits[String(2000 + i)] = tally(3, "B2");
  visits["3000"] = tally(1, "B3");
  visits["3001"] = tally(1, "B3");
  // A customer on NO list in the pack, placed in B3 by the register — his visits are still B3's work.
  visits["9000"] = tally(30, "B3");
  visits["4000"] = tally(13, "B4");
  visits["4001"] = tally(13, "B4");
  visits["4002"] = tally(14, "B4");
  // A customer the register cannot place: in the total, in no brick.
  visits["9500"] = tally(4, null);
  return visits;
}

export function fixtureBrickSales(): Pick<ReviewSalesDetail, "brickId" | "brickName" | "channel" | "value">[] {
  return [
    { brickId: "B1", brickName: "Brick One", channel: "distributor", value: 65000 },
    { brickId: "B1", brickName: "Brick One", channel: "direct", value: 5000 },
    { brickId: "B2", brickName: "Brick Two", channel: "distributor", value: 20000 },
    { brickId: "B3", brickName: "Brick Three", channel: "wholesaler", value: 10000 },
    { brickId: "B5", brickName: "Brick Five", channel: "distributor", value: 4000 },
  ];
}

/**
 * The owner's own double-visit example (2026-10-01): "a DM has 5 in the team, he always goes with 3
 * and never or rarely with the other 2" — plus a sixth rep with no field day in the period, who must
 * never be marked forgotten.
 */
export function fixtureRides(): { rides: RideFact[]; repDays: RepDayFact[] } {
  const team = [REP, "REP-3", "REP-4", "REP-5", "REP-6"];
  const days: Record<string, [number, number]> = {
    [REP]: [3, 3],
    "REP-3": [3, 3],
    "REP-4": [3, 2],
    "REP-5": [1, 0],
    "REP-6": [0, 0],
  };
  const rides: RideFact[] = [];
  const repDays: RepDayFact[] = [];
  for (const rep of team) {
    ["2026-07", "2026-08"].forEach((period, i) => {
      const d = days[rep][i];
      if (d > 0) rides.push({ days: d, managerHrId: MANAGER, period, repHrId: rep, visits: d * 6 });
      repDays.push({
        fieldDays: 20,
        fieldVisits: 200,
        period,
        repHrId: rep,
        split: { am: 40, pharmacies: 40, pm: 120 },
      });
    });
  }
  // REP-7 sits in the team but worked no field day in either month.
  return { repDays, rides };
}

export const TEAM = [REP, "REP-3", "REP-4", "REP-5", "REP-6", "REP-7"];

export function fixtureFacts(over: Partial<FieldLinkFacts> = {}): FieldLinkFacts {
  const { rides, repDays } = fixtureRides();
  return {
    awareness: [
      {
        activityId: "act-1",
        areaCode: "CA1",
        brickIds: ["B1"],
        bucket: "pending",
        cost: 45000,
        expectedAttendees: 30,
        line: "Pedia",
        repHrId: REP,
        startDate: "2026-10-12",
        status: "pending_ceo",
        title: "Round table on infant nutrition",
        typeName: "Round table",
      },
    ],
    brickNames: { B1: "Brick One", B2: "Brick Two", B3: "Brick Three", B4: "Brick Four", B5: "Brick Five" },
    contacts: fixtureContacts(),
    directOrders: [
      {
        areaCode: "CA1",
        brickId: "B1",
        doctorName: "Doctor 1000",
        line: "Pedia",
        pharmacyName: "Pharmacy One",
        requestId: "do-1",
        requesterName: "Manager One",
        salesMonth: "2026-08",
        value: 5000,
      },
      {
        areaCode: "CA1",
        brickId: "B2",
        doctorName: null,
        line: "Pedia",
        pharmacyName: "Pharmacy Two",
        requestId: "do-2",
        requesterName: "Manager One",
        salesMonth: null,
        value: 2500,
      },
    ],
    listBeforeHistory: false,
    managers: [{ dmSeatId: SEAT, hrId: MANAGER, name: "Manager One" }],
    marketing: [
      {
        areaCode: "CA1",
        bucket: "committed",
        code: "MR-1",
        cost: 5000,
        customerName: "Doctor 1000",
        line: "Pedia",
        period: "2026-08",
        requestId: "mr-1",
        requesterHrId: REP,
        requesterName: "Rep One",
        requiredReturn: 50000,
        returnSoFar: 12500,
        status: "active",
        typeName: "Sponsorship",
      },
    ],
    months: ["2026-07", "2026-08"],
    names: {
      [MANAGER]: "Manager One",
      [OTHER_REP]: "Rep Two",
      [REP]: "Rep One",
      "REP-3": "Rep Three",
      "REP-4": "Rep Four",
      "REP-5": "Rep Five",
      "REP-6": "Rep Six",
      "REP-7": "Rep Seven",
    },
    repDays,
    repHrIds: [REP],
    rides,
    ridesOutside: [{ days: 2, managerHrId: MANAGER, period: "2026-08" }],
    visitsByContact: fixtureVisits(),
    ...over,
  };
}
