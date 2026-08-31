import { invalidateClosingStoreSplitCache } from "@/lib/dashboard/invalidation";
import { isHeadOfficeLine } from "@/lib/sales/access-scope";
import { assertClosingPeriodComplete } from "@/lib/sales/closing-period-gate";
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
      .order("period", { ascending: false })
      .limit(1);
    if (error) return null;
    const period = String((data ?? [])[0]?.period ?? "").trim();
    return period || null;
  } catch {
    return null;
  }
}

/** Publish a (line, period). Idempotent — re-publishing is a no-op. */
export async function publishClosing(input: {
  line: string;
  period: string;
  actorHrId: string | null;
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

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("monthly_closing_publications")
    .upsert(
      { line, normalized_line: normalizedLine, period, published_by: input.actorHrId },
      { onConflict: "normalized_line,period" },
    )
    .select("published_at")
    .single();
  if (error) throw new Error(error.message);
  invalidateClosingStoreSplitCache(`closing published — ${line}/${period}`);

  // Best-effort: a notification failure must never turn a successful publish into an error response.
  // publishedAt anchors the send's idempotency key — a true re-publish (this row didn't exist a
  // moment ago, e.g. after an unpublish) gets a fresh timestamp and sends again; a same-row no-op
  // publish keeps the same timestamp and does not re-send. See closing-publish-notification.ts.
  const publishedAt = String((data as { published_at?: string } | null)?.published_at ?? "");
  if (publishedAt) {
    notifyClosingPublished({ line, period, publishedAt }).catch((notifyError) => {
      logError("closing_published_notification_failed", {
        error: notifyError,
        labels: { event: "closing_published_notification_failed" },
        context: { line, period },
      });
    });
  }
}

/** Unpublish a (line, period) — hides it from the portal again. */
export async function unpublishClosing(input: {
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
    .delete()
    .eq("normalized_line", normalizedLine)
    .eq("period", period);
  if (error) throw new Error(error.message);
  invalidateClosingStoreSplitCache(`closing unpublished — ${input.line}/${period}`);
}
