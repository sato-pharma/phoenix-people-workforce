import Link from "next/link";

import { adminPanelClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { formatDateOnly } from "@/lib/date-only";
import type { PaymentStandingNotice } from "@/lib/direct-orders/payment-standing";
import { cn } from "@/lib/utils";

const money = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;
const day = (value: string | null) => formatDateOnly(value, "en-GB", { day: "numeric", month: "short", year: "numeric" }, "no date written");

/**
 * What the pharmacy still owes, on an order still being decided (owner, 27 Nov 2026). An earlier order
 * of the same product with nothing paid refuses this one; a part-paid product, or any order still owing
 * after its collection date, means only the CEO's own approval can finish it. The server enforces both
 * at the last approval; this panel only says it in advance, to everyone who can see the order.
 */
export function DirectOrderPaymentStandingNotice({
  notice,
  orderHrefBase = null,
}: {
  notice: PaymentStandingNotice;
  /** Where an earlier order opens; null where the viewer may not be able to open another manager's order. */
  orderHrefBase?: string | null;
}) {
  if (notice.unavailable) {
    return (
      <section className={adminPanelClassName}>
        <header className={cn(adminPanelHeaderClassName, "px-4 py-2.5")}>
          <h2 className="text-phx-xs font-black uppercase tracking-wider text-white">Payment record</h2>
        </header>
        <p className="p-4 text-phx-sm text-rose-700">
          This pharmacy&apos;s payment record could not be read just now. The check runs again when the order is approved.
        </p>
      </section>
    );
  }
  const refused = notice.verdict.kind === "refused";
  return (
    <section className={cn(adminPanelClassName, "border-l-4", refused ? "border-l-rose-600" : "border-l-amber-500")}>
      <header className={cn(adminPanelHeaderClassName, "px-4 py-2.5")}>
        <h2 className="text-phx-xs font-black uppercase tracking-wider text-white">
          {refused ? "Payment record — this order cannot be approved" : "Payment record — only Dr Anwar can approve"}
        </h2>
      </header>
      <div className="space-y-3 p-4">
        <p className={cn("text-phx-sm font-bold", refused ? "text-rose-700" : "text-amber-800")}>{notice.verdict.message}</p>
        <ul className="divide-y divide-slate-200 border-t border-slate-200">
          {notice.lines.map((line) => (
            <li className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3" key={line.requestId}>
              <div className="min-w-0">
                {orderHrefBase ? (
                  <Link className="break-words text-phx-sm font-bold text-slate-900 underline-offset-2 hover:underline" href={`${orderHrefBase}/${line.requestId}`}>
                    {line.products}
                  </Link>
                ) : (
                  <p className="break-words text-phx-sm font-bold text-slate-900">{line.products}</p>
                )}
                {line.sameProduct ? (
                  <p className="text-phx-xs font-bold text-slate-600">
                    {line.sameProduct === "unpaid" ? "Same product, nothing paid" : "Same product, part-paid"}
                  </p>
                ) : null}
              </div>
              <p className="text-phx-sm font-bold tabular-nums text-slate-900">{money(line.owed)} still owed</p>
              <p className={cn("text-phx-sm", line.late ? "font-bold text-rose-700" : "text-slate-600")}>
                {line.late ? `Due ${day(line.collectionDate)}, not paid` : `Due ${day(line.collectionDate)}`}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
