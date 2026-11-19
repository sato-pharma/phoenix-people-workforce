import { MarketingWatchedRequests } from "@/components/marketing-requests/marketing-watched-requests";
import type { AccessContext } from "@/lib/auth/permissions";
import { isMarketingProductWatcher } from "@/lib/marketing-requests/product-watchers";
import { getMarketingWatchedProductRequests } from "@/lib/marketing-requests/service";

/**
 * The watched-products list, placed where a watcher already looks (owner, 2026-11-19: "no requests
 * appeared anywhere on his account").
 *
 * The first release put the list on its own page, reached by a sidebar row. Ahmed SharafEldeen opened
 * the portal on his phone and looked in Marketing Requests, the Marketing Inbox and the Approvals hub
 * (activity_events, 13:41–13:43 Cairo) — never the new row — and found nothing. So the same list now
 * leads those two marketing pages for a watcher. For anyone else this renders nothing and reads
 * nothing: the named list is checked before any database call.
 *
 * Read-only, exactly like the page: each row opens the request's Case File to comment. The service
 * refuses a non-watcher on its own, so this placement grants nothing.
 */
export async function MarketingWatchedRequestsSection({ access }: { access: AccessContext }) {
  if (!isMarketingProductWatcher(access.hrId)) return null;

  const workspace = await getMarketingWatchedProductRequests(access);
  const productsLabel = workspace.productNames.join(" and ") || "your products";

  return (
    <section aria-label="Requests you follow" className="space-y-3">
      <div>
        <p className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">Requests you follow</p>
        <h2 className="text-phx-lg font-black tracking-tight text-slate-950">{productsLabel}</h2>
      </div>
      <MarketingWatchedRequests workspace={workspace} />
    </section>
  );
}
