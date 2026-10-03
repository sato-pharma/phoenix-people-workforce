// The counter that makes a dead token's polling VISIBLE to this application at all.
//
// Before this, a refused feed read left no trace anywhere Phoenix can see. The route answers 403
// and returns; the only record was Railway's HTTP log, which the app cannot read and which keeps
// barely a quarter of an hour of HTTP lines for the current deployment. So a ghost sheet polling a
// revoked token once a minute for two months was, from inside the system, indistinguishable from
// nothing happening at all. `dead-token-polling.ts` holds the judgement; this holds the two fields
// it judges.
//
// COUNTED ONLY FOR A LINK THAT EXISTS, and that is a security decision, not an omission. These
// routes are unauthenticated by design, so a caller can put any string in the URL. If an unknown
// token were recorded, the write path would be a stranger's to drive — an unbounded insert from the
// open internet. A refusal is therefore only ever an UPDATE of a row that was already there, which
// a caller can only reach by holding a token Phoenix itself minted.
//
// BEST-EFFORT, NEVER THROWING, for the same reason `access_count` is: the counter exists to
// describe a refusal, and a counter that can turn a 403 into a 500 would be reporting the problem
// by causing a worse one.

import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Record that a dead link was read, on the link's own row.
 *
 * Read-modify-write, matching the `access_count` bump in all three share-link services. Two
 * refusals landing in the same instant can lose one count, and that is accepted deliberately: the
 * number is evidence of an AUTOMATION, judged against a floor of ten over a 24-hour window, and a
 * poller producing 1,440 refusals a day cannot be pushed under that floor by a lost increment. A
 * stored procedure to make it atomic would be real machinery bought for no gain in the only
 * question the figure is ever asked.
 *
 * `link` is the row the caller has already loaded, so this costs one write and no extra read.
 */
export async function noteDeadShareTokenRead(
  table: string,
  link: Record<string, unknown>,
): Promise<void> {
  const id = String(link.id ?? "").trim();
  if (!id) return;
  const current = Number(link.refused_count ?? 0);
  try {
    const { error } = await getSupabaseAdmin()
      .from(table)
      .update({
        last_refused_at: new Date().toISOString(),
        refused_count: (Number.isFinite(current) ? current : 0) + 1,
      })
      .eq("id", id);
    if (error) throw error;
  } catch (error) {
    // Warning, not error: the caller is about to refuse the request correctly either way, and the
    // one thing that must not happen is this becoming the reason a 403 turns into a 500.
    logWarning("Could not record a refused share-link read", {
      error,
      labels: { event: "share_link_refusal_not_recorded", table },
    });
  }
}
