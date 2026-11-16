/**
 * Phoenix CRM — the same customer on another line, written differently: the read and the Super Admin's
 * answer (owner, 2026-11-16: "same customer diff rep same area diff line", then "Fix rule + review list" —
 * "Nothing is validated without that confirmation").
 *
 * The rule is `line-lookalikes.ts`; this file feeds it, draws the list and carries out an answer:
 *
 *   - `loadLineLookalikeBoard` — every waiting row a Certain or Very likely look-alike on another line of its
 *     area has validated, that the three-lines rule did not pair.
 *   - `answerLineLookalike` — "Same customer" validates the waiting row from the validated line's places
 *     through `phoenix_crm_share_line_validation` (the three-lines rule's own door), with the Super Admin as
 *     the actor and the validated line's validator kept; "Not the same" is kept so the pair is never asked
 *     again. Both are written to `phoenix_crm_line_lookalike_answers`.
 *
 * 🔴 THE SUPER ADMIN'S ALONE — the read and the answer. A test account never reaches it.
 * 🔴 NOTHING IS VALIDATED BY THE LIST ITSELF — only an answer validates, one pair at a time.
 * 🔴 EVERY READ IS PAGED — a bare read answers its first 1,000 rows and says nothing.
 *
 * Account: docs/phoenix-crm-line-lookalikes.md.
 */

import { afterResponse } from "@/lib/http/after-response";
import { conflictError, forbiddenError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import {
  LOOKALIKE_CONFIDENCE_TEXT,
  LOOKALIKE_NAME_TEXT,
  LOOKALIKE_REFUSAL_TEXT,
  pairKey,
  planLineLookalikes,
  planLookalikeConfirm,
  type LineLookalikeBoard,
  type LineLookalikeRow,
  type LookalikeCustomer,
  type LookalikeInput,
} from "@/lib/phoenix-crm/line-lookalikes";
import { territoryName, type OrgIndex } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadTwinWorld, withdrawValidateAgainNoticeQuietly, type WorldScope } from "@/lib/phoenix-crm/server/line-twins";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `phoenix_crm_share_line_validation` answers when a guard no longer holds. */
const SHARE_SKIP_TEXT: Record<string, string> = {
  not_waiting: LOOKALIKE_REFUSAL_TEXT.not_waiting,
  has_place: LOOKALIKE_REFUSAL_TEXT.not_waiting,
  in_review: LOOKALIKE_REFUSAL_TEXT.in_review,
  drop_requested: LOOKALIKE_REFUSAL_TEXT.drop_requested,
  full_name_held: LOOKALIKE_REFUSAL_TEXT.full_name_held,
  source_gone: LOOKALIKE_REFUSAL_TEXT.source_not_validated,
};

/** The Super Admin alone, and never as a test account. */
export function canReviewLineLookalikes(viewer: Pick<PhoenixCrmViewer, "isSuperAdmin" | "isTestPersona" | "canApprove">): boolean {
  return !viewer.isTestPersona && viewer.isSuperAdmin && viewer.canApprove;
}

type Answer = { waitingCustomerId: string; sourceCustomerId: string; answer: "same" | "not_same" };

async function loadAnswers(): Promise<Answer[]> {
  const read = await readEveryPage<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_line_lookalike_answers").select("id, waiting_customer_id, source_customer_id, answer").order("id", { ascending: true }),
    { maxRows: 50_000, whenFull: "refuse", what: "The answers about customers on another line", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(read.error);
  return read.rows.map((row) => ({
    waitingCustomerId: String(row.waiting_customer_id),
    sourceCustomerId: String(row.source_customer_id),
    answer: row.answer === "same" ? "same" : "not_same",
  }));
}

/** The real world's AM and PM rows of the scope, with what the list compares beside the name. */
async function loadInput(org: OrgIndex, scope: WorldScope, answers: ReadonlyArray<Answer>): Promise<LookalikeInput> {
  const world = await loadTwinWorld(org, scope);
  const customers: LookalikeCustomer[] = world.customers.map((customer) => {
    const contact = world.contacts.get(customer.id);
    return { ...customer, phone: contact?.phone ?? null, referenceContactId: contact?.referenceContactId ?? null };
  });
  const notSame = new Set(answers.filter((answer) => answer.answer === "not_same").map((answer) => pairKey(answer.waitingCustomerId, answer.sourceCustomerId)));
  return { customers, places: world.places, notSame };
}

export async function loadLineLookalikeBoard(viewer: PhoenixCrmViewer): Promise<LineLookalikeBoard> {
  if (!canReviewLineLookalikes(viewer)) throw forbiddenError("Only the Super Admin confirms this list.");
  const answers = await loadAnswers();
  const input = await loadInput(viewer.org, { isTest: false, seatIds: null }, answers);
  const pairs = planLineLookalikes(input);

  const customerById = new Map(input.customers.map((customer) => [customer.id, customer]));
  const firstPlaces = await selectByIds<Row>("phoenix_crm_places", "id, brick_name, address", "id", [...new Set(pairs.map((pair) => pair.sourcePlaceIds[0]))]);
  const placeById = new Map(firstPlaces.map((row) => [String(row.id), row]));
  const names = await loadPeopleNames([
    ...pairs.flatMap((pair) => [customerById.get(pair.waitingCustomerId)?.seatId, customerById.get(pair.sourceCustomerId)?.seatId]).map((seatId) => (seatId ? viewer.org.seats.get(seatId)?.occupantHrId : null)),
    ...pairs.map((pair) => customerById.get(pair.sourceCustomerId)?.validatedByHrId),
  ]);

  const side = (customer: LookalikeCustomer) => {
    const seat = viewer.org.seats.get(customer.seatId);
    return {
      customerId: customer.id,
      name: customer.name,
      speciality: customer.speciality,
      line: seat?.lineName ?? null,
      repName: seat?.occupantHrId ? nameOf(names, seat.occupantHrId, "A rep") : "Vacant territory",
      territory: seat ? territoryName(seat) : "Territory no longer in the organogram",
    };
  };

  const rows: LineLookalikeRow[] = [];
  for (const pair of pairs) {
    const waiting = customerById.get(pair.waitingCustomerId);
    const source = customerById.get(pair.sourceCustomerId);
    if (!waiting || !source) continue;
    const seat = viewer.org.seats.get(waiting.seatId);
    const place = placeById.get(pair.sourcePlaceIds[0]);
    const reasons = [
      pair.samePhone ? "The same phone number" : null,
      pair.sameOldCrmContact ? "The same contact in the old CRM" : null,
      pair.nameKind ? LOOKALIKE_NAME_TEXT[pair.nameKind] : null,
    ].filter((reason): reason is string => reason !== null);
    const warnings = [
      pair.specialityDiffers ? `The specialities differ: ${waiting.speciality} / ${source.speciality}` : null,
      pair.twiceOnWaitingList ? "This rep's list holds this customer twice — confirm only the right row" : null,
    ].filter((warning): warning is string => warning !== null);
    rows.push({
      key: pair.key,
      waitingCustomerId: pair.waitingCustomerId,
      sourceCustomerId: pair.sourceCustomerId,
      listType: pair.listType,
      confidence: pair.confidence,
      confidenceText: LOOKALIKE_CONFIDENCE_TEXT[pair.confidence],
      reasons,
      warnings,
      region: seat?.regionName ?? null,
      areaName: seat?.areaName ?? null,
      waiting: side(waiting),
      source: {
        ...side(source),
        validatedByName: source.validatedByHrId ? nameOf(names, source.validatedByHrId, "A rep") : null,
        validatedAtText: source.validatedAt ? formatPhoenixDateTime(source.validatedAt) : null,
        placeCount: pair.sourcePlaceIds.length,
        brickName: typeof place?.brick_name === "string" ? place.brick_name : null,
        address: typeof place?.address === "string" ? place.address : null,
      },
    });
  }
  rows.sort(
    (left, right) =>
      (left.confidence === right.confidence ? 0 : left.confidence === "certain" ? -1 : 1) ||
      String(left.region ?? "").localeCompare(String(right.region ?? "")) ||
      String(left.areaName ?? "").localeCompare(String(right.areaName ?? "")) ||
      left.waiting.name.localeCompare(right.waiting.name),
  );

  return {
    rows,
    certain: rows.filter((row) => row.confidence === "certain").length,
    veryLikely: rows.filter((row) => row.confidence === "very_likely").length,
    confirmed: answers.filter((answer) => answer.answer === "same").length,
    notSame: answers.filter((answer) => answer.answer === "not_same").length,
  };
}

export type LineLookalikeAnswerResult = { answer: "same" | "not_same"; validated: boolean };

async function saveAnswer(viewer: PhoenixCrmViewer, waitingCustomerId: string, sourceCustomerId: string, answer: "same" | "not_same"): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_line_lookalike_answers")
    .upsert(
      { waiting_customer_id: waitingCustomerId, source_customer_id: sourceCustomerId, answer, decided_by_hr_id: viewer.hrId, decided_at: new Date().toISOString() },
      { onConflict: "waiting_customer_id,source_customer_id" },
    );
  throwIfError(error);
}

/**
 * The Super Admin's answer about one pair. "same" validates the waiting row now, from the validated line's
 * places, after every guard is asked again on the area as it stands; "not_same" keeps the pair off the list.
 */
export async function answerLineLookalike(viewer: PhoenixCrmViewer, raw: unknown): Promise<LineLookalikeAnswerResult> {
  if (!canReviewLineLookalikes(viewer)) throw forbiddenError("Only the Super Admin confirms this list.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  const answer = body.answer === "same" ? "same" : body.answer === "not_same" ? "not_same" : null;
  if (!answer) throw validationError("Choose Same customer or Not the same.");
  const waitingCustomerId = String(body.waitingCustomerId ?? "");
  const sourceCustomerId = String(body.sourceCustomerId ?? "");
  if (!UUID.test(waitingCustomerId) || !UUID.test(sourceCustomerId) || waitingCustomerId === sourceCustomerId) {
    throw validationError("That answer does not name two customers.");
  }

  if (answer === "not_same") {
    await saveAnswer(viewer, waitingCustomerId, sourceCustomerId, answer);
    return { answer, validated: false };
  }

  // The waiting row's area, read as it stands now: both rows must still sit in it.
  const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, seat_id, is_test").eq("id", waitingCustomerId).maybeSingle();
  throwIfError(error);
  const waitingRow = (data ?? null) as Row | null;
  if (!waitingRow || waitingRow.is_test === true) throw conflictError(LOOKALIKE_REFUSAL_TEXT.not_found);
  const areaCode = viewer.org.seats.get(String(waitingRow.seat_id))?.areaCode ?? null;
  if (!areaCode) throw conflictError(LOOKALIKE_REFUSAL_TEXT.not_comparable);
  const seatIds = [...viewer.org.seats.values()].filter((seat) => seat.areaCode === areaCode).map((seat) => seat.seatId);
  const answers = (await loadAnswers()).filter((held) => held.waitingCustomerId === waitingCustomerId && held.sourceCustomerId === sourceCustomerId);
  const plan = planLookalikeConfirm(await loadInput(viewer.org, { isTest: false, seatIds }, answers), waitingCustomerId, sourceCustomerId);
  if (!plan.ok) throw conflictError(LOOKALIKE_REFUSAL_TEXT[plan.refusal]);

  const result = await callPhoenixCrm<Row>("phoenix_crm_share_line_validation", {
    p: {
      seat_id: plan.waiting.seatId,
      customer_id: plan.waiting.id,
      is_test: false,
      actor_hr_id: viewer.hrId,
      source_place_ids: plan.sourcePlaceIds,
      validated_by_hr_id: plan.validatedByHrId,
    },
  });
  const skipped = typeof result?.skipped === "string" ? result.skipped : null;
  if (skipped) throw conflictError(SHARE_SKIP_TEXT[skipped] ?? LOOKALIKE_REFUSAL_TEXT.not_waiting);
  await saveAnswer(viewer, waitingCustomerId, sourceCustomerId, answer);

  // The records that follow any validation: his rep's "validate again" bell is answered, and his visits from
  // before he had a place are measured. The answer does not wait for them.
  const settings = viewer.config.settings;
  await afterResponse("phoenix-crm line look-alike: post-validation records", async () => {
    await withdrawValidateAgainNoticeQuietly(plan.waiting.id);
    await restampVisitLocationsQuietly({ seatId: plan.waiting.seatId, isTest: false, customerId: plan.waiting.id, actorHrId: viewer.hrId, settings, scope: "unplaced" });
  });
  return { answer, validated: true };
}
