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

import { hasOpenAiApiKey } from "@/lib/ai/openai-client";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { filePlaceSignboardFlag } from "@/lib/phoenix-crm/server/location-integrity";
import { readStoredPlaceSignboard, recordPlaceSignboard } from "@/lib/phoenix-crm/server/signboard-check";
import {
  signboardApplies,
  signboardNameIsUsable,
  signboardUnjudged,
  type PhoenixCrmSignboardCheck,
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
 */
export const SIGNBOARD_SWEEP_BUDGET_MS = 120_000;

/** `unjudged` reasons worth a second read: the photo and the sign are the same tomorrow for the rest. */
export const SIGNBOARD_REREAD_REASONS = ["no_api_key", "call_failed", "held_elsewhere"] as const;

export type SignboardSweepResult = {
  /** Places read this run (a model call made, or an unusable name recorded). */
  read: number;
  /** Of those, how many filed a case. */
  flagged: number;
  /** Of those, how many came back with no answer. */
  unjudged: number;
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
};

function toPlace(row: Row): SweepPlace | null {
  const customer = (Array.isArray(row.customer) ? row.customer[0] : row.customer) as Row | null | undefined;
  const capturedAt = new Date(String(row.captured_at));
  const photoPath = String(row.photo_path ?? "");
  if (!customer || !photoPath || Number.isNaN(capturedAt.getTime())) return null;
  return {
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
  };
}

/** The backlog, oldest first, pharmacies and test entries excluded at the database. */
async function loadBacklog(limit: number): Promise<SweepPlace[]> {
  const reread = SIGNBOARD_REREAD_REASONS.join(",");
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select(
      "id, customer_id, seat_id, created_by_hr_id, photo_path, lat, lon, accuracy_meters, captured_at, customer:phoenix_crm_customers!inner(name, list_type)",
    )
    .eq("status", "active")
    .eq("is_test", false)
    .neq("customer.list_type", "Pharmacy")
    .or(`signboard_check.is.null,and(signboard_check->>verdict.eq.unjudged,signboard_check->>reason.in.(${reread}))`)
    .order("captured_at", { ascending: true })
    .order("id", { ascending: true })
    // One page, under PostgREST's 1,000-row ceiling by construction.
    .limit(limit);
  throwIfError(error);
  return ((data ?? []) as Row[]).map(toPlace).filter((entry): entry is SweepPlace => entry !== null);
}

async function readOne(place: SweepPlace): Promise<PhoenixCrmSignboardCheck> {
  if (!signboardApplies(place.listType)) return signboardUnjudged("unreadable");
  if (!signboardNameIsUsable(place.customerName)) return signboardUnjudged("unreadable");
  return readStoredPlaceSignboard({ customerName: place.customerName, listType: place.listType, photoPath: place.photoPath });
}

/**
 * One night's signboard pass. Allowed to throw on the backlog read — a night that failed must reach
 * the dead-man's switch as a night that failed — but never on one place: `readStoredPlaceSignboard`,
 * `recordPlaceSignboard` and `filePlaceSignboardFlag` each swallow their own failure.
 */
export async function runPhoenixCrmSignboardSweep(
  options: { limit?: number; budgetMs?: number } = {},
): Promise<SignboardSweepResult> {
  const result: SignboardSweepResult = { read: 0, flagged: 0, unjudged: 0, moreWaiting: false, skipped: null };
  // No key here (a preview, a local run): nothing is read and nothing is written, so the backlog stays
  // exactly as it is for the environment that can read it.
  if (!hasOpenAiApiKey()) return { ...result, skipped: "no_api_key" };

  const limit = Math.max(1, Math.min(options.limit ?? SIGNBOARD_SWEEP_LIMIT, 500));
  const deadline = Date.now() + (options.budgetMs ?? SIGNBOARD_SWEEP_BUDGET_MS);
  const backlog = await loadBacklog(limit);
  result.moreWaiting = backlog.length >= limit;

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < backlog.length) {
      if (Date.now() >= deadline) {
        result.moreWaiting = true;
        return;
      }
      const place = backlog[next];
      next += 1;
      const check = await readOne(place);
      await recordPlaceSignboard(place.placeId, check);
      result.read += 1;
      if (check.verdict === "unjudged") result.unjudged += 1;
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
