import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { invalidateClosingStoreSplitCache } from "@/lib/dashboard/invalidation";
import { isHeadOfficeLine } from "@/lib/sales/access-scope";
import {
  assertClosingPeriodComplete,
  closingPeriodOpensOn,
  isClosingPeriodComplete,
} from "@/lib/sales/closing-period-gate";
// Lines and periods come from the import module rather than being queried here, so the Head Office
// exclusion (selectClosingLines) and the "validated batch only" rule hold by construction. No cycle:
// monthly-distributor-import.ts does not import this file.
import {
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
} from "@/lib/sales/monthly-distributor-import";
import { notifyClosingPublished } from "@/lib/sales/closing-publish-notification";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Closing — publication gate state (per line, per period).
//
// A (line, period) is visible in the employee portal ONLY when an admin has
// published it. This module is the thin CRUD over `monthly_closing_publications`.
//
// Every read fails SAFE: if the table does not exist yet (migration not applied
// to this Supabase project) or the query errors, we treat the closing as
// UNPUBLISHED — the portal simply shows nothing rather than leaking a draft.
// ─────────────────────────────────────────────────────────────────────────────

/** Stable key for a line name: trimmed, lower-cased, whitespace-collapsed. */
export function normalizeClosingLine(line: string | null | undefined): string {
  return String(line ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * THE HEAD OFFICE RULE — Head Office is never a monthly closing.
 *
 * Owner, 2026-08-31: "exclude head office from monthly closing this is never happening." He had
 * said it twice already — "The head office will not be used in the weekly sales or monthly sales"
 * (2026-08-30) — and the line has been unofferable on the admin closing surface since 2026-08-05.
 *
 * WHY A GATE ON TOP OF THE LINE LIST. Every closing surface takes its lines from
 * listMonthlyClosingLines, which drops Head Office for every viewer, the CEO included; and
 * loadMonthlyClosingParts only accepts a line that appears in that list, which is what makes Head
 * Office unreachable rather than merely hidden. publishClosing never consulted it. It normalized
 * whatever line string it was handed and upserted it, so a POST to
 * /api/sales/monthly-closing/publish naming "Head Office" created a publication row for a line no
 * screen can render.
 *
 * That is the worst available shape, because publishing is not a private act: it releases the
 * (line, period) to every sales and product manager's portal, fires notifyClosingPublished to that
 * audience, and counts toward the gate that arms the CEO's Source-of-Sales BI report. Readers
 * would be told a Head Office closing exists and find nothing behind it — on a line measured at
 * 90.2% of weekly VALUE, where a stray inclusion does not skew a total, it becomes the total.
 *
 * This mirrors assertClosingPeriodComplete deliberately: the UI already prevents it, and the
 * domain service refuses it anyway, because a rule enforced only by a dropdown is enforced only
 * until someone calls the API.
 *
 * UNPUBLISHING IS NOT GATED, for the same reason the date rule does not gate it — it is the
 * recovery path, and a row that should never have existed must always be removable.
 *
 * Pinned by tests/closing-excludes-head-office.test.ts, in the required CI validate check.
 */
export function assertNotHeadOfficeClosing(line: string | null | undefined): void {
  if (isHeadOfficeLine(line)) {
    throw new Error(
      "Head Office is never published as a monthly closing. "
        + "The monthly closing covers CNS, Anti Infective and Pedia.",
    );
  }
}

export type PublishedClosing = {
  line: string;
  normalizedLine: string;
  period: string;
  publishedAt: string;
};

/** True when (line, period) has been published for portal visibility. */
export async function isClosingPublished(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<boolean> {
  const normalizedLine = normalizeClosingLine(line);
  const trimmedPeriod = String(period ?? "").trim();
  if (!normalizedLine || !trimmedPeriod) return false;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("monthly_closing_publications")
      .select("id")
      .eq("normalized_line", normalizedLine)
      .eq("period", trimmedPeriod)
      .is("unpublished_at", null)
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

/** Published periods (YYYY-MM, newest first) for one line. Empty on any error. */
export async function listPublishedPeriodsForLine(
  line: string | null | undefined,
): Promise<string[]> {
  const normalizedLine = normalizeClosingLine(line);
  if (!normalizedLine) return [];

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("monthly_closing_publications")
      .select("period")
      .eq("normalized_line", normalizedLine)
      .is("unpublished_at", null)
      .order("period", { ascending: false });
    if (error) return [];
    return [
      ...new Set(
        (data ?? [])
          .map((row) => String((row as { period?: unknown }).period ?? "").trim())
          .filter(Boolean),
      ),
    ].sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}

/** Every published (line, period) — for the admin publish-state map. Empty on error. */
export async function listAllPublishedClosings(): Promise<PublishedClosing[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("monthly_closing_publications")
      .select("line, normalized_line, period, published_at")
      .is("unpublished_at", null)
      .order("published_at", { ascending: false });
    if (error) return [];
    return (data ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        line: String(record.line ?? ""),
        normalizedLine: String(record.normalized_line ?? ""),
        period: String(record.period ?? ""),
        publishedAt: String(record.published_at ?? ""),
      };
    });
  } catch {
    return [];
  }
}

/**
 * The newest period (`YYYY-MM`) with a published closing on ANY line — the newest month the
 * business considers finished — or null when nothing has ever been published.
 *
 * "Any line" and not "all three" deliberately. A closing publishes per (line, period), and the
 * three lines are published one at a time over minutes or hours; requiring all three would make
 * this answer flip back to the previous month mid-publish, which is the one moment a reader is
 * most likely to be looking. A month that is half published is still a month with real, closed
 * numbers in it, which is the question this function is asked.
 *
 * Callers use this to pick WHICH month to show on a landing page, never to decide whether a
 * viewer may see a closing — that gate is `isClosingPublished(line, period)` and stays per line.
 *
 * Returns null rather than throwing: every caller has a working fallback (usually "newest data
 * loaded"), and a landing page must not fail to render because a period lookup errored.
 */
export async function latestPublishedClosingPeriod(): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("monthly_closing_publications")
      .select("period")
      .is("unpublished_at", null)
      .order("period", { ascending: false })
      .limit(1);
    if (error) return null;
    const period = String((data ?? [])[0]?.period ?? "").trim();
    return period || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The COMPLEMENT: which closings have not been published.
//
// This is the only part of this file that answers a negative, and every other function here is
// written the opposite way round, so read the two rules below before changing anything in it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every (line, period) that has EVER been published — withdrawn ones included.
 *
 * 🔴 THIS IS THE ONE FUNCTION THE COMPLEMENT MAY SUBTRACT, AND `listAllPublishedClosings` IS NOT IT.
 * That one filters `.is("unpublished_at", null)`, which is correct for a publish-state map: a
 * withdrawn month is not currently published. Subtract it here and August 2026 — published,
 * announced, later withdrawn — reappears on the owner's board as a month that still needs
 * publishing. A published and announced month is NEVER corrected (AGENTS.md §4), so putting it back
 * in front of him as outstanding work is precisely the wrong thing for this module to do.
 *
 * Key shape is `${normalizedLine}|${period}` — normalized, because the same line reaches this table
 * under more than one spelling and `normalizeClosingLine` is what settles them.
 */
export async function listEverPublishedClosingKeys(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("monthly_closing_publications")
    .select("line, normalized_line, period");
  // Throws rather than returning an empty set — see listUnpublishedClosings for why this file's
  // usual fail-safe-to-empty is the WRONG direction here.
  if (error) throw new Error(`Could not read the closing publication history: ${error.message}`);
  const keys = new Set<string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const normalized = String(record.normalized_line ?? "") || normalizeClosingLine(String(record.line ?? ""));
    const period = String(record.period ?? "");
    if (normalized && period) keys.add(`${normalized}|${period}`);
  }
  return keys;
}

/**
 * The first period the board may call outstanding work. Owner's decision, 2026-09-28.
 *
 * 🔴 PUBLICATION BEGINS AT 2026-07, AND EVERYTHING BEFORE IT IS A DIFFERENT REGIME. Measured on
 * production that day: `monthly_closing_publications` holds rows for 2026-07 and 2026-08 only, all
 * three lines, none withdrawn. January to June have no publication row at all — they carry
 * validated import batches, so they arrived here as six permanently outstanding months and sat at
 * the top of the board, the oldest 240 days old, crowding out the rows that genuinely need him.
 *
 * They are not a backlog. The pre-July months are reconciled per customer × product and revalued at
 * the CURRENT price with targets backfilled — a separate exercise from the monthly closing this
 * board is asking about, and one that was never going to end in a publish.
 *
 * 🔴 A FIXED DATE, NEVER "THE EARLIEST PUBLISHED PERIOD". Deriving the floor from the data is the
 * obvious-looking improvement and it is wrong: withdrawing July would move the floor and bring all
 * six months back, so the board's contents would depend on an unrelated visibility toggle. Every
 * dated rule in this repository works the same way — the August/Delta (3) and Upper Egypt splits
 * each turn on a fixed date precisely so that later edits cannot reach backwards. The date is the
 * mechanism.
 *
 * It bounds ONLY what the Needs You board lists. It is not a closing rule: nothing here publishes,
 * unpublishes, locks, or changes a single sales or target figure, and `listMonthlyClosingPeriods`
 * still returns every period with data for every other caller.
 */
export const NEEDS_YOU_CLOSING_FLOOR_PERIOD = "2026-07";

/** One month that is finished but is not fully published. Reported per PERIOD, never per line. */
export type UnpublishedClosingPeriod = {
  period: string;
  /** The first day this period could have been published, Cairo. */
  opensOn: string | null;
  unpublishedLines: string[];
  publishedLines: string[];
};

/**
 * The complement, computed from injected facts so every calendar edge is testable without a clock
 * or a database — the same pure-core split as `scripts/needs-you.mjs` and `branch-pr-state.mjs`.
 *
 * Reported per PERIOD rather than per (line, period) for two reasons. A validated import batch is
 * per distributor file and not per line, so a per-line cross-product would claim a line had data it
 * never had; and one merged row — "August 2026: CNS and Pedia published, Anti Infective is not" —
 * is how this fits on the screen without a fourth column.
 */
export function selectUnpublishedClosings(input: {
  lines: readonly string[];
  periodsWithData: readonly string[];
  everPublished: ReadonlySet<string>;
  now: Date;
}): UnpublishedClosingPeriod[] {
  // Normalize for the LOOKUP, report the line as it was given. `normalizeClosingLine` lower-cases,
  // so matching and displaying with the same string would print "anti infective" on a screen whose
  // whole job is to be read at a glance — the owner's names-never-codes rule covers mangled casing
  // just as much as it covers raw ids.
  const lines = input.lines
    .map((line) => ({ display: String(line ?? "").trim(), key: normalizeClosingLine(line) }))
    .filter((line) => line.display && line.key);
  const out: UnpublishedClosingPeriod[] = [];

  for (const period of [...new Set(input.periodsWithData)].sort((a, b) => b.localeCompare(a))) {
    // Below the floor is a different exercise, not a backlog — see NEEDS_YOU_CLOSING_FLOOR_PERIOD.
    // `YYYY-MM` compares correctly as a string, which is why the periods above sort with
    // `localeCompare` rather than a date parse.
    if (period < NEEDS_YOU_CLOSING_FLOOR_PERIOD) continue;

    // A month that has not finished has no closing at all, so it is not outstanding work. This is
    // also what keeps the RUNNING month off the board, and it resolves in Cairo — a UTC reading
    // would put the new month on the board three hours early on the 1st.
    if (!isClosingPeriodComplete(period, input.now)) continue;

    const unpublishedLines: string[] = [];
    const publishedLines: string[] = [];
    for (const line of lines) {
      if (input.everPublished.has(`${line.key}|${period}`)) publishedLines.push(line.display);
      else unpublishedLines.push(line.display);
    }
    if (unpublishedLines.length === 0) continue;
    out.push({ period, opensOn: closingPeriodOpensOn(period), unpublishedLines, publishedLines });
  }
  return out;
}

/**
 * Which finished months are not fully published yet.
 *
 * 🔴 IT THROWS, AND THAT BREAKS THIS FILE'S OWN CONVENTION DELIBERATELY. Every other read here
 * returns `[]` / `false` / `null` on error, because their fail-safe direction is "treat it as
 * unpublished, leak no draft". Here an empty array means the opposite — "every month is published,
 * nothing needs you" — which is the under-report this whole module exists to prevent. The needs-you
 * adapter catches it and renders the source as unavailable, in amber, with the reason. Do not
 * helpfully restore the `catch { return []; }`.
 *
 * Head Office cannot appear: `listMonthlyClosingLines` runs every caller through
 * `selectClosingLines`, which drops it and every non-sales sentinel. That rule holds here by
 * construction rather than by being remembered.
 *
 * Periods come from `listMonthlyClosingPeriods`, i.e. only months with a VALIDATED import batch. A
 * month nobody imported has nothing to close and must never be printed as outstanding work — which
 * is also what stops this from listing every month since the data began.
 */
export async function listUnpublishedClosings(now: Date = new Date()): Promise<UnpublishedClosingPeriod[]> {
  const [lines, periodsWithData, everPublished] = await Promise.all([
    listMonthlyClosingLines(),
    listMonthlyClosingPeriods(),
    listEverPublishedClosingKeys(),
  ]);
  return selectUnpublishedClosings({ lines, periodsWithData, everPublished, now });
}

/**
 * Publish a (line, period). Idempotent — re-publishing is a no-op.
 *
 * `notify` defaults to TRUE, and that default is the safe one: publishing a closing is how a line's
 * managers learn the month is final, so silence has to be asked for explicitly and can never be the
 * result of a forgotten argument. Owner, 2026-09-07: "publish aug anti infective but with no email
 * this time" — a month being republished after a correction does not need twelve people told again.
 *
 * WHAT `notify: false` DOES NOT DO. It suppresses THIS publish's email only. It does not touch the
 * publication row, the database snapshot, the drift baseline, or who can see the closing in the
 * portal — a silently published month is published in every other respect. It also does not reach
 * the CEO's Source-of-Sales BI report, which is a separate daily cron that fires once every active
 * line for a period is published; if that must stay quiet too, it is a different switch.
 */
export async function publishClosing(input: {
  line: string;
  period: string;
  actorHrId: string | null;
  /** Send the "closing published" email to the line's managers. Defaults to true. */
  notify?: boolean;
}): Promise<void> {
  const line = String(input.line ?? "").trim();
  const period = String(input.period ?? "").trim();
  const normalizedLine = normalizeClosingLine(line);
  if (!normalizedLine || !period) {
    throw new Error("A line and a period are required to publish a closing.");
  }

  // THE HEAD OFFICE RULE — Head Office is never a closing, on any month. See the gate above.
  assertNotHeadOfficeClosing(line);

  // THE CLOSING GOLDEN RULE — a month's closing is never released during that month.
  // Publishing notifies every sales/product manager and arms the CEO's SoS report, and a sent
  // mail cannot be recalled by unpublishing. See src/lib/sales/closing-period-gate.ts.
  assertClosingPeriodComplete(period);

  // THE SNAPSHOT IS TAKEN BY THE DATABASE, NOT HERE — and this payload must stay four columns.
  //
  // `trg_publication_take_snapshot` (BEFORE INSERT on monthly_closing_publications) fills
  // snapshot_units / snapshot_cells / snapshot_breakdown / snapshot_taken_at in the same statement
  // that writes the row, so a published closing always carries a baseline and
  // phx_closing_publication_drift can later show that a factory-price edit or a re-attribution
  // moved it. In the DB because a Supabase request that times out at 15s still commits, so
  // insert-then-update could publish a closing with no baseline at all.
  //
  // DO NOT add snapshot_* to this payload. On a re-publish the upsert takes the ON CONFLICT branch
  // and writes exactly the columns named here — so naming them would overwrite the published
  // baseline with today's figures, at precisely the moment someone is asking whether the figures
  // moved. Leaving them out is what makes a re-publish a no-op for the snapshot.
  // Pinned by tests/closing-publication-snapshot.test.ts.
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("monthly_closing_publications")
    .upsert(
      {
        line,
        normalized_line: normalizedLine,
        period,
        published_by: input.actorHrId,
        // Re-publishing REVIVES a withdrawn row rather than leaving it dead. The row is never
        // deleted any more (see 20260907140000), so without clearing these two a month that had
        // been unpublished would upsert back into the table still marked withdrawn — invisible to
        // every reader, and it would not re-freeze, because the freeze trigger ignores a row that
        // arrives already-withdrawn. Nulling them here is what makes publish mean publish.
        unpublished_at: null,
        unpublished_by: null,
      },
      { onConflict: "normalized_line,period" },
    )
    .select("published_at")
    .single();
  if (error) throw new Error(error.message);
  invalidateClosingStoreSplitCache(`closing published — ${line}/${period}`);
  bumpCustomer360Cache("monthly closing published");

  // Best-effort: a notification failure must never turn a successful publish into an error response.
  // publishedAt anchors the send's idempotency key — a true re-publish (this row didn't exist a
  // moment ago, e.g. after an unpublish) gets a fresh timestamp and sends again; a same-row no-op
  // publish keeps the same timestamp and does not re-send. See closing-publish-notification.ts.
  //
  // `notify === false` is the owner asking for a silent publish. It is checked HERE, at the single
  // send site, rather than inside notifyClosingPublished — so the suppression is visible beside the
  // publish it belongs to, and a future caller of the notifier cannot inherit a silence it never
  // asked for.
  const publishedAt = String((data as { published_at?: string } | null)?.published_at ?? "");
  if (publishedAt && input.notify !== false) {
    notifyClosingPublished({ line, period, publishedAt }).catch((notifyError) => {
      logError("closing_published_notification_failed", {
        error: notifyError,
        labels: { event: "closing_published_notification_failed" },
        context: { line, period },
      });
    });
  }
}

/**
 * Unpublish a (line, period) — hides it from the portal again.
 *
 * IT DOES NOT UNFREEZE THE MONTH, and it no longer deletes the row.
 *
 * Owner rule, 2026-09-07: once a closing is published, its numbers never move again. The freeze is
 * therefore anchored to having BEEN published, not to being published right now — so withdrawing a
 * month from the portal leaves `monthly_closing_locks` exactly as it was. Releasing a month is one
 * deliberate, audited act (`unlockClosing`, Super Admin, with a reason), never a side effect of a
 * visibility toggle.
 *
 * The row is stamped rather than removed, because a publication is a fact about the past. August
 * 2026 was published, announced, and later unpublished; the DELETE took the only evidence with it,
 * and the investigation on 2026-09-07 had to reconstruct from the audit log that August had ever
 * been published at all. `trg_publication_no_delete` now refuses the DELETE outright, so this is
 * the only path — for ad-hoc SQL and migrations too.
 */
export async function unpublishClosing(input: {
  actorHrId?: string | null;
  line: string;
  period: string;
}): Promise<void> {
  const normalizedLine = normalizeClosingLine(input.line);
  const period = String(input.period ?? "").trim();
  if (!normalizedLine || !period) {
    throw new Error("A line and a period are required to unpublish a closing.");
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("monthly_closing_publications")
    .update({ unpublished_at: new Date().toISOString(), unpublished_by: input.actorHrId ?? null })
    .eq("normalized_line", normalizedLine)
    .eq("period", period)
    .is("unpublished_at", null);
  if (error) throw new Error(error.message);
  invalidateClosingStoreSplitCache(`closing unpublished — ${input.line}/${period}`);
  bumpCustomer360Cache("monthly closing unpublished");
}
