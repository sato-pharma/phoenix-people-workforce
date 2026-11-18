import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  compareLookalikeNames,
  nearWord,
  pairKey,
  phoneKey,
  planLineLookalikeJoins,
  planLineLookalikes,
  planLookalikeConfirm,
  planLookalikeJoin,
  type LookalikeCustomer,
  type LookalikeInput,
} from "../src/lib/phoenix-crm/line-lookalikes.ts";
import type { TwinPlace } from "../src/lib/phoenix-crm/line-twins.ts";

/**
 * Phoenix CRM — the same customer on another line, written differently: the Super Admin's confirmation
 * list (owner, 2026-11-16, "Fix rule + review list": "Nothing is validated without that confirmation").
 *
 * 1. Names: a one-word slip, the words reordered, a middle name left out are one name; a long vowel added
 *    or dropped (محمد / محمود) and two common given names (محمد / احمد) are not.
 * 2. The list: a waiting row and a validated row on another line of its area, Certain (same phone or old-CRM
 *    contact) or Very likely (the name), that the three-lines rule did NOT pair. Never: a pair the rule
 *    pairs, a clinic doctor without three names, a known speciality against it, two kinds of facility, a
 *    pharmacy, a pair answered "Not the same", a copy as the source's place.
 * 3. The confirmation: re-checks every guard and hands back the places to share and whose validation it is.
 * 4. By source: the Super Admin's alone at the loader and the answer, the share door with him as the actor
 *    and the other line's validator kept, the route's two gates, the tab drawn on his board only and read
 *    when first opened, and the screen square, with no sideways scroll and no ellipsis.
 *
 * Break direction: drop the `areLineTwins` line in `planLineLookalikes` and the "the rule's own pair" case
 * fails; drop the long-vowel guard in `nearWord` and the محمد / محمود case fails; drop the `notSame` check
 * and the answered case fails.
 */

const CAIRO = { lat: 30.05, lon: 31.23 };

let serial = 0;
function customer(overrides: Partial<LookalikeCustomer>): LookalikeCustomer {
  serial += 1;
  return {
    id: `c${serial}`,
    seatId: "cns-ca1",
    lineCode: "cns",
    areaCode: "CA1",
    isTest: false,
    listType: "PM",
    name: "احمد صبري مشعل",
    speciality: null,
    status: "pending",
    validatedAt: null,
    validatedByHrId: null,
    pendingReview: false,
    pendingDrop: false,
    fullNameHeld: false,
    phone: null,
    referenceContactId: null,
    ...overrides,
  };
}

function validated(overrides: Partial<LookalikeCustomer>): LookalikeCustomer {
  return customer({ seatId: "pedia-ca1", lineCode: "pedia", status: "active", validatedAt: "2026-11-01T08:00:00Z", validatedByHrId: "R-1", ...overrides });
}

function place(owner: LookalikeCustomer, overrides: Partial<TwinPlace> = {}): TwinPlace {
  serial += 1;
  return {
    id: `p${serial}`,
    customerId: owner.id,
    seatId: owner.seatId,
    pointSource: "photo",
    lat: CAIRO.lat,
    lon: CAIRO.lon,
    accuracyMeters: 10,
    capturedAt: "2026-11-01T08:00:00Z",
    ...overrides,
  };
}

/** The list for one waiting row and one validated row (with a photo place of its own). */
function listFor(waiting: LookalikeCustomer, source: LookalikeCustomer, extra: Partial<LookalikeInput> = {}) {
  return planLineLookalikes({ customers: [waiting, source], places: [place(source)], notSame: new Set(), ...extra });
}

// ── 1. Names ─────────────────────────────────────────────────────────────────────────────────────

function runNameTests(): void {
  const none = new Set<string>();
  assert.equal(compareLookalikeNames(["احمد", "صبري", "مشعل"], ["احمد", "صبري", "معشل"], none), "typo", "two letters swapped is one slip");
  assert.equal(compareLookalikeNames(["احمد", "صبري", "مشعل"], ["صبري", "احمد", "مشعل"], none), "reordered");
  assert.equal(compareLookalikeNames(["احمد", "مشعل"], ["احمد", "صبري", "مشعل"], none), "middle_dropped");
  assert.equal(compareLookalikeNames(["محمود", "علي", "حسن"], ["محمد", "علي", "حسن"], none), null, "محمد and محمود are two men");
  assert.equal(nearWord("سعيد", "سعد"), false, "a long vowel is never a slip");
  assert.equal(compareLookalikeNames(["محمد", "علي", "حسن"], ["احمد", "علي", "حسن"], none), null, "a short given name one letter apart is never a slip");
  assert.equal(compareLookalikeNames(["علي", "محمد", "حسن"], ["علي", "احمد", "حسن"], new Set(["محمد", "احمد"])), "name_differs", "two common names as the father's name: a relative, not a slip");
  assert.equal(phoneKey("٠١٠١٢٣٤٥٦٧٨"), "1012345678", "Arabic digits read as Western");
  assert.equal(phoneKey("+20 101 234 5678"), "1012345678");
  assert.equal(phoneKey("12345"), null, "too short to be a phone");
}

// ── 2. The list ──────────────────────────────────────────────────────────────────────────────────

function runListTests(): void {
  {
    const waiting = customer({});
    const source = validated({ name: "احمد صبري معشل" });
    const list = listFor(waiting, source);
    assert.equal(list.length, 1, "one word mistyped on another line");
    assert.equal(list[0].confidence, "very_likely");
    assert.equal(list[0].nameKind, "typo");
    assert.equal(list[0].key, pairKey(waiting.id, source.id));
    assert.equal(list[0].sourcePlaceIds.length, 1);
  }
  {
    const list = listFor(customer({ phone: "01012345678" }), validated({ name: "احمد صبري", phone: "+20 10 1234 5678" }));
    assert.equal(list.length, 1);
    assert.equal(list[0].confidence, "certain", "the same phone number and a name that opens the other is certain");
    assert.equal(list[0].samePhone, true);
  }
  {
    const list = listFor(customer({ referenceContactId: "777" }), validated({ name: "احمد صبري", referenceContactId: "777" }));
    assert.equal(list[0]?.confidence, "certain", "the same old-CRM contact is certain");
  }
  assert.deepEqual(listFor(customer({}), validated({})), [], "the rule's own pair is the rule's to share, never this list's");
  assert.deepEqual(listFor(customer({ name: "احمد صبري" }), validated({ name: "احمد صبري مشعل" })), [], "a clinic doctor without three names cannot be validated");
  assert.deepEqual(
    listFor(customer({ speciality: "Pediatrics" }), validated({ name: "احمد صبري معشل", speciality: "Chest" })),
    [],
    "a known speciality against it drops it below Very likely",
  );
  assert.deepEqual(listFor(customer({ seatId: "pedia-ca2", lineCode: "pedia" }), validated({ name: "احمد صبري معشل" })), [], "the same line is never compared");
  assert.deepEqual(listFor(customer({ areaCode: "CA2" }), validated({ name: "احمد صبري معشل" })), [], "another area is somebody else");
  assert.deepEqual(
    listFor(customer({ listType: "Pharmacy", name: "صيدلية الشفاء" }), validated({ listType: "Pharmacy", name: "صيدليه الشفا" })),
    [],
    "no line shares a pharmacy's validation",
  );
  {
    const waiting = customer({});
    const source = validated({ name: "احمد صبري معشل" });
    assert.deepEqual(listFor(waiting, source, { notSame: new Set([pairKey(waiting.id, source.id)]) }), [], "an answered pair is never asked again");
    assert.deepEqual(
      listFor(waiting, source, { notSame: new Set([pairKey(source.id, waiting.id)]) }),
      [],
      "answered the other way round (a join card stores joining|anchor), it is never asked again either",
    );
  }
  {
    const waiting = customer({});
    const source = validated({ name: "احمد صبري معشل" });
    assert.deepEqual(
      planLineLookalikes({ customers: [waiting, source], places: [place(source, { pointSource: "line_twin" })], notSame: new Set() }),
      [],
      "a copy from another line is never the source's own place",
    );
  }
  {
    // Accounts: one rare name is one account; two kinds of facility never are.
    const list = listFor(customer({ listType: "AM", name: "مستشفى النيل التخصصى" }), validated({ listType: "AM", name: "مستشفي نيل" }));
    assert.equal(list.length, 1, "the same rare hospital name, one list adding its descriptor");
    assert.deepEqual(
      listFor(customer({ listType: "AM", name: "مستشفى النيل حميات" }), validated({ listType: "AM", name: "مستشفي نيل" })),
      [],
      "the fever hospital is not the general one",
    );
  }
  {
    // One rep holds the customer twice: both rows are listed, each flagged.
    const first = customer({});
    const second = customer({ name: "احمد صبرى مشعل" });
    const source = validated({ name: "احمد صبري معشل" });
    const list = planLineLookalikes({ customers: [first, second, source], places: [place(source)], notSame: new Set() });
    assert.equal(list.length, 2);
    assert.ok(list.every((pair) => pair.twiceOnWaitingList), "the waiting rep's list holds him twice");
  }
}

// ── 3. The confirmation ──────────────────────────────────────────────────────────────────────────

function runConfirmTests(): void {
  const waiting = customer({});
  const source = validated({ name: "احمد صبري معشل", validatedByHrId: "R-9" });
  const own = place(source);
  const input: LookalikeInput = { customers: [waiting, source], places: [own], notSame: new Set() };
  const plan = planLookalikeConfirm(input, waiting.id, source.id);
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.deepEqual(plan.sourcePlaceIds, [own.id]);
    assert.equal(plan.validatedByHrId, "R-9", "the validation stays the other line's validator's");
  }
  assert.deepEqual(
    planLookalikeConfirm({ ...input, notSame: new Set([pairKey(source.id, waiting.id)]) }, waiting.id, source.id),
    { ok: false, refusal: "answered_not_same" },
    "a Not the same answered from the other customer's card still refuses the confirmation",
  );
  const meanwhile = { ...input, customers: [{ ...waiting, status: "active", validatedAt: "2026-11-16T08:00:00Z" }, source] };
  assert.deepEqual(planLookalikeConfirm(meanwhile, waiting.id, source.id), { ok: false, refusal: "not_waiting" }, "validated meanwhile: nothing to confirm");
  assert.deepEqual(planLookalikeConfirm({ ...input, places: [] }, waiting.id, source.id), { ok: false, refusal: "source_not_validated" });
  assert.deepEqual(planLookalikeConfirm(input, waiting.id, "gone"), { ok: false, refusal: "not_found" });
  const twin = validated({});
  assert.deepEqual(
    planLookalikeConfirm({ customers: [waiting, twin], places: [place(twin)], notSame: new Set() }, waiting.id, twin.id),
    { ok: false, refusal: "rule_pairs_them" },
  );
}

// ── 4. By source ─────────────────────────────────────────────────────────────────────────────────

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

function runSourceTests(): void {
  const server = read("src/lib/phoenix-crm/server/line-lookalikes.ts");
  assert.ok(server.includes("return !viewer.isTestPersona && viewer.isSuperAdmin && viewer.canApprove;"), "🔴 the Super Admin alone, never as a test account");
  assert.doesNotMatch(
    server,
    /\.filter\(\(held\) => held\.waitingCustomerId === waitingCustomerId && held\.sourceCustomerId === sourceCustomerId\)/,
    "the confirm path loads the answers about the pair in BOTH directions, as the join path does",
  );
  assert.equal(
    server.split("if (!canReviewLineLookalikes(viewer)) throw forbiddenError(").length - 1,
    2,
    "🔴 the read and the answer both refuse everyone else before a row is read",
  );
  assert.ok(server.includes("readEveryPage<Row>("), "🔴 every read is paged");
  assert.ok(server.includes('callPhoenixCrm<Row>("phoenix_crm_share_line_validation"'), "a confirmation validates through the three-lines rule's own door");
  assert.ok(server.includes("actor_hr_id: viewer.hrId") && server.includes("validated_by_hr_id: plan.validatedByHrId"), "he is the actor; the other line's validator keeps the validation");
  assert.ok(server.includes("planLookalikeConfirm("), "every guard is asked again before it validates");
  assert.ok(server.includes('await afterResponse("phoenix-crm line look-alike: post-validation records"'), "the answer never waits for the records after it");
  // 🔴 THE PHOTOGRAPH IS WHAT HE JUDGES A PAIR BY (owner, 2026-11-17: "must render the validation photo and details").
  const evidenceColumns = (/const PLACE_EVIDENCE_COLUMNS =\s*"([^"]+)"/.exec(server)?.[1] ?? "").split(",").map((column) => column.trim());
  assert.ok(
    ["photo_path", "photo_lat", "pin_lat", "signboard_check", "schedule_check", "shared_place_id", "created_by_hr_id"].every((column) =>
      evidenceColumns.includes(column),
    ),
    "🔴 every place a pair would copy is read with its photograph and the evidence Place checks shows beside it",
  );
  assert.ok(server.includes('selectByIds<Row>("phoenix_crm_places", PLACE_EVIDENCE_COLUMNS,'), "through that one column list");
  assert.ok(server.includes("pairs.flatMap((pair) => pair.sourcePlaceIds)"), "every place a pair would copy, never only the first");
  assert.ok(server.includes(".map((row) => placeEvidence(row, names, venueNames))"), "each one carried to the card");

  const route = read("app/api/phoenix-crm/validation-reviews/line-lookalikes/route.ts");
  assert.ok(route.includes('assertPermission(access, "phoenix_crm", "read")') && route.includes("loadLineLookalikeBoard(viewer)"), "a read behind `read`");
  assert.ok(route.includes("assertSameOriginMutation(request)") && route.includes('assertPermission(access, "phoenix_crm", "approve")'), "the answer behind `approve` and the same-origin check");
  assert.ok(route.includes("NextResponse.json({ board, success: true })") && route.includes("NextResponse.json({ saved, success: true })"), "under the keys the screen reads");

  const screen = read("src/components/phoenix-crm/line-lookalike-board.tsx");
  assert.ok(screen.includes('useCrmGet<LineLookalikeBoard>(ROUTE, "board")'), "read by the key the route answers under");
  assert.ok(screen.includes('"saved");'), "the answer read by the key the route answers under");
  assert.ok(screen.includes("row.source.places.map((place) => ("), "🔴 every place the waiting row would take is drawn on the card");
  assert.ok(
    screen.includes("path={place.photoPath}") && screen.includes("className={PLACE_CHECK_PHOTO_CLASS}") && screen.includes("rotatable"),
    "🔴 with its photograph, at Place checks' own size, whole and turnable",
  );
  assert.ok(screen.includes("<PlaceInUseEvidence row={place} />"), "and Place checks' own evidence block beside it, never a copy");
  assert.doesNotMatch(screen, /\brounded-(?!none\b)|\boverflow-x-auto\b|\btruncate\b|\bmin-w-\[|line-clamp|text-ellipsis/, "square, no sideways scroll, no ellipsis");
  assert.doesNotMatch(screen.toLowerCase(), /\b(doctor|doctors|account|accounts)\b/, "AM and PM customers — never the old words");

  const shell = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(
    shell.includes('...(!team && canRestore ? [{ key: "lineLookalikes" as const, label: "Same customer, other line"'),
    "🔴 the tab is drawn on the Super Admin's board only",
  );
  assert.ok(shell.includes("{!team && canRestore && lineLookalikesOpened ? ("), "and so is its panel, and the read behind it");
  assert.ok(shell.includes('if (key === "lineLookalikes") setLineLookalikesOpened(true);'), "the read starts when the tab is first opened");
  assert.ok(shell.includes("<LineLookalikeBoardView filters={filters} />"), "with the shared filters");
}

// ── 5. Two validated rows: the join (owner, 2026-11-17: "i want phx 2 recognize as 1") ───────────────

/** A point `meters` north of Cairo's test point. */
function north(meters: number): { lat: number; lon: number } {
  return { lat: CAIRO.lat + meters / 111_195, lon: CAIRO.lon };
}

function runJoinTests(): void {
  const cns = validated({ seatId: "cns-ca1", lineCode: "cns", name: "احمد صبري مشعل" });
  const pedia = validated({ name: "احمد صبري معشل" });
  const cnsPlace = place(cns, { accuracyMeters: 5 });
  const pediaPlace = place(pedia, { ...north(40), accuracyMeters: 12 });
  const input: LookalikeInput = { customers: [cns, pedia], places: [cnsPlace, pediaPlace], notSame: new Set() };

  const joins = planLineLookalikeJoins(input);
  assert.equal(joins.length, 1, "both lines validated one customer under two spellings, 40 m apart: one join to confirm");
  assert.equal(joins[0].anchorCustomerId, cns.id, "the sharper photograph is the point that stays");
  assert.equal(joins[0].joiningCustomerId, pedia.id, "…and Pedia's row moves onto it");
  assert.equal(joins[0].key, pairKey(pedia.id, cns.id));
  assert.deepEqual(joins[0].moves.map((move) => [move.placeId, move.anchorPlaceId, move.distanceMeters]), [[pediaPlace.id, cnsPlace.id, 40]]);
  assert.equal(joins[0].confidence, "very_likely");
  assert.deepEqual(planLineLookalikes(input), [], "a join is never put on the validate list: neither row waits");

  const onePoint = planLineLookalikeJoins({ ...input, places: [cnsPlace, place(pedia, { accuracyMeters: 12 })] });
  assert.equal(onePoint.length, 1, "already on one point: still listed, so his word makes them one");
  assert.deepEqual(onePoint[0].moves, [], "…and nothing moves");
  assert.equal(onePoint[0].gapMeters, 0);

  assert.deepEqual(planLineLookalikeJoins({ ...input, places: [cnsPlace, place(pedia, north(200))] }), [], "200 m apart may be two clinics: never listed");
  assert.deepEqual(
    planLineLookalikeJoins({ ...input, customers: [cns, { ...pedia, name: cns.name }] }),
    [],
    "the exact same name is the three-lines rule's to join, never this list's",
  );
  assert.deepEqual(
    planLineLookalikeJoins({ ...input, places: [place(cns, { pointSource: "moved" }), place(pedia, { ...north(40), pointSource: "trusted" })] }),
    [],
    "two points set by hand: neither moves, so nothing is listed",
  );
  assert.deepEqual(planLineLookalikeJoins({ ...input, notSame: new Set([pairKey(cns.id, pedia.id)]) }), [], "answered Not the same, in either order");
  assert.deepEqual(planLineLookalikeJoins({ ...input, confirmed: new Set([pairKey(pedia.id, cns.id)]) }), [], "already joined: not listed again");
  assert.deepEqual(
    planLineLookalikeJoins({ ...input, customers: [cns, { ...pedia, seatId: "cns-ca9", lineCode: "cns" }] }),
    [],
    "two rows of one line are never joined here",
  );
  assert.deepEqual(planLineLookalikeJoins({ ...input, customers: [cns, { ...pedia, areaCode: "CA2" }] }), [], "another area is somebody else");

  const plan = planLookalikeJoin(input, pedia.id, cns.id);
  assert.ok(plan.ok, "his confirmation is carried out on a fresh read");
  if (plan.ok) {
    assert.equal(plan.anchor.id, cns.id, "the direction is decided again, whichever way the card named them");
    assert.equal(plan.moves.length, 1);
  }
  assert.deepEqual(planLookalikeJoin(input, cns.id, pedia.id).ok, true, "either order");
  assert.deepEqual(planLookalikeJoin({ ...input, customers: [cns, { ...pedia, status: "pending", validatedAt: null }] }, pedia.id, cns.id), { ok: false, refusal: "not_validated" });
  assert.deepEqual(planLookalikeJoin({ ...input, places: [cnsPlace, place(pedia, north(200))] }, pedia.id, cns.id), { ok: false, refusal: "too_far" });
  assert.deepEqual(planLookalikeJoin({ ...input, notSame: new Set([pairKey(pedia.id, cns.id)]) }, cns.id, pedia.id), { ok: false, refusal: "answered_not_same" });
  assert.deepEqual(planLookalikeJoin(input, pedia.id, "gone"), { ok: false, refusal: "not_found" });

  const server = read("src/lib/phoenix-crm/server/line-lookalikes.ts");
  assert.ok(server.includes('if (body.mode === "join") return joinLineLookalike(viewer, waitingCustomerId, sourceCustomerId);'), "the answer routes a join card to the join");
  assert.ok(/applyLineTwinMerges\(plan\.moves, viewer\.config\.settings, viewer\.hrId\)/.test(server), "the join moves through the rule's own audited move, the Super Admin as the actor");
  assert.ok(/saveAnswer\(viewer, plan\.joining\.id, plan\.anchor\.id, "same"\)/.test(server), "and keeps his answer (joining, anchor)");
  assert.ok(server.indexOf("applyLineTwinMerges(plan.moves") < server.indexOf('saveAnswer(viewer, plan.joining.id'), "the answer is saved only after the places moved");
  assert.ok(server.includes("planLineLookalikeJoins(input)") && server.includes('mode: "join"'), "the board lists the joins");
  const screen = read("src/components/phoenix-crm/line-lookalike-board.tsx");
  assert.ok(screen.includes("mode: row.mode") && screen.includes("Same customer — join them") && screen.includes("row.joiningPlaces.map"), "the card sends its mode, says what it does and draws both photographs");
}

export function runPhoenixCrmLineLookalikesTests(): void {
  runNameTests();
  runListTests();
  runConfirmTests();
  runSourceTests();
  runJoinTests();
}
