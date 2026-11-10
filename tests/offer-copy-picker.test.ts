import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildOfferCopyDirectory, type OfferCopyPersonRecord, type OfferCopySeatRow } from "@/lib/offers/copy-directory";
import { appendOfferCopyAddress } from "@/lib/offers/copy-recipients";

/**
 * CC and BCC picked from lists, Line → Region → Area (owner, 2026-11-10: "in the cc email field and bcc
 * make them a droplist cascading as per area line region"). He chose "Managers + HR team" for what the
 * lists hold, and "Keep typing too".
 */
export function runOfferCopyPickerTests() {
  const people = new Map<string, OfferCopyPersonRecord>([
    ["dm-1", { active: true, email: "dm1@satopharma.com", name: "Dina District" }],
    ["dm-2", { active: false, email: "gone@satopharma.com", name: "Left Already" }],
    ["rsm-1", { active: true, email: "rsm1@satopharma.com", name: "Rami Regional" }],
    ["nsm-1", { active: true, email: "nsm1@satopharma.com", name: "Nadia National" }],
    ["nsm-2", { active: true, email: null, name: "No Mail" }],
    ["b-10", { active: true, email: "omar@satopharma.com", name: "Omar Gawish" }],
    ["hr-011", { active: true, email: "ta@satopharma.com", name: "Talent Person" }],
  ]);
  const seats: OfferCopySeatRow[] = [
    { isOtherPseudoDm: false, occupantHrId: null, parentSeatId: null, seatId: "ceo", seatTier: "CEO" },
    { isOtherPseudoDm: false, occupantHrId: "NSM-1", parentSeatId: "ceo", seatId: "nsm-a", seatTier: "NSM" },
    { isOtherPseudoDm: false, occupantHrId: "NSM-2", parentSeatId: "ceo", seatId: "nsm-b", seatTier: "NSM" },
    { isOtherPseudoDm: false, occupantHrId: "RSM-1", parentSeatId: "nsm-a", seatId: "rsm-a", seatTier: "RSM" },
    { isOtherPseudoDm: false, occupantHrId: "DM-1", parentSeatId: "rsm-a", seatId: "dm-a", seatTier: "DM" },
    // A leaver still sitting on a seat reads as vacant.
    { isOtherPseudoDm: false, occupantHrId: "DM-2", parentSeatId: "nsm-b", seatId: "dm-b", seatTier: "DM" },
    { isOtherPseudoDm: true, occupantHrId: null, parentSeatId: "nsm-b", seatId: "others", seatTier: "DM" },
  ];
  const directory = buildOfferCopyDirectory({
    hrTeam: [
      { hrId: "HR-011", role: "HR Resourcing" },
      { hrId: "B-10", role: "Super Admin" },
      { hrId: "b-10", role: "Super Admin" },
    ],
    lineNames: new Map([["cns", "CNS"], ["pedia", "Pedia"]]),
    mapRows: [
      { areaCode: "a1", areaName: "Nasr City", dmSeatId: "dm-a", effectiveFrom: "2026-01-01", effectiveTo: null, lineCode: "pedia", regionCode: "r1" },
      { areaCode: "a2", areaName: "Alexandria", dmSeatId: "dm-b", effectiveFrom: "2026-01-01", effectiveTo: null, lineCode: "cns", regionCode: "r2" },
      { areaCode: "a3", areaName: "Others", dmSeatId: "others", effectiveFrom: "2026-01-01", effectiveTo: null, lineCode: "cns", regionCode: "r2" },
      // Not yet in force, and already ended: neither is anybody's area today.
      { areaCode: "a4", areaName: "Future", dmSeatId: "dm-a", effectiveFrom: "2026-12-01", effectiveTo: null, lineCode: "cns", regionCode: "r2" },
      { areaCode: "a5", areaName: "Closed", dmSeatId: "dm-a", effectiveFrom: "2025-01-01", effectiveTo: "2026-10-31", lineCode: "cns", regionCode: "r2" },
    ],
    people,
    regionNames: new Map([["r1", "Cairo East"], ["r2", "Delta"]]),
    seats,
    today: "2026-11-10",
  });

  // ── The cascade: lines, then regions, then areas, each by name ──
  assert.deepEqual(directory.lines.map((line) => line.name), ["CNS", "Pedia"]);
  const cns = directory.lines[0];
  assert.deepEqual(cns.regions.map((region) => region.name), ["Delta"]);
  assert.deepEqual(
    cns.regions[0].areas.map((area) => area.name),
    ["Alexandria", "Others"],
    "an area that has not started, or has ended, is not offered",
  );

  // ── An area's managers, nearest first: District, Regional, National ──
  const nasr = directory.lines[1].regions[0].areas[0];
  assert.deepEqual(
    nasr.people.map((person) => [person.role, person.name, person.email]),
    [
      ["District Manager", "Dina District", "dm1@satopharma.com"],
      ["Regional Manager", "Rami Regional", "rsm1@satopharma.com"],
      ["National Sales Manager", "Nadia National", "nsm1@satopharma.com"],
    ],
  );
  assert.ok(!nasr.people.some((person) => person.role === "CEO"), "the climb stops below the CEO");

  // ── A leaver's seat is vacant, and somebody with no work email is shown but cannot be added ──
  const alex = cns.regions[0].areas[0];
  assert.deepEqual(alex.people[0], { email: null, name: null, role: "District Manager", vacant: true });
  assert.deepEqual(alex.people[1], { email: null, name: "No Mail", role: "National Sales Manager", vacant: false });
  // The "Others" bucket is not a person's seat: it is skipped and the climb carries on.
  assert.deepEqual(cns.regions[0].areas[1].people.map((person) => person.role), ["National Sales Manager"]);

  // ── The HR team: the HR Manager first, by job title, never twice ──
  assert.deepEqual(
    directory.hrTeam.map((person) => [person.role, person.name]),
    [["HR Manager", "Omar Gawish"], ["Talent Acquisition", "Talent Person"]],
  );

  // ── Adding writes into the box and keeps what was typed ──
  assert.equal(appendOfferCopyAddress("", "DM1@satopharma.com"), "dm1@satopharma.com");
  assert.equal(appendOfferCopyAddress("typed@x.com", "dm1@satopharma.com"), "typed@x.com, dm1@satopharma.com");
  assert.equal(appendOfferCopyAddress("typed@x.com, ", "dm1@satopharma.com"), "typed@x.com, dm1@satopharma.com");
  assert.equal(appendOfferCopyAddress("Dm1@SatoPharma.com", "dm1@satopharma.com"), "Dm1@SatoPharma.com", "never added twice");

  // ── Wiring: the screen loads the lists without ever failing on them, and the boxes stay typeable ──
  const workspace = readFileSync("src/lib/offers/workspace.ts", "utf8");
  assert.match(workspace, /loadOfferCopyDirectory\(\)\.catch\(\(\) => EMPTY_OFFER_COPY_DIRECTORY\)/);
  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  assert.match(composer, /<OfferCopyPicker/);
  assert.match(composer, /appendOfferCopyAddress\(current\[key\], email\)/);
  assert.match(composer, /id=\{`offer-\$\{key\}`\}[\s\S]{0,200}value=\{draft\[key\]\}/, "the CC and BCC boxes stay typeable");
  const picker = readFileSync("src/components/offers/offer-copy-picker.tsx", "utf8");
  assert.doesNotMatch(picker, /from "@\/lib\/offers\/copy-directory-loader"/, "the browser never imports the database read");
  assert.match(picker, /import type \{ OfferCopyDirectory, OfferCopyPerson \} from "@\/lib\/offers\/copy-directory"/);
  const loader = readFileSync("src/lib/offers/copy-directory-loader.ts", "utf8");
  assert.match(loader, /\.in\("seat_tier", \["DM", "ACTING_DM", "RSM", "NSM", "CEO"\]\)/, "rep seats are never read");
}
