import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GOOGLE_MATCH_METERS,
  GOOGLE_STALE_PIN_METERS,
  MISMATCH_REFUSALS_BEFORE_HOLD,
  LOCATION_CHECKING_PILL,
  LOCATION_CHECKING_TEXT,
  LOCATION_CHECKING_TITLE,
  LOCATION_NOT_CONFIRMED_TEXT,
  googleCheckApplies,
  googleMismatchMessage,
  judgeGooglePlace,
  listingIsAccount,
  mismatchIsHeld,
  type GoogleListing,
} from "../src/lib/phoenix-crm/google-place-rules.ts";
import { listRowAction } from "../src/lib/phoenix-crm/list-request-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A place is checked against the account's own Google Maps listing before it is accepted (owner,
// 2026-10-03): first that the listing IS the account, then that the rep stood within 150 m of it. A
// mismatch is refused at the door; an account Google has no listing for is held for the Super Admin —
// "only system admin can approve or reject … show him that it's automated from system".
//
// The name cases below are the REAL validations of Delta (1)'s first morning, 3 Oct 2026, each against
// the listing Google Maps returned for it. The ones that must NOT match are the traps: a different
// hospital on the same street, a name that shares only "hospital", a stale name for a moved hospital.
// ─────────────────────────────────────────────────────────────────────────────

function listing(name: string, lat: number, lon: number): GoogleListing {
  return { placeId: name, name, lat, lon, mapsUri: null };
}

export function runPhoenixCrmGooglePlaceCheckTests() {
  // ── The owner's numbers and scope ─────────────────────────────────────────────
  assert.equal(GOOGLE_MATCH_METERS, 150, "the match line is 150 m (owner, 2026-10-03)");
  assert.equal(googleCheckApplies("AM"), true, "AM accounts are checked — 'especially in the AM accounts'");
  assert.equal(googleCheckApplies("PM"), false, "a private doctor's clinic is too often missing from Google to hold on");
  assert.equal(googleCheckApplies("Pharmacy"), false);

  // ── Step 1: is the listing the account? Real names, 3 Oct 2026 ────────────────
  const same: Array<[string, string]> = [
    ["مستشفي صدر المحلة", "مستشفى صدر المحلة الكبرى"],
    ["المركز الطبي", "المركز الطبى ببنها - مكتب صحة رابع"],
    ["مستشفي التعليمي", "مستشفى بنها التعليمى"],
    ["مستشفي الصدر", "مستشفى الصدر Pulmonology ( Chest ) Hospital"],
    ["مستشفي الصحة النفسية", "مستشفى الصحة النفسية Benha Psychiatry Hospital"],
    ["مركز بنها الطبي", "المركز الطبى ببنها - مكتب صحة رابع"],
    ["الوحده الصحيه بزناره", "الوحدة الصحية بزنارة"],
    ["مستشفى المنشاوى العام", "مستشفى المنشاوى العام"],
    ["مستشفى جراحات اليوم الواحد اشمون", "مستشفى جراحات اليوم الواحد بشمون"],
    ["رعاية اول المحله", "رعاية طفل اول المحلة الكبرى"],
    ["مستشفي صدر كفر الشيخ", "مستشفى الصدر بكفر الشيخ"],
    ["مستشفي حميات كفر الشيخ", "مستشفي حميات كفرالشيخ"],
    ["مستشفى المحلة العام", "مستشفى المحلة الكبرى العام"],
    ["مستشفي أشمون العام", "مستشفى أشمون العام"],
  ];
  for (const [customer, google] of same) {
    assert.equal(listingIsAccount(customer, google), true, `"${google}" is the account "${customer}"`);
  }
  const different: Array<[string, string, string]> = [
    ["مستشفي النفسيه والعصبيه", "مركز الطب النفسي", "a psychiatry centre is not the psychiatry AND neurology hospital — held, never guessed"],
    ["مستشفي النفسيه والعصبيه", "مستشفى طنطا للصحه النفسيه وعلاج الادمان", "an addiction hospital nearby"],
    ["تعاقد الكهرباء طنطا", "شركة جنوب الدلتا لتوزيع الكهرباء", "a contract named for the company is not the company's listing"],
    ["مستشفي صدر المحلة", "مستشفى المحلة الكبرى العام", "the general hospital of the same town is a different account"],
    ["مستشفى المنشاوى العام", "مستشفى طنطا العام سبرباي", "the new building Al-Menshawy moved to carries another name"],
    ["المركز الطبي", "مركز جلو دكتورة مروه شديد أفضل دكتورة جلديه و تجميل و ليزر في بنها", "a private clinic that merely says centre"],
    ["مستشفي الصدر", "مستشفى بنها التعليمى", "a neighbouring hospital on the same campus"],
    ["مستشفى", "مستشفى بنها التعليمى", "'hospital' alone names no account"],
  ];
  for (const [customer, google, why] of different) {
    assert.equal(listingIsAccount(customer, google), false, `"${google}" is NOT "${customer}" — ${why}`);
  }

  // ── Step 2: did he stand at it? ───────────────────────────────────────────────
  const sadrMahalla = listing("مستشفى صدر المحلة الكبرى", 30.95253, 31.150634);
  // Hassan Mohamed at the door, 3.6 m accurate — 118 m from Google's pin.
  const hassan = judgeGooglePlace({ customerName: "مستشفي صدر المحلة", point: { lat: 30.9524180656755, lon: 31.1518645740707 }, listings: [sadrMahalla] });
  assert.equal(hassan.kind, "match", "the honest door validation of 3 Oct matches");
  assert.ok(hassan.kind === "match" && hassan.distanceMeters <= GOOGLE_MATCH_METERS);

  // Yasmeen Samy's frozen Benha point — 434 m from the Chest Hospital's own pin.
  const yasmeen = judgeGooglePlace({
    customerName: "مستشفي الصدر",
    point: { lat: 30.4684684684685, lon: 31.1899555209043 },
    listings: [listing("مستشفى الصدر Pulmonology ( Chest ) Hospital", 30.465722, 31.186733)],
  });
  assert.equal(yasmeen.kind, "mismatch", "the 2 km approximate-location point of 3 Oct is refused at the door");
  assert.ok(yasmeen.kind === "mismatch" && yasmeen.distanceMeters > 400);

  // Exactly on the line, and one past it.
  const onLine = judgeGooglePlace({ customerName: "مستشفى أشمون العام", point: { lat: 30.0, lon: 31.0 }, listings: [listing("مستشفى أشمون العام", 30.0 + 150 / 111_195, 31.0)] });
  assert.equal(onLine.kind, "match", "150 m is inside the line");
  const pastLine = judgeGooglePlace({ customerName: "مستشفى أشمون العام", point: { lat: 30.0, lon: 31.0 }, listings: [listing("مستشفى أشمون العام", 30.0 + 152 / 111_195, 31.0)] });
  assert.equal(pastLine.kind, "mismatch", "152 m is outside it");

  // The account's pin over 1 km away is HELD, never refused (owner, 2026-10-03: "hold it for me").
  // Al-Menshawy moved to the new Tanta General building in Sibirai; Google kept its pin on the old site
  // 3.6 km off, so a refusal there could never be passed by standing anywhere.
  assert.equal(GOOGLE_STALE_PIN_METERS, 1000);
  const menshawy = judgeGooglePlace({
    customerName: "مستشفى المنشاوى العام",
    point: { lat: 30.77, lon: 31.0 },
    listings: [listing("مستشفى المنشاوى العام", 30.77 + 3600 / 111_195, 31.0), listing("مستشفى طنطا العام سبرباي", 30.7701, 31.0001)],
  });
  assert.equal(menshawy.kind, "far_listing", "a moved hospital's stale pin is held for the Super Admin, never a lock-out");
  assert.ok(menshawy.kind === "far_listing" && menshawy.distanceMeters > 3500 && menshawy.listing.name === "مستشفى المنشاوى العام");
  const justInside = judgeGooglePlace({ customerName: "مستشفى أشمون العام", point: { lat: 30.0, lon: 31.0 }, listings: [listing("مستشفى أشمون العام", 30.0 + 995 / 111_195, 31.0)] });
  assert.equal(justInside.kind, "mismatch", "under 1 km is still refused at the door");
  const justPast = judgeGooglePlace({ customerName: "مستشفى أشمون العام", point: { lat: 30.0, lon: 31.0 }, listings: [listing("مستشفى أشمون العام", 30.0 + 1005 / 111_195, 31.0)] });
  assert.equal(justPast.kind, "far_listing", "past 1 km it is held");

  // A branch at the door beats the same name across town.
  const branches = judgeGooglePlace({
    customerName: "مستشفى أشمون العام",
    point: { lat: 30.2956031, lon: 30.9892325 },
    listings: [listing("مستشفى أشمون العام", 30.33, 31.02), listing("مستشفى أشمون العام", 30.2957, 30.9895)],
  });
  assert.equal(branches.kind, "match", "the nearest listing that IS the account decides");

  // No listing that is the account → held; Google not asked → held, never passed and never blocked.
  const radwa = judgeGooglePlace({
    customerName: "مستشفي النفسيه والعصبيه",
    point: { lat: 30.8028097, lon: 30.9937092 },
    listings: [listing("مركز الطب النفسي", 30.80281, 30.993851), listing("مستشفى طنطا للصحه النفسيه وعلاج الادمان", 30.800446, 30.995811)],
  });
  assert.deepEqual(radwa, { kind: "no_listing", reason: "no_confident_listing" }, "an unsure account is held for the Super Admin");
  assert.deepEqual(judgeGooglePlace({ customerName: "مستشفى أشمون العام", point: { lat: 30, lon: 31 }, listings: [] }), { kind: "no_listing", reason: "no_confident_listing" });
  assert.deepEqual(
    judgeGooglePlace({ customerName: "مستشفى أشمون العام", point: { lat: 30, lon: 31 }, listings: null }),
    { kind: "no_listing", reason: "lookup_failed" },
    "a failed lookup holds — it never passes a place unchecked and never blocks the field over an outage",
  );

  // ── What the rep reads ────────────────────────────────────────────────────────
  assert.match(googleMismatchMessage("مستشفي الصدر"), /Google Maps \(it must be within 150 m\)/, "the refusal names the rule the reps were sent on 3 Oct");
  for (const line of [LOCATION_CHECKING_TITLE, LOCATION_CHECKING_TEXT, LOCATION_CHECKING_PILL, LOCATION_NOT_CONFIRMED_TEXT]) {
    for (const person of [/admin/i, /manager/i, /\bSFE\b/, /review/i, /approv/i, /someone|somebody|a person/i]) {
      assert.doesNotMatch(line, person, `the rep reads the system, never a person (owner: "show him that it's automated from system") — "${line}"`);
    }
  }
  assert.match(LOCATION_CHECKING_TEXT, /system/i, "and it says it is the system");

  // While his place is being checked the row offers Open, never a second Validate.
  assert.equal(listRowAction({ status: "pending", origin: "reference", validatedAt: null, locationCheck: "checking" }), "open");
  assert.equal(listRowAction({ status: "pending", origin: "reference", validatedAt: null, locationCheck: "not_confirmed" }), "validate", "turned down: he validates again");
  assert.equal(listRowAction({ status: "pending", origin: "reference", validatedAt: null }), "validate");

  // ── The wiring: every save goes through the check, before anything is written ─
  const list = stripComments(readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8"));
  const validate = /export async function validateCustomer\([\s\S]*?\n\}/.exec(list)?.[0] ?? "";
  // `place`, not `place.value`, since 2026-10-09: the parse result is unwrapped one level earlier so
  // the seated branch can leave `place` null (a customer seated in a shared place sends no location
  // at all and is checked on the venue's own capture). The check itself is unmoved and still runs on
  // every captured place, before the save.
  assert.ok(
    validate.includes("const google = await googleCheckForSave(subject, place, { seatId: seat.seatId, repHrId: viewer.hrId, isTest });"),
    "validating checks the place on Google, and hands over who is asking so a repeat refusal can be counted",
  );
  assert.ok(
    validate.indexOf("googleCheckForSave(") < validate.indexOf('callPhoenixCrm<Row>("phoenix_crm_validate_customer"'),
    "and does it BEFORE the save, so a mismatch writes nothing",
  );
  assert.ok(validate.includes("else if (google) payload.hold_review = google.record;"), "an unsure account is saved as a hold");
  const helper = /async function googleCheckForSave\([\s\S]*?\n\}/.exec(list)?.[0] ?? "";
  assert.ok(helper.includes('if (check.verdict.kind === "mismatch") {'), "a mismatch is the only verdict that can refuse");
  assert.ok(helper.includes("throw validationError(googleMismatchMessage(subject.name));"), "and it is refused at the door with his own message");
  assert.equal((helper.match(/throw /g) ?? []).length, 1, "and nothing else is — a far pin, no listing and a failed lookup are all held");
  // The second mismatch on the same account is HELD, so the refusal is reachable only through the count.
  assert.ok(helper.includes("const priorRefusals = await countOffListingRefusals({ ...who, customerId: subject.customerId });"), "the count comes first");
  assert.ok(helper.includes("if (!mismatchIsHeld(priorRefusals)) {"), "and only a mismatch that is NOT held refuses");
  assert.ok(
    helper.indexOf("await recordOffListingRefusal(") < helper.indexOf("throw validationError(googleMismatchMessage("),
    "the refusal is recorded BEFORE it is thrown, and awaited — an unawaited insert can die with the invocation",
  );
  const subject = /async function validationSubject\([\s\S]*?\n\}/.exec(list)?.[0] ?? "";
  assert.doesNotMatch(subject, /label/, "the account is judged on the customer's name on the list — never the place label the rep typed");
  const addPlace = /export async function addPlace\([\s\S]*?\n\}/.exec(list)?.[0] ?? "";
  assert.ok(addPlace.includes("googleCheckForSave(subject, place, { seatId: seat.seatId, repHrId: viewer.hrId, isTest })"), "another clinic is checked the same way");
  const decide = /export async function decideListRequest\([\s\S]*?\n\}/.exec(list)?.[0] ?? "";
  assert.ok(decide.includes("await pendingLocationReview(customerId)"), "SFE cannot admit a customer whose place the Super Admin has not decided");
  // The refusal names the decision it waits on, never a check "still running" (production, 2026-10-24:
  // the SFE Manager was told to wait for a Google lookup long finished, on a hold that was his own).
  assert.ok(
    decide.includes("throw validationError(placeCheckHoldMessage(canDecideValidationReviews(viewer)));"),
    "the hold's refusal is worded for whether the approver can decide the place himself",
  );
  const holdMessage = /export function placeCheckHoldMessage\([\s\S]*?\n\}/.exec(list)?.[0] ?? "";
  assert.ok(holdMessage.includes("Approve or reject the place there first"), "a decider is sent to Place Checks");
  assert.doesNotMatch(list, /still being checked against Google Maps/, "nothing tells an approver the finished check is still running");
  // A decided request is answered before any step is read from it (production, 2026-10-24: its stage is
  // cleared when final, so a second Approve read as a grade change and the SFE Manager was told only the
  // reviewing manager decides it).
  const settledAt = decide.indexOf('if (settled !== "pending") {');
  assert.ok(settledAt > 0, "a request that is no longer waiting is caught");
  assert.ok(settledAt < decide.indexOf("const rowStage ="), "before the step is read from the row");
  assert.ok(settledAt < decide.indexOf("assertListRequestApprover(viewer, seat, isTest, rowStage)"), "and before the step's gate");
  assert.ok(decide.includes('throw conflictError("This request was already decided. Reload the page.");'), "and says it was decided");
  assert.ok(decide.includes("decidedBy !== null && decidedBy === personKey(viewer.hrId)"), "his own repeat is his answer again, and an empty id matches nobody");

  // ── The card knows the hold before the press (System Audit, 2026-10-31) ───────
  //
  // The SFE Manager pressed Approve on seventeen held adds between 25 and 29 Oct and was refused each
  // time: the card offered a button the server refuses. The request now carries the hold sentence,
  // set from the SAME rule the refusal reads, and the card shows it in place of Approve.
  assert.ok(decide.includes("awaitsPlaceCheck({ kind, stage: rowStage, customerId })"), "the refusal and the card read one rule");
  const awaits = /export function awaitsPlaceCheck\([\s\S]*?\n\}/.exec(list)?.[0] ?? "";
  assert.ok(awaits.includes('request.stage === "sfe"'), "only SFE's step admits the customer");
  assert.ok(awaits.includes('(request.kind === "add" || request.kind === "restore")'), "and only an add or a bring-back admits him");
  const holds = /export async function withPlaceCheckHolds<[\s\S]*?\n\}/.exec(list)?.[0] ?? "";
  assert.ok(
    holds.includes('request.status === "pending" && !request.withRep && (request.canDecide || override) && awaitsPlaceCheck(request)'),
    "only a waiting request the viewer decides is asked — the rep never reads a hold (Golden Rule #1)",
  );
  assert.ok(holds.includes("placeCheckHoldMessage(canDecideValidationReviews(viewer))"), "and it reads the refusal's own words, worded for whether he decides the place");
  assert.ok(/catch \(error\) \{\s*logError\([\s\S]*?return requests;/.test(holds), "a failed read leaves the cards as they were; the server still refuses");
  assert.ok(list.includes("placeCheckHold: null,"), "every request starts without a hold");
  assert.ok(list.includes("const heldRequests = await withPlaceCheckHolds("), "the List tab asks it");
  const team = stripComments(readFileSync("src/lib/phoenix-crm/server/team.ts", "utf8"));
  assert.ok(team.includes("const heldRequests = await withPlaceCheckHolds("), "and so does the Team tab");
  const reviewsRead = stripComments(readFileSync("src/lib/phoenix-crm/server/validation-reviews.ts", "utf8"));
  const batch = /export async function pendingLocationReviewCustomers\([\s\S]*?\n\}/.exec(reviewsRead)?.[0] ?? "";
  assert.ok(batch.includes('.eq("status", "pending")'), "the batch reads the same waiting reviews as the single check");
  const card = stripComments(readFileSync("src/components/phoenix-crm/request-card.tsx", "utf8"));
  assert.ok(card.includes("const heldOnPlaceChecks = request.placeCheckHold;"), "the card reads the server's hold");
  assert.match(card, /\{heldOnPlaceChecks \? null : \(\s*<CrmButton[\s\S]{0,200}?decide\("approve"\)/, "and draws no Approve while it holds");
  assert.ok(card.includes('<CrmNote tone="warn">{heldOnPlaceChecks}</CrmNote>'), "it says why instead");
  assert.match(card, /<CrmButton[\s\S]{0,200}?decide\("refuse"\)/, "and Refuse stays");

  // ── Only the Super Admin and the SFE Manager decide ───────────────────────────
  //
  // `canDecideValidationReviews` was DECLARED in `server/validation-reviews.ts` until 2026-10-13,
  // when the district manager's own Place checks board needed the same viewer predicates without
  // importing the decision module — so it moved to `server/access.ts`, which that board's page and
  // `server/shared-places.ts` can both import without closing an import cycle, and is re-exported
  // from its old home so every existing caller is unchanged. So the predicate is read where it now
  // LIVES, and the old home is checked to still be importing it rather than holding a second copy:
  // a local declaration there would shadow the re-export silently, and it is the one sentence that
  // separates reading this board from deciding on it.
  const access = stripComments(readFileSync("src/lib/phoenix-crm/server/access.ts", "utf8"));
  // Who the decider admits is a BEHAVIOUR, pinned by evaluating the function in
  // `tests/phoenix-crm-sfe-place-checks.test.ts` (the Super Admin and the SFE Manager since 2026-10-19,
  // never a test account, never a district manager) — here only that it is declared once, in this file.
  assert.match(access, /export function canDecideValidationReviews\(viewer: PhoenixCrmViewer\): boolean \{\s*if \(viewer\.isTestPersona\) return false;/, "the decider refuses a test account first");
  const reviews = stripComments(readFileSync("src/lib/phoenix-crm/server/validation-reviews.ts", "utf8"));
  assert.match(reviews, /import \{ canDecideValidationReviews[^}]*\} from "@\/lib\/phoenix-crm\/server\/access";/, "and the decision module imports that one predicate, never a copy of its own");
  assert.doesNotMatch(reviews, /function canDecideValidationReviews\(/, "nothing re-declares it where it used to live");
  assert.match(reviews, /export async function decideValidationReview\([\s\S]*?if \(!canDecideValidationReviews\(viewer\)\) throw forbiddenError/, "the decision refuses everyone else");
  const page = stripComments(readFileSync("app/(admin)/admin/field-crm/validation-reviews/page.tsx", "utf8"));
  assert.match(page, /if \(!viewer \|\| !canDecideValidationReviews\(viewer\)\) redirect\("\/admin"\);/, "and so does the page");

  // ── §11. A refusal nobody can pass by standing anywhere is not a dead end ────
  //
  // The owner's reason for holding past 1 km was "a refusal there could never be passed by standing
  // anywhere, so it would lock the hospital out" (2026-10-03). Inside the band the same thing happens
  // at 300 m when an account moves and Google keeps its old pin. Measured 2026-10-05: a rep was
  // refused twice on مستوصف صدر باجور, tried "Add new customer" as a way round — refused by the same
  // gate, nothing written at all — and logged the call out-of-list, where it scores in nothing.
  assert.equal(MISMATCH_REFUSALS_BEFORE_HOLD, 1, "one refusal, then a hold");
  assert.equal(mismatchIsHeld(0), false, "the FIRST mismatch is refused — this is what keeps the wrong-door catch");
  assert.equal(mismatchIsHeld(1), true, "the second on the same account is held for the Super Admin instead");
  assert.equal(mismatchIsHeld(9), true, "and so is every one after it");

  const check = stripComments(readFileSync("src/lib/phoenix-crm/server/google-place-check.ts", "utf8"));
  assert.match(
    check.replace(/\s+/g, " "),
    /verdict\.kind === "mismatch" \? "listing_off"/,
    "a held mismatch reaches the board as listing_off",
  );
  const queue = readFileSync("src/components/phoenix-crm/validation-review-queue.tsx", "utf8");
  assert.match(queue, /listing_off:/, "and the board has words for it");
  assert.doesNotMatch(queue, /listing_off:[\s\S]{0,400}?(lying|fraud|suspicious)/i, "which never accuse the rep of anything");

  // The recorder and the count are the whole mechanism, and neither may cost the rep his refusal.
  const refused = stripComments(readFileSync("src/lib/phoenix-crm/server/refused-readings.ts", "utf8"));
  const record = /export async function recordOffListingRefusal\([\s\S]*?\n\}/.exec(refused)?.[0] ?? "";
  assert.ok(record.includes('reason: "off_listing"'), "the refusal is filed under its own reason");
  assert.ok(record.includes("catch"), "and never throws — a rep being refused must not then hit a 500");
  const counted = /export async function countOffListingRefusals\([\s\S]*?\n\}/.exec(refused)?.[0] ?? "";
  assert.ok(counted.includes("return 0;"), "a failed count answers zero, so the rep is refused as before rather than held on a number nobody has");
  assert.ok(counted.includes('.eq("reason", "off_listing")') && counted.includes('.eq("subject_kind", "place")'), "and it counts only this kind of refusal");
  assert.ok(counted.includes("input.repHrId.toUpperCase()"), "HR ids are mixed case in this database; the recorder upper-cases what it writes");

  // The rep learns nothing new: a hold reads as the system checking, exactly as a no-listing hold does.
  assert.equal(LOCATION_CHECKING_TITLE.includes("system"), true, "the hold is the system's, never a person's");

  // The reason is a closed union, so the CHECK constraint has to know it too.
  const offListing = readFileSync("supabase/migrations/20261005093000_phoenix_crm_refused_reading_off_listing.sql", "utf8");
  assert.match(offListing, /check \(reason = any \(array\['no_fix'::text, 'rough'::text, 'off_listing'::text\]\)\)/, "the third reason is allowed by the table");

  // ── The migration holds the place without validating the customer ────────────
  const migration = readFileSync("supabase/migrations/20261003130536_phoenix_crm_google_place_check.sql", "utf8");
  assert.match(migration, /v_hold jsonb := case when jsonb_typeof\(p -> 'hold_review'\) = 'object'/, "the hold is an optional object — old callers get the old function");
  assert.match(migration, /case when v_hold is null then 'active' else 'pending' end/, "a held carried-over customer is not validated");
  assert.match(migration, /raise exception 'phoenix_crm:location_in_review'/, "a customer whose place is being checked is not validated twice");
  assert.match(migration, /revoke execute on function public\.phoenix_crm_decide_validation_review\(jsonb\) from public, anon, authenticated;/);
}
