import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  buildCustomerMatchBoard,
  conflictSentence,
  pairReasons,
  PIN_FAR_FROM_PHOTO_METERS,
  PIN_ON_OTHER_METERS,
  SAME_AREA_FAR_METERS,
  sameCustomer,
  sameName,
  specialityFamily,
  type CustomerSubject,
} from "../src/lib/phoenix-crm/customer-match-groups.ts";
import { personNameWords } from "../src/lib/phoenix-crm/signboard-rules.ts";

/**
 * Phoenix CRM — one customer validated by more than one rep at places that do not agree (owner,
 * 2026-10-26, his pick "Build the check" after the audit of the same customers on several reps' lists).
 *
 * The rule is a pure module, exercised directly. The loader, the route and the screen are pinned by source.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

const METERS_PER_DEGREE = 111_195;

/** A point `meters` north of a fixed starting point. */
function at(meters: number): { lat: number; lon: number } {
  return { lat: 30 + meters / METERS_PER_DEGREE, lon: 31 };
}

let counter = 0;

function subject(overrides: Partial<CustomerSubject> & { name?: string; meters?: number } = {}): CustomerSubject {
  counter += 1;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const { name = "د. احمد صبري مشعل", meters = 0, ...rest } = overrides;
  const point = at(meters);
  return {
    key: `place:${id}`,
    id,
    seatId: `seat-${counter}`,
    repName: `Rep ${counter}`,
    territory: "Cairo 1",
    line: "CNS",
    region: "Cairo",
    title: name,
    listType: "PM",
    speciality: "IM",
    nameWords: personNameWords(name).map((word) => word.word),
    point,
    pin: null,
    photo: point,
    pinGapMeters: null,
    areaName: "مدينة نصر",
    brickName: null,
    address: null,
    capturedAt: "2026-10-20T08:00:00.000Z",
    capturedAtText: "20 Oct 2026, 11:00",
    photoPath: null,
    ...rest,
  };
}

export function runPhoenixCrmCustomerMatchGroupsTests(): void {
  // ── The name: each compound one word, a leading prefix only from three words up ────────────────
  const words = (text: string) => personNameWords(text).map((word) => word.word);
  assert.ok(sameName(words("د. احمد صبري مشعل"), words("احمد صبري مشعل")), "a title is not part of the name");
  assert.ok(sameName(words("احمد صبري مشعل"), words("احمد صبري مشعل حسن")), "a three-word name opening a longer one is that name");
  assert.ok(!sameName(words("محمد احمد"), words("محمد احمد علي")), "🔴 a two-word name matches only whole: it opens far too many other names");
  assert.ok(sameName(words("محمد احمد"), words("محمد احمد")), "and whole it does match");
  assert.ok(!sameName(words("احمد صبري مشعل"), words("صبري احمد مشعل")), "the order of the words is the name");
  assert.ok(sameName(words("عبد الناصر عبد الرازق محمد"), words("عبدالناصر عبدالرازق محمد")), "a compound is one word whether or not it is written apart");
  assert.ok(!sameName(words("احمد"), words("احمد")), "one word is never a name to compare");

  // ── The speciality: one family however it is written; unknown never separates ──────────────────
  assert.equal(specialityFamily("IM"), "internal");
  assert.equal(specialityFamily("‏باطنه"), "internal", "a direction mark is not part of the speciality");
  assert.equal(specialityFamily("Internal Medicine"), specialityFamily("im"));
  assert.equal(specialityFamily("GP + Pedia"), null, "a mixed value is unknown, never a guess");
  assert.ok(sameCustomer(subject({ speciality: "ENT" }), subject({ speciality: "انف واذن" })), "one speciality written two ways is one customer");
  assert.ok(!sameCustomer(subject({ speciality: "ENT" }), subject({ speciality: "Chest" })), "🔴 two known, different specialities are two people");
  assert.ok(sameCustomer(subject({ speciality: "ENT" }), subject({ speciality: null })), "an unknown speciality never separates two names");

  // ── Same customer: one list, two reps ─────────────────────────────────────────────────────────
  assert.ok(!sameCustomer(subject({ listType: "AM" }), subject({ listType: "PM" })), "🔴 a morning and an evening place of one person are never compared");
  const one = subject();
  assert.ok(!sameCustomer(one, { ...one, key: "place:other" }), "one rep's two validations are not two reps");

  // ── Shape A: one area, far apart ──────────────────────────────────────────────────────────────
  assert.deepEqual(pairReasons(subject(), subject({ meters: SAME_AREA_FAR_METERS + 200 })), ["same_area_far"]);
  assert.deepEqual(pairReasons(subject(), subject({ meters: SAME_AREA_FAR_METERS - 100 })), [], "within the area's distance, a second reading is not listed");
  assert.deepEqual(pairReasons(subject(), subject({ meters: 30_000, areaName: "المعادي" })), [], "two areas far apart are two clinics, never listed on distance alone");
  assert.deepEqual(pairReasons(subject({ areaName: null }), subject({ areaName: null, meters: 30_000 })), [], "no area named, no area to agree on");

  // ── Shape B: a pin on another rep's point while the photograph is elsewhere ────────────────────
  const owner = subject({ meters: 0, areaName: "شبين" });
  const pinner = subject({ areaName: "المعادي", photo: at(66_000), point: at(66_000), pin: at(PIN_ON_OTHER_METERS - 20), pinGapMeters: 66_000 });
  assert.deepEqual(pairReasons(owner, pinner), ["pin_on_other"], "🔴 a pin on another rep's point is listed whatever the area");
  const nearPhoto = subject({ areaName: "المعادي", photo: at(PIN_FAR_FROM_PHOTO_METERS - 40), point: at(PIN_FAR_FROM_PHOTO_METERS - 40), pin: at(5) });
  assert.deepEqual(pairReasons(owner, nearPhoto), [], "a pin beside his own photograph is his own reading, not another rep's");
  const pinNoPhoto = subject({ areaName: "المعادي", photo: null, point: at(60_000), pin: at(5) });
  assert.deepEqual(pairReasons(owner, pinNoPhoto), [], "without a photograph there is nothing to say where he stood");

  // ── The board: one card a customer, every validation of it, grouped by point ────────────────────
  const a1 = subject({ name: "د. كريستينا سامى فهمي", meters: 0, repName: "Mohamed Khaled" });
  const a2 = subject({ name: "كريستينا سامى فهمي", meters: 40, repName: "Another rep" });
  const a3 = subject({ name: "كريستينا سامى فهمي", meters: 5_000, repName: "Third rep" });
  const stranger = subject({ name: "محمود علي حسن", meters: 9_000 });
  const namesake = subject({ name: "كريستينا سامى فهمي", meters: 120_000, areaName: "بني سويف" });
  const board = buildCustomerMatchBoard({ subjects: [a1, a2, a3, stranger, namesake, a1] });
  assert.equal(board.conflicts.length, 1, "one customer, one card; a name nobody else validated is never listed");
  const card = board.conflicts[0];
  assert.equal(card.members.length, 3, "every validation of the customer is on the card, the agreeing ones included, and a repeated row once");
  assert.ok(!card.members.some((member) => member.key === namesake.key), "🔴 a namesake in another area, far from every listed reading, is somebody else and joins no card");
  assert.equal(card.points, 2, "two that agree make one point, the far one another");
  assert.deepEqual(
    card.members.map((member) => [member.repName, member.point_group, member.agreeing]),
    [
      ["Another rep", 1, 2],
      ["Mohamed Khaled", 1, 2],
      ["Third rep", 2, 1],
    ],
    "the largest point first, so the reading that stands alone is last",
  );
  assert.ok(card.spreadMeters >= 4_900 && card.spreadMeters <= 5_100);
  assert.equal(board.insights.conflicts, 1);
  assert.equal(board.insights.sameAreaFar, 1);
  assert.equal(board.insights.validations, 3);

  const pinned = buildCustomerMatchBoard({ subjects: [owner, pinner, a1, a3] });
  assert.equal(pinned.conflicts[0].members.some((member) => member.key === pinner.key), true, "🔴 the pin on another rep's point is listed first");
  assert.deepEqual(pinned.insights, { conflicts: 2, sameAreaFar: 1, pinOnOther: 1, validations: 4, reps: 4 });
  const sentence = conflictSentence(pinned.conflicts[0]);
  assert.match(sentence, /pin sits 30 m from Rep \d+'s validation of this customer, and 66(\.0)? km from Rep \d+'s own photograph\./);
  assert.doesNotMatch(
    [sentence, conflictSentence(board.conflicts[0])].join(" ").toLowerCase(),
    /fraud|cheat|fake|lie|copied|wrong/,
    "🔴 neutral words: where each reading sits, never a verdict on a rep",
  );

  // ── The loader, the route, the screen, the tab ────────────────────────────────────────────────
  const server = read("src/lib/phoenix-crm/server/customer-match-groups.ts");
  assert.ok(server.includes("if (!canReadPlaceMatches(viewer)) throw forbiddenError("), "🔴 the deciders' alone, refused before a row is read");
  assert.ok(server.includes("readEveryPage<Row>("), "🔴 every read is paged");
  assert.ok(server.includes("matchAnchorOf(row)"), "🔴 the photograph is the anchor — the Place checks' own rule");
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(server), "it stores nothing");

  const route = read("app/api/phoenix-crm/validation-reviews/same-customer/route.ts");
  assert.ok(route.includes('assertPermission(access, "phoenix_crm", "read")') && route.includes("loadCustomerMatchBoard(viewer)"), "a read behind `read`, and the loader checks the viewer");
  assert.ok(!route.includes("export async function POST"), "a read only");
  assert.ok(route.includes("board: { ...board, capped }"), "under the key the screen reads");

  const screen = read("src/components/phoenix-crm/customer-match-board.tsx");
  assert.ok(screen.includes('useCrmGet<BoardView>(ROUTE, "board")'), "read by the key the route answers under");
  assert.ok(!screen.includes("mode="), "🔴 the board has no manager mode");
  assert.doesNotMatch(screen, /\brounded-(?!none\b)|\boverflow-x-auto\b|\btruncate\b|\bmin-w-\[|line-clamp|text-ellipsis/, "square, no sideways scroll, no ellipsis");
  assert.doesNotMatch(screen.toLowerCase(), /\b(doctor|doctors|account|accounts)\b/, "AM and PM customers — never the old words");
  assert.ok(screen.includes("conflict.members.some((member) => subjectPasses(member, filters, cutoff))"), "🔴 a customer stays whole when any of its validations passes the shared filters");

  const shell = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(shell.includes('...(team ? [] : [{ key: "sameCustomer" as const, label: "Same customer, several reps"'), "🔴 the tab is not drawn on a manager's board");
  assert.ok(shell.includes("{!team && sameCustomerOpened ? ("), "and neither is its panel, or the read behind it");
  assert.ok(shell.includes('if (key === "sameCustomer") setSameCustomerOpened(true);'), "the read starts when the tab is first opened");
  assert.ok(shell.includes('hidden={view !== "sameCustomer"}') && shell.includes("<CustomerMatchBoardView filters={filters} />"), "and stays mounted with the shared filters");
}
