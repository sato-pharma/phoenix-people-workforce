import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { approvalNeedsFullName } from "../src/lib/phoenix-crm/pm-name-rules.ts";
import {
  heldSignboardCheckToKeep,
  SIGNBOARD_HELD_MAX_READS,
  signboardHoldStillReading,
  signboardReadsRecorded,
  signboardUnjudged,
  type PhoenixCrmSignboardCheck,
} from "../src/lib/phoenix-crm/signboard-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM validation audit, 14 Nov 2026 — the eight findings behind Place checks.
 *
 *   A. A customer validated WITHOUT his rep (an approval, the system's own approval, a trusted point, a
 *      share from another line, a building approved or brought back) kept the rep's "validate again"
 *      bell: only the door and the take-back of one rejected place withdrew it.
 *   B. A review left pending on a RETIRED place still counted as waiting, so the customer read
 *      "checking" for ever and his requests were held on Place checks.
 *   C. Bringing a building back did none of the follow-ups taking back one place does, and rejecting a
 *      building never measured its customers' visits again.
 *   D. Refusing a validated place by hand replaced the review row's evidence instead of keeping it.
 *   E. A second refusal of the same place raised its notice on the first one's key and reached nobody.
 *   F. The waiting reviews shared one ceiling with every decision ever made, newest first, so the rows
 *      a full read cut were the oldest — the ones still waiting.
 *   G. The system's own approval asked nothing about a clinic customer with one or two names.
 *   H. "The latest refusal" was read by when the review row was CREATED, and a building's refusal was
 *      never compared with a refusal of the customer's own place.
 *
 * Each block fails by itself when its fix is taken back.
 */

const ROOT = new URL("../", import.meta.url);

function code(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/** One top-level function, from its signature to the brace that closes it. */
function fn(source: string, signature: string): string {
  const from = source.indexOf(signature);
  assert.ok(from >= 0, `${signature} is where this test expects it`);
  const end = source.indexOf("\n}\n", from);
  assert.ok(end > from, `${signature} has a body`);
  return source.slice(from, end + 2);
}

/** A function's body, for the few that are plain JavaScript inside and can be run as they are written. */
function bodyOf(text: string): string {
  const brace = text.indexOf("{", text.indexOf("): "));
  assert.ok(brace > 0, "the function opens after its return type");
  return text.slice(brace);
}

type Row = Record<string, unknown>;

export async function runPhoenixCrmValidationAuditReviewsTests(): Promise<void> {
  const reviews = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  const holds = code("src/lib/phoenix-crm/server/signboard-holds.ts");
  const trusted = code("src/lib/phoenix-crm/server/trusted-point.ts");
  const twins = code("src/lib/phoenix-crm/server/line-twins.ts");
  const venues = code("src/lib/phoenix-crm/server/shared-places.ts");
  const notices = code("src/lib/phoenix-crm/server/notifications.ts");

  const decidedLater = new Function("left", "right", bodyOf(fn(reviews, "function decidedLater("))) as (left: unknown, right: unknown) => boolean;

  // ── A · A customer validated without his rep loses the "validate again" bell ──────────────────────
  {
    const decide = fn(reviews, "export async function decideValidationReview(");
    const decided = decide.indexOf('callPhoenixCrm<Row>("phoenix_crm_decide_validation_review"');
    // 14 Nov 2026 (the items the audit left): an approval behind a building still being checked accepts the
    // photo too and leaves the customer waiting for the building, so it answers the bell as well.
    const answered = decide.indexOf(
      'if (decision === "approve" && (result.validated === true || waitingForBuilding)) await withdrawValidationNotConfirmed(String(result.customer_id));',
    );
    assert.ok(answered > decided && decided > 0, "🔴 an approval that validates the customer answers the bell, after the decision landed");
    assert.ok(
      decide.includes('const waitingForBuilding = decision === "approve" && result.waiting_for_building === true;'),
      "and waiting for the building is the database's own answer, on an approve only",
    );

    const confirm = fn(reviews, "export async function approveValidatedPlace(");
    assert.ok(
      confirm.includes("if (result?.validated === true) await withdrawValidationNotConfirmed(String(place.customer_id));"),
      "🔴 and so does confirming a place the door was still holding",
    );

    const system = fn(holds, "export async function approveHeldSignboardBySystem(");
    assert.ok(
      system.includes("if (customerId && approved?.validated === true) await withdrawValidationNotConfirmed(customerId);"),
      "🔴 the system's own approval answers it, for the hourly read and the one-off read alike",
    );
    assert.ok(!reviews.includes('server/signboard-holds"'), "and the import still runs one way: the holds file reads the reviews file, never back");

    const point = fn(trusted, "export async function applyTrustedPointFor(");
    const placed = point.indexOf('callPhoenixCrm<Row>("phoenix_crm_place_on_trusted_point"');
    const quiet = point.indexOf("await withdrawValidationNotConfirmed(preview.customerId);");
    assert.ok(quiet > placed && placed > 0, "🔴 a customer validated on a trusted point needs no new photo, and the bell goes once he is placed");

    const share = fn(twins, "export async function applyLineTwinShares(");
    const shared = share.indexOf("outcome.validated += 1;");
    const told = share.indexOf("await withdrawValidateAgainNoticeQuietly(share.customerId);");
    assert.ok(told > shared && shared > 0, "🔴 a validation shared from another line answers it — only for a share that landed");
    assert.ok(share.indexOf("continue;") < told, "a skipped share withdraws nothing");

    assert.ok(
      fn(venues, "export async function restoreSharedPlace(").includes("for (const person of validated) await withdrawValidateAgainNoticeQuietly(person.customerId);"),
      "🔴 a building brought back answers it for each customer it validated",
    );
    assert.ok(
      fn(venues, "export async function decideSharedPlace(").includes("for (const customerId of validatedNow) await withdrawValidateAgainNoticeQuietly(customerId);"),
      "🔴 and so does a building approved",
    );

    // The two files that the reviews file imports restate the key instead of importing it back.
    const prefixOf = (text: string): string | undefined => /return `([^`]+)`;/.exec(text)?.[1];
    const owner = prefixOf(fn(reviews, "export function validationNotConfirmedKeyPrefix("));
    assert.ok(owner && owner.startsWith("phoenix_crm:validation_not_confirmed:"), "the key's owner is found");
    assert.equal(prefixOf(fn(twins, "function validateAgainNoticeKeyPrefix(")), owner, "🔴 the restated prefix IS the owner's, character for character");
    assert.ok(!twins.includes('server/validation-reviews"') && !venues.includes('server/validation-reviews"'), "neither imports the reviews file back");
    const quietly = fn(twins, "export async function withdrawValidateAgainNoticeQuietly(");
    assert.ok(quietly.includes("} catch (error) {"), "the withdrawal swallows its own failure");
    assert.doesNotMatch(quietly, /\bthrow\b/, "and never throws into a validation that has already happened");
  }

  // ── B · A pending review counts only while its place is still in use ──────────────────────────────
  {
    const active = fn(reviews, "async function activePlaceIds(");
    assert.ok(
      active.includes('selectByIds<Row>("phoenix_crm_places", "id", "id", placeIds, (query) => query.eq("status", "active"))'),
      "one read says which of the places are active — chunked, so a long list cannot overflow the request",
    );
    assert.doesNotMatch(reviews, /phoenix_crm_places\s*[!(]/, "two plain reads, never an embedded join");

    const single = fn(reviews, "export async function pendingLocationReview(");
    assert.ok(single.includes('.select("place_id")') && single.includes('.eq("status", "pending")'), "the single check reads the places its waiting reviews are about");
    assert.ok(single.includes("return (await activePlaceIds(waiting)).size > 0;"), "🔴 and holds the customer only while one of them is still in use");
    assert.ok(!single.includes("head: true"), "a head count of every pending review is what held him for ever");

    const batch = fn(reviews, "export async function pendingLocationReviewCustomers(");
    assert.ok(batch.includes('.select("customer_id, place_id")'), "the batch reads the place beside the customer");
    assert.ok(batch.includes("const inUse = await activePlaceIds(waiting.map((row) => text(row.place_id)));"), "asks the same question");
    assert.ok(batch.includes("if (inUse.has(String(row.place_id))) held.add(String(row.customer_id));"), "🔴 and a review on a retired place holds no request card");

    const list = fn(reviews, "export async function loadLocationChecks(");
    assert.ok(list.includes('.select("id, customer_id, place_id, status, created_at, decided_at, refusal_reason")'), "the rep's list reads the place of each review");
    assert.ok(
      list.includes('if (inUse.has(String(row.place_id))) checks.set(customerId, { decidedAt: null, reason: null, state: "checking" });'),
      "🔴 and says \"checking\" only for a review somebody can still decide",
    );
  }

  // ── C · A building brought back, or rejected, is followed like one place ──────────────────────────
  {
    const restore = fn(venues, "export async function restoreSharedPlace(");
    const restored = restore.indexOf('callPhoenixCrm<Row>("phoenix_crm_restore_shared_place"');
    const after = restore.indexOf('await afterResponse("phoenix-crm: follow a restored venue\'s customers"');
    assert.ok(after > restored && restored > 0, "the follow-ups run after the restore landed, and after the reply");
    const followed = restore.slice(after);
    assert.ok(
      followed.includes('await restampSeatedCustomersQuietly(viewer, String(result.shared_place_id), "active");'),
      "🔴 every visit to a customer whose place came back is measured again",
    );
    assert.ok(followed.includes("for (const person of validated) await shareAcrossLinesQuietly(person.customerId);"), "🔴 and each customer validated now is shared across the lines");

    const decide = fn(venues, "export async function decideSharedPlace(");
    assert.match(
      decide,
      /if \(decision === "reject"\) \{\s*await afterResponse\("[^"]+", \(\) =>\s*restampSeatedCustomersQuietly\(viewer, String\(result\.shared_place_id\), "retired"\),\s*\);/,
      "🔴 a rejected building's visits are measured again too — it retired every place seated in it",
    );

    const restamp = fn(venues, "async function restampSeatedCustomersQuietly(");
    assert.ok(restamp.includes('"shared_place_id", [sharedPlaceId], (query) =>') && restamp.includes('query.eq("status", seated)'), "the seated places are read here: the decision returns only whose status changed");
    assert.ok(restamp.includes("if (!customerId || measured.has(customerId)) continue;"), "each customer is measured once");
    assert.ok(restamp.includes('scope: "all"'), "every visit of his, as after one place is refused or brought back");
    assert.ok(restamp.includes("} catch (error) {"), "it swallows its own failure");
    assert.doesNotMatch(restamp, /\bthrow\b/, "and never undoes a decision already committed");
  }

  // ── D · A hand refusal keeps what the review row held ─────────────────────────────────────────────
  {
    const isRecord = new Function("value", bodyOf(fn(reviews, "function isRecord("))) as (value: unknown) => boolean;
    const keep = new Function("google", "isRecord", bodyOf(fn(reviews, "function evidenceToKeep("))) as (google: unknown, guard: typeof isRecord) => Row | null;
    const evidenceToKeep = (google: unknown): Row | null => keep(google, isRecord);

    const held = { reason: "sign_other_name", verdict: "signboard", signText: "مركز الشفاء" };
    assert.deepEqual(evidenceToKeep(held), held, "what the system held it on is kept as it was");
    assert.equal(evidenceToKeep(null), null, "a place nobody ever held has nothing to keep");
    assert.equal(evidenceToKeep({}), null, "nor has an empty record");
    assert.equal(evidenceToKeep([held]), null, "and a list is not a record");

    const refusedOnce = { reason: "refused_by_admin", refused_by_hr_id: "X-1", before: held };
    assert.deepEqual(evidenceToKeep(refusedOnce), held, "🔴 a second hand refusal carries the SYSTEM's evidence forward, not the first refusal's stub");
    const restored = { ...refusedOnce, restored: true, rejected_by_hr_id: "X-1" };
    assert.deepEqual(evidenceToKeep(restored), held, "the same after the rejection was taken back in between");
    assert.deepEqual(
      evidenceToKeep({ reason: "refused_by_admin", refused_by_hr_id: "X-1" }),
      { reason: "refused_by_admin", refused_by_hr_id: "X-1" },
      "a hand refusal with nothing behind it is itself the record",
    );
    for (const record of [refusedOnce, restored, { ...held, before: { ...held, before: held } }, { reason: "refused_by_admin", before: { ...held, before: held } }]) {
      assert.ok(!("before" in (evidenceToKeep(record) ?? {})), "🔴 one level only: what is kept never carries a `before` of its own");
    }

    const refuse = fn(reviews, "export async function refuseValidatedPlace(");
    const read = refuse.indexOf('.select("google").eq("place_id", placeId).maybeSingle()');
    const written = refuse.indexOf(".upsert(");
    assert.ok(read > 0 && read < written, "🔴 the row's record is read BEFORE the upsert replaces it");
    assert.ok(refuse.includes("const before = evidenceToKeep((earlier.data as Row | null)?.google);"), "through the one function above");
    assert.ok(
      refuse.includes('google: { reason: "refused_by_admin", refused_by_hr_id: viewer.hrId, ...(before ? { before } : {}) },'),
      "and written under `before`, beside a top level every reader still reads as the hand refusal",
    );
  }

  // ── E · A second refusal of the same place reaches the rep ────────────────────────────────────────
  {
    const tell = fn(reviews, "async function tellRepValidateAgain(");
    assert.ok(tell.includes("attempt: new Date().toISOString(),"), "🔴 each refusal carries its own instant, so the key of the first is never reused");
    assert.ok(
      notices.includes('idempotencyKey: `phoenix_crm:validation_not_confirmed:${notice.customerId}:${notice.reviewId}${notice.attempt ? `:${notice.attempt}` : ""}`,'),
      "the instant rides on the END of the key, leaving the prefix a withdrawal clears by",
    );
  }

  // ── F · The waiting reviews are read whole, apart from the decided ones ───────────────────────────
  {
    const load = fn(reviews, "export async function loadValidationReviews(");
    assert.equal(load.split("readEveryPage<Row>(").length - 1, 2, "🔴 two reads: the waiting, and the decided");
    assert.ok(load.includes('? base.eq("status", "pending")'), "the first is the waiting reviews alone");
    assert.equal(load.split('base.neq("status", "pending")').length - 1, 2, "the second never carries one, on the wide read or the recent one");
    assert.ok(!load.includes("status.eq.pending"), "and the recent window no longer lets a waiting row in through its filter");
    const ceilings = [...load.matchAll(/readEveryPage<Row>\(reviewsOf\((true|false)\), \{ maxRows: ([\d_]+),/g)].map((match) => [match[1], Number(match[2].replace(/_/g, ""))] as const);
    assert.deepEqual(ceilings.map(([waiting]) => waiting), ["true", "false"], "each read is found");
    assert.equal(ceilings[1][1], 5_000, "the decided rows keep the page's ceiling");
    assert.ok(ceilings[0][1] >= 10 * ceilings[1][1], "🔴 and the waiting rows are far outside it: no number of decisions can cut one");
    assert.ok(load.includes("const capped = waitingRead.capped || decidedRead.capped;"), "a ceiling met on either read is still said out loud");
    assert.ok(load.includes("for (const row of [...waitingRead.rows, ...decidedRead.rows]) reviewById.set(String(row.id), row);"), "a review decided between the two reads is kept once, as decided");
    assert.ok(load.includes("const reviews = [...reviewById.values()].sort(newestValidatedFirst);"), "and the page's order is made here");

    // The order is the one the single read asked the database for: `created_at desc, id desc`.
    const newestFirst = new Function("left", "right", bodyOf(fn(reviews, "function newestValidatedFirst("))) as (left: Row, right: Row) => number;
    const waiting = [
      { id: "c", created_at: "2026-10-01T09:00:00+00:00" },
      { id: "a", created_at: "2026-11-13T09:00:00.5+00:00" },
    ];
    const decided = [
      { id: "d", created_at: "2026-11-14T08:00:00+00:00" },
      { id: "b", created_at: "2026-11-13T09:00:00.5+00:00" },
      { id: "e", created_at: "2026-09-01T08:00:00+00:00" },
    ];
    assert.deepEqual([...waiting, ...decided].sort(newestFirst).map((row) => row.id), ["d", "b", "a", "c", "e"], "newest first, the id breaking a tie, wherever a row was read from");
  }

  // ── G · The system never approves a clinic customer with one or two names ─────────────────────────
  {
    const gate = fn(reviews, "export async function heldReviewNeedsFullName(");
    assert.ok(gate.includes("await refuseApprovalOfShortName(await reviewCustomerId(reviewId));"), "the system asks the SAME gate the two deciders' approve asks");
    assert.ok(gate.includes("=== VALIDATION_FULL_NAME_CODE) return true;") && gate.includes("throw error;"), "its refusal is the answer, and any other failure travels");

    const system = fn(holds, "export async function approveHeldSignboardBySystem(");
    const asked = system.indexOf("if (await heldReviewNeedsFullName(reviewId)) return false;");
    const approved = system.indexOf('callPhoenixCrm<Row>("phoenix_crm_decide_validation_review"');
    assert.ok(asked > 0 && asked < approved, "🔴 asked BEFORE the approval, on every path that approves as the system");
    assert.ok(system.indexOf("try {") < asked && system.includes("return false;\n  }"), "a gate that cannot be read approves nothing");
    assert.ok(!holds.includes('decision: "reject"'), "🔴 and the system still never rejects: a short name is left waiting");

    const settle = fn(holds, "export async function settleHeldSignboard(");
    const short = settle.indexOf('if (outcome === "approve" && approvalNeedsFullName({ listType: place.listType, customerName: place.customerName })) {');
    assert.ok(short > 0 && short < settle.indexOf("approveHeldSignboardBySystem(place.reviewId)"), "the hourly read knows before it tries");
    const handed = settle.slice(short, settle.indexOf('return "done";', short));
    assert.ok(handed.includes('heldSignboardCheckToKeep(read, SIGNBOARD_HELD_MAX_READS, "done")'), "🔴 the place is handed over with every read recorded as spent, never re-read each hour to the same answer");
    assert.ok(handed.includes("await notifyValidationReviewWaiting({"), "and the Super Admin is told now, as for a place whose reads ran out");

    // What that hand-over leaves on the place: the reading as it was, and no read left for the hourly run.
    const match: PhoenixCrmSignboardCheck = { ...signboardUnjudged("unreadable"), verdict: "match", reason: null, signText: "د. سامي فؤاد", personNames: ["د. سامي فؤاد"] };
    const kept = heldSignboardCheckToKeep(match, SIGNBOARD_HELD_MAX_READS, "done");
    assert.equal(kept.verdict, "match", "the reading is kept as it was read");
    assert.equal(signboardReadsRecorded(kept), SIGNBOARD_HELD_MAX_READS, "with every read spent");
    assert.equal(signboardHoldStillReading({ pending: true, signboardHold: true, isTest: false, stored: kept }), false, "so the board no longer says the system is reading it");
    assert.equal(approvalNeedsFullName({ listType: "PM", customerName: "سامي فؤاد" }), true, "two names on a clinic list wait for the third");
    assert.equal(approvalNeedsFullName({ listType: "PM", customerName: "سامي فؤاد منصور" }), false, "three are approved as before");
  }

  // ── H · The latest refusal is the one decided last ────────────────────────────────────────────────
  {
    assert.equal(decidedLater("2026-11-14T08:00:00+00:00", "2026-10-01T08:00:00.123456+00:00"), true, "a later instant is later");
    assert.equal(decidedLater("2026-10-01T08:00:00+00:00", "2026-11-14T08:00:00+00:00"), false, "an earlier one is not");
    assert.equal(decidedLater("2026-11-14T10:00:00+02:00", "2026-11-14T08:30:00+00:00"), false, "🔴 instants are compared, not their text: 10:00 at +02:00 is before 08:30 UTC");
    assert.equal(decidedLater("2026-11-14T08:00:00+00:00", "2026-11-14T08:00:00+00:00"), false, "the same instant keeps the one already held");
    assert.equal(decidedLater(null, "2026-11-14T08:00:00+00:00"), false, "🔴 a refusal with no instant on record never outranks one that has it");
    assert.equal(decidedLater("2026-11-14T08:00:00+00:00", null), true, "and loses to it");
    assert.equal(decidedLater(null, null), false, "two with none keep the one already held");

    const list = fn(reviews, "export async function loadLocationChecks(");
    assert.ok(
      list.includes("if (!current || decidedLater(row.decided_at, current.decided_at)) answered.set(customerId, row);"),
      "🔴 the rep's list answers with the review decided last, not the one created last",
    );
    const waitingWins = list.indexOf("if (checks.has(customerId)) continue;");
    assert.ok(waitingWins > list.indexOf("for (const [customerId, row] of answered)"), "a review still waiting on a place in use speaks first, as before");

    const reopened = fn(reviews, "export async function loadReopenedCustomers(");
    assert.ok(reopened.includes("if (!current || decidedLater(review.decided_at, current.decided_at)) latest.set(customerId, review);"), "the board reads the same instant for a customer's own refusals");
    assert.ok(
      reopened.includes("const viaVenue = await loadSharedPlaceRefusalsForCustomers(customers.map((row) => String(row.id)));"),
      "🔴 the building's refusal is asked for EVERY reopened customer",
    );
    assert.ok(!reopened.includes("!latest.has(id)"), "no longer only for the ones with no refused review of their own");
    assert.ok(
      reopened.includes("const venueIsLater = venueRefusal !== undefined && (!ownRefusal || decidedLater(venueRefusal.decidedAt, ownRefusal.decided_at));"),
      "🔴 and whichever was decided later is the one the row is built from",
    );
    assert.ok(reopened.includes("const review = venueIsLater ? undefined : ownRefusal;") && reopened.includes("const venue = venueIsLater ? venueRefusal : undefined;"), "exactly one of the two, never a mix");
  }
}
