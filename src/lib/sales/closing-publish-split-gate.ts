// Publishing a closing never freezes a stale city split (audit P4-07, 2026-10-23).
//
// 🔴 WHY THE GATE IS AT PUBLISH. Until a month is published the closing screen applies the city split
// LIVE, from today's rows; the stored net in `au.monthly_store_split_net` is what Sales vs Target,
// achievement and the Business Review read, and it is rewritten only when an import or a brick move
// settles it. Publishing freezes the WHOLE period (any line's live publication row stops
// `phx_write_monthly_store_split_net` rewriting it), and from that moment the closing reads the
// frozen net too. So a stored net that had fallen behind today's rows was frozen as it stood: the
// month the managers were told was final was not the month the screen had shown a minute before.
//
// What the gate does, only for a split line in a split month that is NOT frozen yet:
//   - reads the drift between the stored net and today's recompute (`loadStoreSplitDrift`, by VALUE);
//   - no drift → the publish goes ahead untouched;
//   - drift → nothing is published; the stored net is rebuilt from today's rows and attribution is
//     re-stamped on it (the same two steps the brick-move drain takes), and the operator is told to
//     publish again — the next press finds no drift and publishes the month the screen showed;
//   - the drift cannot be read, or the rebuild fails → nothing is published, 503, try again.
// A period that is already frozen is left alone: its net can no longer be rewritten, and correcting a
// published month is the owner's own decision (store-split-drift.ts, "IT REPORTS, IT NEVER REPAIRS").
//
// The heavy modules are imported lazily, so this file stays importable by a test with no database.

import { SalesWorkflowError } from "@/lib/sales/contracts";

type DriftSummary = { drifted: boolean; byArea: readonly unknown[]; absoluteValueDelta: number };

export type PublishSplitGateDeps = {
  /** The city split applies to this line in this month at all. */
  splitApplies: (line: string, period: string) => boolean;
  /** Some line of this period is already published, so its net is frozen. */
  isFrozen: (line: string, period: string) => Promise<boolean>;
  loadDrift: (period: string) => Promise<DriftSummary>;
  /** Rebuild the period's stored net from today's rows, then re-stamp attribution on it. */
  settle: (period: string) => Promise<void>;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09" → "September 2026"; anything else comes back as it was. */
export function spokenPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : period;
}

function egp(value: number): string {
  return Math.round(Math.abs(value) / 2).toLocaleString("en-US");
}

async function defaultDeps(): Promise<PublishSplitGateDeps> {
  const [{ isStoreCitySplitActive, isSplitEligibleLine }, { isFrozenStoreSplitPeriod }] = await Promise.all([
    import("@/lib/sales/store-sales-city-split"),
    import("@/lib/sales/closing-store-split-net"),
  ]);
  return {
    isFrozen: (line, period) => isFrozenStoreSplitPeriod(line, period),
    loadDrift: async (period) => (await import("@/lib/sales/store-split-drift")).loadStoreSplitDrift(period),
    settle: async (period) => {
      const [{ writeStoreSplitNetForPeriods }, { getSupabaseAdmin }] = await Promise.all([
        import("@/lib/sales/attribution-store-split-refresh"),
        import("@/lib/supabase/server"),
      ]);
      const supabase = getSupabaseAdmin();
      // The net FIRST — attribution reads it, so re-stamping before the write would bake the old split in.
      await writeStoreSplitNetForPeriods(supabase as never, [period]);
      const refreshed = await supabase.rpc("phx_refresh_attribution_for_period", { p_period: period });
      if (refreshed.error) throw new Error(refreshed.error.message || "the attribution re-stamp failed");
    },
    splitApplies: (line, period) => isStoreCitySplitActive(period) && isSplitEligibleLine(line),
  };
}

/**
 * Refuse to publish a closing whose stored city split no longer matches today's rows. Returns
 * quietly when the publish may go ahead; throws a SalesWorkflowError (409 or 503) otherwise.
 */
export async function assertStoreSplitCurrentBeforePublish(
  input: { line: string; period: string },
  deps?: Partial<PublishSplitGateDeps>,
): Promise<void> {
  const line = String(input.line ?? "").trim();
  const period = String(input.period ?? "").trim();
  const complete = Boolean(deps?.splitApplies && deps.isFrozen && deps.loadDrift && deps.settle);
  const resolved = (complete ? deps : { ...(await defaultDeps()), ...deps }) as PublishSplitGateDeps;
  if (!resolved.splitApplies(line, period)) return;
  if (await resolved.isFrozen(line, period)) return;

  const month = spokenPeriod(period);
  let drift: DriftSummary;
  try {
    drift = await resolved.loadDrift(period);
  } catch {
    throw new SalesWorkflowError(
      "store_split_unreadable",
      `Could not check ${month}'s city split against today's sales rows, so nothing was published. Try again in a minute.`,
      503,
    );
  }
  if (!drift.drifted) return;

  const areas = drift.byArea.length;
  const moved = `${areas} ${areas === 1 ? "area" : "areas"}, ${egp(drift.absoluteValueDelta)} EGP between them`;
  try {
    await resolved.settle(period);
  } catch {
    throw new SalesWorkflowError(
      "store_split_stale",
      `${month}'s stored city split no longer matches today's sales rows (${moved}) and could not be rebuilt just now, so nothing was published. Try again in a few minutes.`,
      503,
    );
  }
  throw new SalesWorkflowError(
    "store_split_rebuilt",
    `${month}'s stored city split no longer matched today's sales rows (${moved}), so nothing was published. It has now been rebuilt from today's rows. Publish again to release the month.`,
    409,
  );
}
