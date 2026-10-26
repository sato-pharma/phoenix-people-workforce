import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  automaticAnchor,
  bricksOf,
  buildMasterProfiles,
  clockText,
  foldSubjects,
  NOT_SET,
  PHARMACIES_GROUP,
  timingsOf,
  weekdayOf,
  weekdaysText,
  type MasterDecision,
  type MasterSubject,
  type MasterVisit,
} from "../src/lib/phoenix-crm/master-list.ts";
import { cairoMinuteOf, canDecideMasterList, canReadMasterList } from "../src/lib/phoenix-crm/server/master-list.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the Master List (owner, 2026-10-26: "build a master page for only the admin, and the CEO
 * ... the list source of trust ... separate regions and areas ... and bricks, and put in each brick per
 * speciality"; asked who confirms, "my click and automatic"; asked what the best-photo pick changes,
 * "Master profile only").
 *
 * What would break silently:
 * - one customer at two real places folded into one profile, or one place held by two reps shown twice;
 * - an AM and a PM list, or two different two-word names, folded together;
 * - a profile wearing a pin or a typed point when a photograph of the door exists;
 * - a profile "confirmed" on one photograph and nothing else, or on points that do not sit together;
 * - his click not winning, or his photo pick not becoming the profile's photo;
 * - the usual time of day or the weekdays read off the server's clock instead of Cairo's;
 * - a rep or a district manager reading the page, or the CEO confirming on it;
 * - the decision route moving a rep's own place.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/** About 1 metre of latitude. */
const METRE = 1 / 111_320;
const BASE = { lat: 30.05, lon: 31.25 };

function subject(over: Partial<MasterSubject> & { placeId: string }): MasterSubject {
  return {
    customerId: `c-${over.placeId}`,
    seatId: `s-${over.placeId}`,
    title: "Ahmed Sabry Meshaal",
    listType: "AM",
    speciality: null,
    nameWords: ["ahmed", "sabry", "meshaal"],
    point: BASE,
    pointIsPhoto: true,
    accuracyMeters: 10,
    photoPath: `seat/2026/10/place/${over.placeId}.jpg`,
    regionName: "Cairo",
    areaName: "Nasr City",
    brickName: "Abbas El Akkad",
    address: null,
    capturedAt: "2026-10-01T08:00:00.000Z",
    repName: `Rep ${over.placeId}`,
    lineName: "CNS",
    ...over,
  };
}

function north(metres: number) {
  return { lat: BASE.lat + metres * METRE, lon: BASE.lon };
}

function visit(customerId: string, over: Partial<MasterVisit> = {}): MasterVisit {
  return { customerId, visitDate: "2026-10-25", minuteOfDay: 600, dwellSeconds: 600, atPlace: true, repHrId: "R-1", ...over };
}

function foldTests() {
  const near = foldSubjects([subject({ placeId: "a" }), subject({ placeId: "b", point: north(60) })]);
  assert.equal(near.length, 1, "one name, one list, 60 m apart is one place");
  assert.equal(near[0].length, 2);

  const far = foldSubjects([subject({ placeId: "a" }), subject({ placeId: "b", point: north(1_000) })]);
  assert.equal(far.length, 2, "one name 1 km apart is two places, two profiles");

  const lists = foldSubjects([subject({ placeId: "a" }), subject({ placeId: "b", listType: "PM" })]);
  assert.equal(lists.length, 2, "an AM and a PM list are never folded");

  const twoWords = foldSubjects([
    subject({ placeId: "a", nameWords: ["ahmed", "ali"] }),
    subject({ placeId: "b", nameWords: ["ahmed", "ali", "hassan"] }),
  ]);
  assert.equal(twoWords.length, 2, "a two-word name matches only whole");

  const longer = foldSubjects([subject({ placeId: "a" }), subject({ placeId: "b", nameWords: ["ahmed", "sabry", "meshaal", "hassan"] })]);
  assert.equal(longer.length, 1, "a three-word name opening a longer one is one name");

  const noPoint = foldSubjects([subject({ placeId: "a" }), subject({ placeId: "b", point: null })]);
  assert.equal(noPoint.length, 2, "a place with no point is never folded by distance");

  const all = foldSubjects([subject({ placeId: "a" }), subject({ placeId: "b", point: north(60) }), subject({ placeId: "c", point: north(5_000) })]);
  assert.equal(all.flat().length, 3, "every subject lands in exactly one profile");
}

function anchorTests() {
  const photo = subject({ placeId: "photo", accuracyMeters: 40 });
  const pin = subject({ placeId: "pin", pointIsPhoto: false, accuracyMeters: 3 });
  assert.equal(automaticAnchor([pin, photo]).placeId, "photo", "a photograph of the door beats a sharper pin");

  const lonely = subject({ placeId: "lonely", point: north(400), accuracyMeters: 2 });
  const agreed = subject({ placeId: "agreed", accuracyMeters: 30 });
  const friend = subject({ placeId: "friend", point: north(40), accuracyMeters: 30 });
  assert.equal(automaticAnchor([lonely, agreed, friend]).placeId, "agreed", "the photograph most others agree with wins over the sharpest");
}

function statusTests() {
  const [twoReps] = buildMasterProfiles({
    subjects: [subject({ placeId: "a" }), subject({ placeId: "b", point: north(60) })],
    visits: [],
    decisions: [],
  });
  assert.equal(twoReps.status, "confirmed", "two reps' photographs that agree confirm it");
  assert.equal(twoReps.statusSource, "automatic");
  assert.equal(twoReps.members.length, 2);
  assert.equal(twoReps.spreadMeters, 60);

  const [sameRepTwice] = buildMasterProfiles({
    subjects: [subject({ placeId: "a", seatId: "one" }), subject({ placeId: "b", seatId: "one", point: north(20) })],
    visits: [],
    decisions: [],
  });
  assert.equal(sameRepTwice.status, "needs_look", "one rep's two photographs are not two reps agreeing");

  const [apart] = buildMasterProfiles({
    subjects: [subject({ placeId: "a" }), subject({ placeId: "b", point: north(300) })],
    visits: [],
    decisions: [],
  });
  assert.equal(apart.status, "needs_look", "points that do not sit together need a look");
  assert.match(apart.reason, /do not all sit together/);

  const single = subject({ placeId: "single" });
  const settled = buildMasterProfiles({
    subjects: [single],
    visits: [visit(single.customerId), visit(single.customerId), visit(single.customerId)],
    decisions: [],
  })[0];
  assert.equal(settled.status, "confirmed", "one photograph and three visits at the place confirm it");

  const unsettled = buildMasterProfiles({ subjects: [single], visits: [visit(single.customerId), visit(single.customerId)], decisions: [] })[0];
  assert.equal(unsettled.status, "needs_look", "one photograph and two visits do not");

  const strayed = buildMasterProfiles({
    subjects: [single],
    visits: [visit(single.customerId), visit(single.customerId), visit(single.customerId, { atPlace: false })],
    decisions: [],
  })[0];
  assert.equal(strayed.status, "needs_look", "visits read away from the place do not settle it");

  const unphotographed = buildMasterProfiles({ subjects: [subject({ placeId: "p", pointIsPhoto: false })], visits: [], decisions: [] })[0];
  assert.equal(unphotographed.status, "needs_look", "no photograph of the door is never confirmed");

  for (const profile of [twoReps, apart, settled, unsettled, unphotographed]) {
    assert.doesNotMatch(profile.reason, /fake|fraud|lie|cheat|wrong place/i, "a reason is neutral, never an accusation");
  }
}

function decisionTests() {
  const decision = (anchorPlaceId: string, verdict: MasterDecision["verdict"]): MasterDecision => ({
    anchorPlaceId,
    verdict,
    note: null,
    decidedByName: "Omar Gawish",
    decidedAt: "2026-10-26T14:00:00.000Z",
  });
  const subjects = [subject({ placeId: "a" }), subject({ placeId: "b", point: north(60) })];

  const [rejected] = buildMasterProfiles({ subjects, visits: [], decisions: [decision("a", "rejected")] });
  assert.equal(rejected.status, "rejected", "his Not confirmed wins over the photographs");
  assert.equal(rejected.statusSource, "owner");
  assert.equal(rejected.reason, "Not confirmed by Omar Gawish");

  const automatic = automaticAnchor(subjects).placeId;
  const other = automatic === "a" ? "b" : "a";
  const [picked] = buildMasterProfiles({ subjects, visits: [], decisions: [decision(other, "confirmed")] });
  assert.equal(picked.id, other, "his photo pick becomes the profile's anchor");
  assert.equal(picked.anchor.placeId, other);
  assert.equal(picked.members[0].placeId, other, "the picked photo is drawn first");
  assert.equal(picked.status, "confirmed");

  const [confirmedLonely] = buildMasterProfiles({
    subjects: [subject({ placeId: "z", pointIsPhoto: false })],
    visits: [],
    decisions: [decision("z", "confirmed")],
  });
  assert.equal(confirmedLonely.status, "confirmed", "his Confirm wins over the automatic needs-a-look");
}

function timingTests() {
  const visits = [540, 600, 660, 720].map((minuteOfDay, index) =>
    visit("c", { minuteOfDay, dwellSeconds: (index + 1) * 300, repHrId: index < 2 ? "R-1" : "R-2" }),
  );
  const timings = timingsOf(visits);
  assert.equal(timings.visits, 4);
  assert.equal(timings.repsVisiting, 2);
  assert.equal(timings.earliest, 540);
  assert.equal(timings.latest, 720);
  assert.equal(timings.usualFrom, 585, "the usual window is the middle half of the capture times");
  assert.equal(timings.usualTo, 675);
  assert.equal(timings.shortestMinutes, 5);
  assert.equal(timings.longestMinutes, 20);
  assert.equal(timings.typicalMinutes, 13);

  assert.equal(weekdayOf("2026-10-25"), 0, "25 October 2026 is a Sunday");
  assert.equal(weekdayOf("2026-10-29"), 4, "29 October 2026 is a Thursday");
  assert.equal(weekdaysText([2, 0, 3, 0, 0, 0, 0]), "Tue 3 · Sun 2");
  assert.equal(weekdaysText([0, 0, 0, 0, 0, 0, 0]), "No visits yet");
  assert.equal(clockText(0), "12:00 am");
  assert.equal(clockText(12 * 60 + 5), "12:05 pm");
  assert.equal(clockText(9 * 60 + 30), "9:30 am");

  // Cairo's clock, never the server's: 07:30 UTC in January is 09:30 in Cairo (UTC+2).
  assert.equal(cairoMinuteOf("2026-01-15T07:30:00.000Z"), 9 * 60 + 30);
  assert.equal(cairoMinuteOf("not a time"), null);
  assert.equal(cairoMinuteOf(null), null);

  const empty = timingsOf([]);
  assert.equal(empty.visits, 0);
  assert.equal(empty.usualFrom, null);
  assert.equal(empty.typicalMinutes, null);
}

function brickTests() {
  const profiles = buildMasterProfiles({
    subjects: [
      subject({ placeId: "ph", listType: "Pharmacy", title: "El Ezaby", nameWords: ["el", "ezaby"], brickName: "Zahraa" }),
      subject({ placeId: "dr", title: "Mona Adel Samir", nameWords: ["mona", "adel", "samir"], speciality: null, brickName: "Zahraa" }),
      subject({ placeId: "nb", title: "Karim Nabil Fawzy", nameWords: ["karim", "nabil", "fawzy"], brickName: null }),
      subject({ placeId: "ab", title: "Hany Saad Ali", nameWords: ["hany", "saad", "ali"], brickName: "Abbas" }),
    ],
    visits: [],
    decisions: [],
  });
  const bricks = bricksOf(profiles);
  assert.deepEqual(
    bricks.map((brick) => brick.brickName),
    ["Abbas", "Zahraa", NOT_SET],
    "bricks sort by name with the unset brick last",
  );
  const zahraa = bricks.find((brick) => brick.brickName === "Zahraa");
  assert.equal(zahraa?.groups.at(-1)?.label, PHARMACIES_GROUP, "pharmacies are their own group, last in the brick");
  assert.equal(zahraa?.groups[0].label, "Speciality not set");
}

function gateTests() {
  const viewer: { isSuperAdmin: boolean; role: PhoenixRole; isTestPersona: boolean; canUpdate: boolean } = {
    isSuperAdmin: false,
    role: "CEO",
    isTestPersona: false,
    canUpdate: true,
  };
  assert.equal(canReadMasterList({ ...viewer, isSuperAdmin: true, role: "Super Admin" }), true, "the Super Admin reads it");
  assert.equal(canReadMasterList(viewer), true, "the CEO reads it");
  assert.equal(canReadMasterList({ ...viewer, role: "District Manager" }), false, "a district manager never reads it");
  assert.equal(canReadMasterList({ ...viewer, role: "Medical Rep" }), false, "a rep never reads it");
  assert.equal(canReadMasterList({ ...viewer, isTestPersona: true }), false, "a test persona never reads it");

  assert.equal(canDecideMasterList(viewer), false, "the CEO reads but never confirms");
  assert.equal(canDecideMasterList({ ...viewer, isSuperAdmin: true }), true, "the Super Admin confirms");
  assert.equal(canDecideMasterList({ ...viewer, isSuperAdmin: true, canUpdate: false }), false);
  assert.equal(canDecideMasterList({ ...viewer, isSuperAdmin: true, isTestPersona: true }), false);
}

function sourceTests() {
  const route = read("app/api/phoenix-crm/master-list/decision/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the decision route refuses a cross-site post");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "update"\)/, "the decision route checks the permission first");
  assert.match(route, /saveMasterDecision\(/);

  const server = read("src/lib/phoenix-crm/server/master-list.ts");
  const placeWrites = server.match(/from\("phoenix_crm_places"\)\s*\.(insert|update|upsert|delete)/g);
  assert.equal(placeWrites, null, "nothing on the Master List moves a rep's place");
  assert.match(server, /from\("phoenix_crm_places"\)\s*\.select/);
  assert.match(server, /if \(!canDecideMasterList\(viewer\)\) throw forbiddenError/, "saving checks the Super Admin before anything");
  assert.match(server, /if \(!canReadMasterList\(viewer\)\) throw forbiddenError/, "reading checks the reader before anything");

  const page = read("app/(admin)/admin/phoenix-crm/master-list/page.tsx");
  assert.match(page, /canReadMasterList\(viewer\)\) redirect\("\/admin"\)/, "the page sends anyone else away");

  const migration = read("supabase/migrations/20261026165500_phoenix_crm_master_decisions.sql");
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.phoenix_crm_master_decisions from public, anon, authenticated;/);
  assert.match(migration, /grant all on table public\.phoenix_crm_master_decisions to service_role;/);
  assert.doesNotMatch(migration, /\bto (anon|authenticated)\b/, "the browser roles get nothing");
  assert.doesNotMatch(migration, /phoenix_crm_places\s+(set|add|alter)/i, "the migration never changes the reps' places");

  const navigation = read("src/config/system-navigation.ts");
  assert.match(navigation, /\/admin\/phoenix-crm\/master-list/);
}

export async function runPhoenixCrmMasterListTests() {
  foldTests();
  anchorTests();
  statusTests();
  decisionTests();
  timingTests();
  brickTests();
  gateTests();
  sourceTests();
}
