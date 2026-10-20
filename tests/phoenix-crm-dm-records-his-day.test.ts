import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { ownDaySeat, territoryForDayWrite, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Phoenix CRM — a DISTRICT manager records HIS OWN day (owner, 2026-10-20: the District Sales Manager's
 * Add visit screen showed the seven day tiles greyed under "recorded by the territory's own rep", and
 * he answered "let her record the day").
 *
 * 🔴 THE OBVIOUS IMPLEMENTATION IS THE WRONG ONE: a day activity is one row per seat per day, so
 * unlocking the tiles on the REP's seat would let a manager's meeting replace the rep's own day. The
 * row lands on the manager's OWN seat (the unified visits view already counts a day on it), and the
 * rep's day stays the rep's. The regional manager was added the same night ("let regional managers
 * record their own day too"); a national manager stays out.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const CEO: OrgSeat = {
  seatId: "SEAT-ROOT-CEO",
  parentSeatId: null,
  tier: "CEO",
  path: ["SEAT-ROOT-CEO"],
  occupantHrId: "C-1",
  lineCode: null,
  lineName: null,
  areaName: null,
  regionName: null,
  seatLabel: "CEO",
};
const RSM: OrgSeat = {
  ...CEO,
  seatId: "SEAT-AIF-RSM",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "RSM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-RSM"],
  occupantHrId: "B-3",
  lineCode: "anti_infective",
  lineName: "Anti Infective",
  seatLabel: "AIF RSM",
};
/** A national manager with a rep straight under him: the tier neither of the owner's words reached. */
const NSM: OrgSeat = { ...RSM, seatId: "SEAT-CNS-NSM", tier: "NSM", path: ["SEAT-ROOT-CEO", "SEAT-CNS-NSM"], occupantHrId: "B-1", seatLabel: "CNS NSM" };
const NSM_REP: OrgSeat = {
  ...RSM,
  seatId: "SEAT-CNS-REP-N1",
  parentSeatId: "SEAT-CNS-NSM",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-CNS-NSM", "SEAT-CNS-REP-N1"],
  occupantHrId: "B-40",
  seatLabel: "CNS N1 rep",
};
const DM: OrgSeat = {
  ...RSM,
  seatId: "SEAT-AIF-DM-D1",
  parentSeatId: "SEAT-AIF-RSM",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-RSM", "SEAT-AIF-DM-D1"],
  occupantHrId: "B-12",
  seatLabel: "AIF Delta (1) DM",
};
const REP: OrgSeat = {
  ...DM,
  seatId: "SEAT-AIF-REP-D13",
  parentSeatId: "SEAT-AIF-DM-D1",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-RSM", "SEAT-AIF-DM-D1", "SEAT-AIF-REP-D13"],
  occupantHrId: "B-7",
  areaName: "Menoufia 2",
  seatLabel: "AIF D13 rep",
};
const OTHER_DM: OrgSeat = {
  ...DM,
  seatId: "SEAT-AIF-DM-D2",
  occupantHrId: "B-20",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-RSM", "SEAT-AIF-DM-D2"],
  seatLabel: "AIF Delta (2) DM",
};
const OTHER_REP: OrgSeat = {
  ...REP,
  seatId: "SEAT-AIF-REP-D21",
  parentSeatId: "SEAT-AIF-DM-D2",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-RSM", "SEAT-AIF-DM-D2", "SEAT-AIF-REP-D21"],
  occupantHrId: "B-21",
};

const org = buildOrgIndex([CEO, RSM, DM, REP, OTHER_DM, OTHER_REP, NSM, NSM_REP]);

function viewer(patch: Partial<PhoenixCrmViewer> = {}): PhoenixCrmViewer {
  return {
    hrId: "B-12",
    role: "District Manager",
    isSuperAdmin: false,
    isSfeManager: false,
    isTestPersona: false,
    basis: "tree",
    canCreate: true,
    canApprove: true,
    canUpdate: true,
    org,
    config: { lineRollout: [] },
    cairoToday: "2026-10-20",
    visitDay: "2026-10-20",
    openLines: new Set(["anti_infective"]),
    ownTerritories: [],
    waitingTerritories: [],
    scopeTerritories: [REP],
    waitingScopeTerritories: [],
    managerSeats: [DM],
    ...patch,
  } as unknown as PhoenixCrmViewer;
}

const repViewer = viewer({ hrId: "B-7", role: "Medical Rep", canApprove: false, ownTerritories: [REP], scopeTerritories: [REP], managerSeats: [] });
const rsmViewer = viewer({ hrId: "B-3", role: "Regional Manager", scopeTerritories: [REP, OTHER_REP], managerSeats: [RSM] });
const peerViewer = viewer({ hrId: "B-20", scopeTerritories: [OTHER_REP], managerSeats: [OTHER_DM] });
const nsmViewer = viewer({ hrId: "B-1", role: "National Sales Manager", scopeTerritories: [NSM_REP], managerSeats: [NSM] });

function refused(run: () => unknown, pattern: RegExp, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof Error && pattern.test(error.message), message);
}

export function runPhoenixCrmDmRecordsHisDayTests(): void {
  // ── 1. The district manager's day sits on HIS seat, never the rep's ───────────────────────────
  {
    assert.equal(ownDaySeat(viewer(), REP)?.seatId, DM.seatId, "from a rep's territory, her day is recorded on her own team seat");
    const write = territoryForDayWrite(viewer(), REP.seatId, false);
    assert.equal(write.seat.seatId, DM.seatId, "the row lands on the manager's seat — one row per seat per day, so the rep's own day is never replaced");
    assert.equal(write.own, "manager");
    assert.equal(write.seat.occupantHrId, "B-12", "and the person whose day it is, is the manager");
  }

  // ── 2. The rep keeps his own day, and the manager never reaches it ────────────────────────────
  {
    assert.equal(ownDaySeat(repViewer, REP), null, "the rep has no manager seat to record on");
    const write = territoryForDayWrite(repViewer, REP.seatId, false);
    assert.equal(write.seat.seatId, REP.seatId);
    assert.equal(write.own, "rep");
  }

  // ── 3. Everyone else is refused exactly as before ─────────────────────────────────────────────
  {
    assert.equal(ownDaySeat(peerViewer, REP), null, "another district's manager is outside the chain");
    refused(() => territoryForDayWrite(peerViewer, REP.seatId, false), /Only the territory's rep/, "a peer is refused");
    // The regional manager was added the same night ("let regional managers record their own day too"):
    // his day lands on HIS seat, past the district manager below him, never on the rep's or the DM's.
    assert.equal(ownDaySeat(rsmViewer, REP)?.seatId, RSM.seatId, "a regional manager records his own day on his own regional seat");
    const regional = territoryForDayWrite(rsmViewer, REP.seatId, false);
    assert.equal(regional.seat.seatId, RSM.seatId, "never on the district manager's seat between them");
    assert.equal(regional.own, "manager");
    // A national manager was named in neither word.
    assert.equal(ownDaySeat(nsmViewer, NSM_REP), null, "a national manager is not widened");
    refused(() => territoryForDayWrite(nsmViewer, NSM_REP.seatId, false), /Only the territory's rep/, "a national manager is refused");
    assert.equal(ownDaySeat(viewer({ isSuperAdmin: true }), REP), null, "the Super Admin records nothing in the field");
    refused(() => territoryForDayWrite(viewer({ isSuperAdmin: true }), REP.seatId, false), /Super Admin does not/, "and is told so by name");
    assert.equal(ownDaySeat(viewer({ canCreate: false }), REP), null, "a role that cannot create anything records no day");
  }

  // ── 4. Wired through, not just decided ────────────────────────────────────────────────────────
  {
    const service = source("src/lib/phoenix-crm/server/day-activities.ts");
    assert.ok(service.includes("territoryForDayWrite(viewer, raw.seatId"), "the save asks the day gate");
    assert.equal(service.includes("territoryForRepWrite("), false, "and no longer asks the rep-only gate for a day");
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.ok(visits.includes("canSetOwnDayActivity: ownSeat !== null"), "the day view says whether HE may record his own day");
    assert.ok(visits.includes("canSetDayActivity: date === today && canWriteAsRep(viewer, seat, isTest)"), "and the rep's own gate is untouched — the panels it guards stay the rep's");
    const tab = source("src/components/phoenix-crm/visits-tab.tsx");
    assert.ok(tab.includes("view.canSetDayActivity || view.canSetOwnDayActivity"), "the start screen unlocks the tiles for him");
    assert.ok(tab.includes("view.canSetOwnDayActivity ? view.ownDayActivity : view.dayActivity"), "and shows HIS recorded day, not the rep's");
  }
}
