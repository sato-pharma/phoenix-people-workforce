/**
 * Phoenix CRM — the nightly signboard pass: read the signboard of every validated place nobody has
 * read yet, keep the verdict on the place row, and FILE a case for a confident negative.
 *
 * It is the second half of the owner's 2026-10-08 ruling ("require the customer's name always"). A
 * save at the door reads the signboard itself (`signboardCheckForSave` in `server/list.ts`), but every
 * place validated before that day — 612 active real places, measured the same day — has never been
 * read, and a save whose read timed out or met a lapsed key is left `unjudged`. This pass drains both.
 *
 * THREE RULES, and each looks like something to tidy:
 *
 *   1. 🔴 IT NEVER HOLDS AND NEVER UN-VALIDATES. A place validated before the signboard rule existed
 *      stays validated whatever its photo shows (owner, 2026-10-08: the 179 bad places are flagged and
 *      he decides each; nothing is un-validated and no rep is told). It files a FLAG through
 *      `filePlaceSignboardFlag` (`source: "signboard"`), which the integrity board reads and the
 *      field app cannot reach — this file never touches that table itself. Nothing here writes `hold_review`, a review row or a customer status.
 *   2. 🔴 OLDEST FIRST. A nightly cap with newest-first leaves the old backlog permanently behind fresh
 *      work — the photo pass's own rule, for the same reason.
 *   3. 🔴 IT TELLS NOBODY. No message of any kind in either direction. The board is where a human looks.
 *
 * Pharmacies are never read (`signboardApplies`), and a place whose customer name folds to nothing
 * is recorded `unjudged` / `unreadable` once so it leaves the backlog instead of starving it. An
 * `unjudged` place is read again only when the reason can change tomorrow (a failed call, a lapsed
 * key, a place that was held elsewhere) — never a photo the bucket could not return or a sign the
 * model already could not read.
 */

import { hasAiApiKey } from "@/lib/ai/openai-client";
import { chunk, IN_ID_CHUNK, throwIfError } from "@/lib/phoenix-crm/server/db";
import { filePlaceSignboardFlag } from "@/lib/phoenix-crm/server/location-integrity";
import { readStoredPlaceSignboard, recordPlaceSignboard } from "@/lib/phoenix-crm/server/signboard-check";
import {
  approveHeldSignboardBySystem,
  loadHeldSignboardPlaceIds,
  loadHeldSignboardPlaces,
} from "@/lib/phoenix-crm/server/signboard-holds";
import {
  SIGNBOARD_HELD_MAX_READS,
  signboardApplies,
  signboardBacklogCheckToKeep,
  signboardBacklogOutcome,
  signboardNameIsUsable,
  signboardNextAttempt,
  signboardRejudge,
  signboardUnjudged,
  type PhoenixCrmSignboardCheck,
  type SignboardBacklogOutcome,
} from "@/lib/phoenix-crm/signboard-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * How many places one night reads. One model call each; 612 waited on the first night.
 *
 * 🔴 RAISED 60 -> 200 ON 2026-10-09, AT THE OWNER'S INSTRUCTION, AND THE NUMBER COMES FROM THE FIRST
 * NIGHT'S OWN CLOCK RATHER THAN FROM AMBITION. That night read its 60 between **03:35:04 and
 * 03:35:45 Cairo — 42 seconds** for the whole pass, measured from the `checkedAt` stamps it wrote,
 * so four reads in flight settle about **1.4 places a second** and the pass stopped on THIS limit
 * with 547 places still waiting, nowhere near its 120-second budget. At 60 a night that backlog
 * needed nine more nights; at 200 it needs three.
 *
 * 🔴 THE BUDGET, NOT THIS NUMBER, IS WHAT PROTECTS THE CRON — and that is why it is untouched. 200
 * at the measured rate is ~140 s, which is over `SIGNBOARD_SWEEP_BUDGET_MS`, so a normal night now
 * stops on the BUDGET with `moreWaiting` true instead of on the limit. That is the designed graceful
 * stop (oldest first, the rest tomorrow), and it is also the worst case: a night where every read
 * burns its full 8-second timeout fits only ~60 reads in the same window, exactly today's volume.
 * So raising this cannot lengthen the pass — it can only let a fast night use the window it already
 * had. Raise the BUDGET and you are spending the behaviour pass's room; raise this and you are not.
 */
export const SIGNBOARD_SWEEP_LIMIT = 200;

/** Reads in flight at once. Each is bounded by `PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS`. */
export const SIGNBOARD_SWEEP_CONCURRENCY = 4;

/**
 * Stop STARTING reads after this long, so the pass leaves the cron's 300 s room for the behaviour
 * pass that must follow it. A place not reached tonight is simply first tomorrow.
 *
 * 🔴 LOWERED 120 s -> 100 s ON 2026-10-09 BECAUSE ONE PLACE CAN NOW COST TWO FULL READS. A place is
 * finished once it is started, so the pass's worst case is this budget plus the longest a single
 * place can take — and that is now `2 × PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS` (25 s each), because
 * a lost call is retried and a flaggable verdict is confirmed. Those two never both happen (a lost
 * call is `unjudged`, and only `other_name`/`no_name` is confirmed), so the ceiling is two, not
 * three: 100 + 50 = 150 s, exactly half the cron's 300 s, which is the line the photo and behaviour
 * passes share. The measured night used **42 s** of this window, so nothing real is given up.
 */
export const SIGNBOARD_SWEEP_BUDGET_MS = 100_000;

/**
 * `unjudged` reasons worth another read. Everything else is the same tomorrow as it was tonight.
 *
 * 🔴 `unreadable` AND `unconfirmed` JOINED THIS LIST ON 2026-10-09, AND THAT IS THE WHOLE POINT OF
 * THE CHANGE. The first night read 60 places and produced **4** answers: 42 ended `unreadable`, which
 * was terminal, and 14 lost their model call. So 70% of a night's work was being filed as a permanent
 * "nobody can read this" on the strength of ONE reading of the frame — when the same frame, re-read
 * that evening, answered differently twice (`other_name` at 18:12 and `unreadable` at 18:34; a blank
 * `unjudged` at 18:35 and a clear `د/ اسلام حشيش` at 18:48). Legibility is not a property of the
 * photograph.
 *
 * It is bounded, not endless: `signboardNextAttempt` turns the third `unreadable` into
 * `unreadable_final`, which is deliberately NOT in this list. The structural cases that used to share
 * `unreadable` — a pharmacy, a name that folds away — are `name_unusable` now and never come back.
 */
export const SIGNBOARD_REREAD_REASONS = [
  "no_api_key",
  "call_failed",
  "held_elsewhere",
  "unreadable",
  "unconfirmed",
] as const;

export type SignboardSweepResult = {
  /** Places read this run (a model call made, or an unusable name recorded). */
  read: number;
  /** Of those, how many filed a case. */
  flagged: number;
  /** Of those, how many came back with no answer. */
  unjudged: number;
  /** Of those, how many reached a flaggable verdict that the second reading did not agree with. */
  unconfirmed: number;
  /** True when the run stopped on its limit or its budget — more is waiting. */
  moreWaiting: boolean;
  /** Set when nothing was read because no key is configured here. */
  skipped: "no_api_key" | null;
};

type SweepPlace = {
  placeId: string;
  customerId: string;
  seatId: string;
  repHrId: string;
  photoPath: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  capturedAt: Date;
  customerName: string;
  listType: PhoenixCrmListType;
  /** The brick the place's GPS resolved to — an AM name's town word (`signNamesCustomer`). */
  photoBrick: string | null;
  /** Verdicts recorded for this place so far. A row written before the field existed has had one. */
  priorAttempts: number;
};

function toPlace(row: Row): SweepPlace | null {
  const customer = (Array.isArray(row.customer) ? row.customer[0] : row.customer) as Row | null | undefined;
  const capturedAt = new Date(String(row.captured_at));
  const photoPath = String(row.photo_path ?? "");
  if (!customer || !photoPath || Number.isNaN(capturedAt.getTime())) return null;
  const stored = (row.signboard_check ?? null) as Row | null;
  const storedAttempts = Number(stored?.attempts ?? 0);
  return {
    // No stored check at all is a first read (0). A check with no `attempts` predates the field and
    // has had exactly one, so it must count as one or it would get an extra attempt for ever.
    priorAttempts: Number.isFinite(storedAttempts) && storedAttempts > 0 ? storedAttempts : stored ? 1 : 0,
    placeId: String(row.id),
    customerId: String(row.customer_id),
    seatId: String(row.seat_id ?? ""),
    repHrId: String(row.created_by_hr_id ?? ""),
    photoPath,
    lat: Number(row.lat),
    lon: Number(row.lon),
    accuracyMeters: row.accuracy_meters == null ? null : Number(row.accuracy_meters),
    capturedAt,
    customerName: String(customer.name ?? ""),
    listType: String(customer.list_type ?? "") as PhoenixCrmListType,
    photoBrick: typeof row.brick_name === "string" && row.brick_name.trim() ? row.brick_name : null,
  };
}

/**
 * The backlog, oldest first, pharmacies and test entries excluded at the database.
 *
 * 🔴 A SEATED PLACE IS NOT IN IT, AND WAS UNTIL 2026-10-12. A place with `shared_place_id` set is a
 * customer seated in a shared venue, and under the owner's 2026-10-10 amendment ("ask him for only
 * one timetable, not for every doctor") its `photo_path` IS THE BUILDING'S TIMETABLE — the board of
 * clinic hours and doctors' names at the entrance — captured once for the venue and reused for every
 * doctor seated in it. Its check is `schedule_check`, not `signboard_check`, and
 * `server/validation-reviews.ts` already tells the two apart that way
 * (`photoKind: shared_place_id ? "schedule" : "signboard"`).
 *
 * So the sweep was reading a timetable and asking "does the sign name this customer?" — a question
 * the photo was never taken to answer. The verdicts it produced were wrong by construction, and a
 * confident negative FILES A CASE about a named rep (`filePlaceSignboardFlag`), so the cost was not
 * only a wasted model call. It is excluded at the database rather than in `toPlace`, so a seated row
 * is never counted in the night's limit either.
 */
async function loadBacklog(limit: number): Promise<SweepPlace[]> {
  const reread = SIGNBOARD_REREAD_REASONS.join(",");
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select(
      "id, customer_id, seat_id, created_by_hr_id, photo_path, lat, lon, accuracy_meters, captured_at, brick_name, signboard_check, customer:phoenix_crm_customers!inner(name, list_type)",
    )
    .eq("status", "active")
    .eq("is_test", false)
    .is("shared_place_id", null)
    // A trusted point carries no photo (point_source "trusted") — nothing to read, and it must never fill the night.
    .not("photo_path", "is", null)
    .neq("customer.list_type", "Pharmacy")
    .or(`signboard_check.is.null,and(signboard_check->>verdict.eq.unjudged,signboard_check->>reason.in.(${reread}))`)
    .order("captured_at", { ascending: true })
    .order("id", { ascending: true })
    // One page, under PostgREST's 1,000-row ceiling by construction.
    .limit(limit);
  throwIfError(error);
  return ((data ?? []) as Row[]).map(toPlace).filter((entry): entry is SweepPlace => entry !== null);
}

/**
 * Read one place's signboard once, and retry a LOST CALL immediately.
 *
 * 🔴 THE RETRY IS WORTH A WHOLE NIGHT'S WORK. On 2026-10-09, 14 of 60 places — 23% of the pass —
 * ended `call_failed`: a timeout, a connection reset, a rate limit. `call_failed` was already
 * re-read, but only on the NEXT night, so a quarter of every night was spent producing rows that
 * said nothing and waiting 24 hours to try again. The budget was never the constraint: those 60
 * places took 42 seconds of a 120-second window.
 *
 * Only a lost call is retried, and only once. An answer that came back and could not be read is a
 * different thing, bounded by `attempts` across nights rather than hammered inside one.
 *
 * The two structural cases are `name_unusable`, not `unreadable`: a pharmacy is never read, and a
 * customer name that folds away to nothing has nothing to compare a sign to. Neither can change
 * tomorrow, and calling them `unreadable` would now put them back in the backlog every night.
 */
async function readOne(place: SweepPlace): Promise<PhoenixCrmSignboardCheck> {
  if (!signboardApplies(place.listType)) return signboardUnjudged("name_unusable");
  if (!signboardNameIsUsable(place.customerName)) return signboardUnjudged("name_unusable");
  const input = { customerName: place.customerName, listType: place.listType, photoBrick: place.photoBrick, photoPath: place.photoPath };
  const first = await readStoredPlaceSignboard(input);
  if (first.verdict !== "unjudged" || first.reason !== "call_failed") return first;
  return readStoredPlaceSignboard(input);
}

/**
 * A verdict that would put a name on the owner's board is read a SECOND time, and filed only if the
 * second reading agrees.
 *
 * 🔴 ONE READING IS NOT A VERDICT ABOUT A PLACE, and 2026-10-09 proved it three ways in one evening.
 * A false match: مستشفى المنشاوى العام scored a MATCH against a board reading مستشفى طنطا العام,
 * because the two words it kept were the ones every general hospital in Egypt shares. And two flips
 * on re-reading the same frame: that hospital answered `other_name` at 18:12 and `unjudged` at 18:34,
 * and اسلام عبدالعال answered `unjudged` at 18:35 and `other_name` at 18:48. The flag is the only
 * output of this pass that a human ever sees, and it carries a person's name — so it is the one
 * verdict worth a second call.
 *
 * On disagreement the place is recorded `unjudged` / `unconfirmed`, KEEPING the first reading's text
 * and signs as the evidence, and it is re-read on a later night. Nothing is flagged, and nothing is
 * thrown away. A match and an `unjudged` cost no extra call at all: nobody is named by either.
 *
 * It deliberately ignores the pass's deadline, like every other read of a place already started —
 * the budget stops the pass STARTING a place, and a place that is started is finished.
 */
async function confirmBeforeFlagging(
  place: SweepPlace,
  first: PhoenixCrmSignboardCheck,
): Promise<PhoenixCrmSignboardCheck> {
  if (first.verdict !== "other_name" && first.verdict !== "no_name") return first;
  const second = await readOne(place);
  if (second.verdict === first.verdict) return second;
  return { ...first, reason: "unconfirmed", verdict: "unjudged" };
}

/**
 * One night's signboard pass. Allowed to throw on the backlog read — a night that failed must reach
 * the dead-man's switch as a night that failed — but never on one place: `readStoredPlaceSignboard`,
 * `recordPlaceSignboard` and `filePlaceSignboardFlag` each swallow their own failure.
 */
export async function runPhoenixCrmSignboardSweep(
  options: { limit?: number; budgetMs?: number } = {},
): Promise<SignboardSweepResult> {
  const result: SignboardSweepResult = { read: 0, flagged: 0, unjudged: 0, unconfirmed: 0, moreWaiting: false, skipped: null };
  // No key here (a preview, a local run): nothing is read and nothing is written, so the backlog stays
  // exactly as it is for the environment that can read it.
  if (!hasAiApiKey()) return { ...result, skipped: "no_api_key" };

  const limit = Math.max(1, Math.min(options.limit ?? SIGNBOARD_SWEEP_LIMIT, 500));
  const deadline = Date.now() + (options.budgetMs ?? SIGNBOARD_SWEEP_BUDGET_MS);
  // 🔴 A place the DOOR HELD on its signboard (2026-10-17) is not this pass's: `server/signboard-holds.ts`
  // re-reads it with its own count and settles the hold. Read here too, its `attempts` would be spent by
  // a reader that can only flag — and `unreadable_final` written by this pass would end the hold's reads.
  const [read, held] = await Promise.all([loadBacklog(limit), loadHeldSignboardPlaceIds()]);
  result.moreWaiting = read.length >= limit;
  const backlog = read.filter((place) => !held.has(place.placeId));

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < backlog.length) {
      if (Date.now() >= deadline) {
        result.moreWaiting = true;
        return;
      }
      const place = backlog[next];
      next += 1;
      const first = await readOne(place);
      const check = signboardNextAttempt(await confirmBeforeFlagging(place, first), place.priorAttempts);
      await recordPlaceSignboard(place.placeId, check);
      result.read += 1;
      if (check.verdict === "unjudged") result.unjudged += 1;
      if (check.reason === "unconfirmed") result.unconfirmed += 1;
      if (check.verdict === "other_name" || check.verdict === "no_name") {
        await filePlaceSignboardFlag({
          placeId: place.placeId,
          seatId: place.seatId,
          repHrId: place.repHrId,
          customerId: place.customerId,
          isTest: false,
          flag: check.verdict === "other_name" ? "sign_other_name" : "sign_no_name",
          signals: { signText: check.signText, personNames: check.personNames, placeNames: check.placeNames, note: check.note },
          fixed: { lat: place.lat, lon: place.lon, accuracyMeters: place.accuracyMeters, capturedAt: place.capturedAt },
        });
        result.flagged += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SIGNBOARD_SWEEP_CONCURRENCY, backlog.length) }, () => worker()));
  return result;
}

// ── The places filed "Not readable" before 2026-10-18: one read each, once ──────────────────────
//
// 🔴 ONE READ PER PHOTO, ONCE, EVER (owner, 2026-10-18: "fix all the unreadable" — and "a total wasting
// of money" to keep measuring the same photos). Audited the same evening: 532 active places filed
// "Not readable", 93 whose read was lost when the OpenAI account ran dry, and 151 never read. 451 of the
// 532 had been read exactly once, at the door, by the cheapest model, which filed clear plates
// unreadable and misread others — so the stored answer did not even say whether the photo was bad.
//
// Each photo is read once by the strong reader, one look, and the place ends in one of three states:
// confirmed (a held one approved by the system), filed with another name for the Super Admin (only when
// a second reading agrees, as the night files), or SENT BACK to its rep for a new photo with the reason.
// The last is written `unreadable_final` so no backlog, night or held re-read ever reads it again —
// whichever build is serving when it is written.

/** Reasons the one-off read takes: the unreadable, the lost and the never-read. */
export const SIGNBOARD_BACKLOG_REASONS = ["unreadable", "unreadable_final", "call_failed", "no_api_key", "no_bytes"] as const;

export type SignboardBacklogRow = {
  placeId: string;
  repHrId: string;
  customerName: string;
  listType: PhoenixCrmListType;
  held: boolean;
  outcome: SignboardBacklogOutcome;
  problem: string | null;
  verdict: string;
  /** Whether the write landed; null on a dry run. */
  written: boolean | null;
  /** On a held place the system approved: whether the approve landed. */
  approved: boolean | null;
};

/**
 * The places the one-off read takes, oldest first — with every place this read already wrote left out
 * (a `retake` request, or a strong read on record), so a second run reads nothing twice.
 *
 * `placeIds` names places to read again ON PURPOSE, already-read or not — the one way a photo this pass
 * read is read twice, and only when a person names it (2026-10-18: the sideways photos read before the
 * reader learnt to turn them upright). A confirmed or flagged place is never taken, named or not.
 */
export async function loadUnreadableBacklog(placeIds?: readonly string[]): Promise<SweepPlace[]> {
  const named = placeIds && placeIds.length > 0 ? [...new Set(placeIds.map((id) => id.toLowerCase()))] : null;
  const reasons = SIGNBOARD_BACKLOG_REASONS.join(",");
  const rows: Row[] = [];
  // Named places in slices, so a long list never overflows the request URL of one `.in()`.
  for (const part of named ? chunk(named, IN_ID_CHUNK) : [null]) {
    for (let from = 0; ; from += 1000) {
      let query = getSupabaseAdmin()
        .from("phoenix_crm_places")
        .select(
          "id, customer_id, seat_id, created_by_hr_id, photo_path, lat, lon, accuracy_meters, captured_at, brick_name, signboard_check, customer:phoenix_crm_customers!inner(name, list_type)",
        )
        .eq("status", "active")
        .eq("is_test", false)
        .is("shared_place_id", null)
        // A trusted point carries no photo (point_source "trusted") — nothing to read, and it must never fill the night.
        .not("photo_path", "is", null)
        .neq("customer.list_type", "Pharmacy");
      query = part
        ? query.in("id", part)
        : query.or(`signboard_check.is.null,and(signboard_check->>verdict.eq.unjudged,signboard_check->>reason.in.(${reasons}))`);
      const { data, error } = await query
        .order("captured_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + 999);
      throwIfError(error);
      const page = (data ?? []) as Row[];
      rows.push(...page);
      if (page.length < 1000) break;
    }
  }
  // Oldest first across the slices too.
  if (named) rows.sort((a, b) => String(a.captured_at ?? "").localeCompare(String(b.captured_at ?? "")) || String(a.id).localeCompare(String(b.id)));
  return rows
    .filter((row) => {
      const stored = (row.signboard_check ?? null) as Row | null;
      if (named) return stored?.verdict !== "match" && stored?.verdict !== "other_name";
      return !stored || (!stored.retake && stored.strongRead !== true);
    })
    .map(toPlace)
    .filter((entry): entry is SweepPlace => entry !== null);
}

/** One look, by the strong reader; a lost call is asked once more, as the night asks it. */
async function readOnceForBacklog(place: SweepPlace): Promise<PhoenixCrmSignboardCheck> {
  if (!signboardApplies(place.listType) || !signboardNameIsUsable(place.customerName)) return signboardUnjudged("name_unusable");
  const input = { customerName: place.customerName, listType: place.listType, photoBrick: place.photoBrick, photoPath: place.photoPath };
  const first = await readStoredPlaceSignboard(input, { secondLook: false });
  if (first.verdict !== "unjudged" || first.reason !== "call_failed") return first;
  return readStoredPlaceSignboard(input, { secondLook: false });
}

/**
 * Read every old "Not readable" place once and write what the photo shows. Prints nothing and writes
 * nothing unless `apply` is true; a dry run still READS, so `limit` is how a dry run is kept small.
 */
export async function rereadUnreadablePlacesOnce(
  options: {
    apply: boolean;
    limit?: number;
    concurrency?: number;
    /** Read exactly these places, already-read or not (`loadUnreadableBacklog`). */
    placeIds?: readonly string[];
    onRow?: (row: SignboardBacklogRow) => void;
  },
): Promise<{ rows: SignboardBacklogRow[]; skipped: "no_api_key" | null }> {
  if (!hasAiApiKey()) return { rows: [], skipped: "no_api_key" };
  const [backlog, held] = await Promise.all([
    loadUnreadableBacklog(options.placeIds),
    loadHeldSignboardPlaces({ includeSpent: true }),
  ]);
  const heldByPlace = new Map(held.map((place) => [place.placeId, place]));
  const queue = backlog.slice(0, Math.max(0, options.limit ?? backlog.length));
  const rows: SignboardBacklogRow[] = [];

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const place = queue[next];
      next += 1;
      const heldPlace = heldByPlace.get(place.placeId) ?? null;
      let read = await readOnceForBacklog(place);
      // A name on the owner's board is never filed on one reading — the night's own rule.
      if (read.verdict === "other_name") {
        const second = await readOnceForBacklog(place);
        read = second.verdict === read.verdict ? second : { ...read, reason: "unconfirmed", verdict: "unjudged" };
      }
      const outcome = signboardBacklogOutcome(read, place.listType);
      const row: SignboardBacklogRow = {
        approved: null,
        customerName: place.customerName,
        held: heldPlace !== null,
        listType: place.listType,
        outcome,
        placeId: place.placeId,
        problem: read.problem ?? null,
        repHrId: place.repHrId,
        verdict: read.reason ? `${read.verdict}/${read.reason}` : read.verdict,
        written: null,
      };
      if (options.apply && outcome !== "lost") {
        const kept = signboardBacklogCheckToKeep(read, place.priorAttempts, outcome);
        // A held place's count is set past the held re-read's last read, so the hourly run never reads
        // this photo again; the hold itself stays the Super Admin's unless the name was read.
        const toWrite = heldPlace ? { ...kept, attempts: Math.max(kept.attempts, SIGNBOARD_HELD_MAX_READS) } : kept;
        row.written = await recordPlaceSignboard(place.placeId, toWrite);
        if (outcome === "confirm" && heldPlace) row.approved = await approveHeldSignboardBySystem(heldPlace.reviewId);
        if (outcome === "flag" && !heldPlace) {
          await filePlaceSignboardFlag({
            placeId: place.placeId,
            seatId: place.seatId,
            repHrId: place.repHrId,
            customerId: place.customerId,
            isTest: false,
            flag: "sign_other_name",
            signals: { signText: read.signText, personNames: read.personNames, placeNames: read.placeNames, note: read.note },
            fixed: { lat: place.lat, lon: place.lon, accuracyMeters: place.accuracyMeters, capturedAt: place.capturedAt },
          });
        }
      }
      rows.push(row);
      options.onRow?.(row);
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? SIGNBOARD_SWEEP_CONCURRENCY, 8));
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return { rows, skipped: null };
}

// ── The owner's rulings, applied to the readings already stored: no model call ──────────────────
//
// 🔴 A RULING IS APPLIED TO WHAT IS STORED, NEVER BY READING THE PHOTO AGAIN (owner, 2026-10-18 — the
// rulings on ؤ/ئ, the dotted letters and the paper photo). Every place keeps the reader's signs in
// `signboard_check.signs`, so judging them again under today's rules costs nothing. Only the two changes
// `signboardRejudge` names are ever written. 🔴 A CASE ON HIS INTEGRITY BOARD IS LISTED, NEVER SETTLED
// HERE: a sign the reader filed as another doctor's that now names the customer is his to close.

export type SignboardRejudgeRow = {
  placeId: string;
  repHrId: string;
  customerName: string;
  listType: PhoenixCrmListType;
  held: boolean;
  outcome: "confirm" | "retake";
  /** The stored verdict before, as `verdict/reason`. */
  before: string;
  signText: string | null;
  /** Whether the write landed; null on a dry run. */
  written: boolean | null;
  /** On a held place the system approved: whether the approve landed. */
  approved: boolean | null;
};

/** An open signboard case on the board whose place the re-judge confirmed — his click to settle. */
export type SignboardRejudgeOpenCase = { caseId: string; placeId: string; flags: string[] };

async function loadStoredSignboards(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_places")
      .select("id, created_by_hr_id, brick_name, signboard_check, customer:phoenix_crm_customers!inner(name, list_type)")
      .eq("status", "active")
      .eq("is_test", false)
      .is("shared_place_id", null)
      // A trusted point carries no photo (point_source "trusted") — nothing to read, and it must never fill the night.
      .not("photo_path", "is", null)
      .neq("customer.list_type", "Pharmacy")
      .not("signboard_check", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 499);
    throwIfError(error);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

/**
 * Judge every stored signboard reading again under today's rules and write the changes. Writes nothing
 * unless `apply` is true. A held place the re-judge confirms is approved by the system, through the same
 * approve the door's hold uses; a held place sent back keeps its hold, its reads spent.
 */
export async function rejudgeStoredSignboardsOnce(options: {
  apply: boolean;
  now?: Date;
  onRow?: (row: SignboardRejudgeRow) => void;
}): Promise<{ scanned: number; rows: SignboardRejudgeRow[]; openCases: SignboardRejudgeOpenCase[] }> {
  const now = options.now ?? new Date();
  const [stored, held] = await Promise.all([loadStoredSignboards(), loadHeldSignboardPlaces({ includeSpent: true })]);
  const heldByPlace = new Map(held.map((place) => [place.placeId, place]));
  const rows: SignboardRejudgeRow[] = [];

  for (const raw of stored) {
    const customer = (Array.isArray(raw.customer) ? raw.customer[0] : raw.customer) as Row | null | undefined;
    if (!customer) continue;
    const check = raw.signboard_check as PhoenixCrmSignboardCheck;
    const listType = String(customer.list_type ?? "") as PhoenixCrmListType;
    const customerName = String(customer.name ?? "");
    if (!signboardApplies(listType) || !signboardNameIsUsable(customerName)) continue;
    const photoBrick = typeof raw.brick_name === "string" && raw.brick_name.trim() ? raw.brick_name : null;
    const change = signboardRejudge(check, { customerName, listType, photoBrick }, now);
    if (!change) continue;

    const placeId = String(raw.id);
    const heldPlace = heldByPlace.get(placeId) ?? null;
    const row: SignboardRejudgeRow = {
      approved: null,
      before: check.reason ? `${check.verdict}/${check.reason}` : String(check.verdict),
      customerName,
      held: heldPlace !== null,
      listType,
      outcome: change.outcome,
      placeId,
      repHrId: String(raw.created_by_hr_id ?? ""),
      signText: change.check.signText ?? null,
      written: null,
    };
    if (options.apply) {
      const toWrite = heldPlace && change.outcome === "retake"
        ? { ...change.check, attempts: Math.max(change.check.attempts, SIGNBOARD_HELD_MAX_READS) }
        : change.check;
      row.written = await recordPlaceSignboard(placeId, toWrite);
      if (row.written && change.outcome === "confirm" && heldPlace) row.approved = await approveHeldSignboardBySystem(heldPlace.reviewId);
    }
    rows.push(row);
    options.onRow?.(row);
  }

  const confirmed = rows.filter((row) => row.outcome === "confirm").map((row) => row.placeId);
  const openCases: SignboardRejudgeOpenCase[] = [];
  for (let from = 0; from < confirmed.length; from += 100) {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_location_integrity")
      .select("id, subject_id, flags")
      .eq("subject_kind", "place")
      .eq("source", "signboard")
      .is("settled_at", null)
      .in("subject_id", confirmed.slice(from, from + 100));
    throwIfError(error);
    for (const entry of (data ?? []) as Row[]) {
      openCases.push({
        caseId: String(entry.id),
        flags: (Array.isArray(entry.flags) ? entry.flags : []).map((flag) => String(flag)),
        placeId: String(entry.subject_id),
      });
    }
  }
  return { openCases, rows, scanned: stored.length };
}
