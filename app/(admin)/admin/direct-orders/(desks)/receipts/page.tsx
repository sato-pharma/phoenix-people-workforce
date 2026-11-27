import { redirect } from "next/navigation";
import { BookCheck } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ReceiptBooksDesk } from "@/components/direct-orders/receipt-books-desk";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canManageDirectOrderReceiptBooks } from "@/lib/direct-orders/finance-authority";
import { loadDirectOrderReceiptRegister, type DirectOrderReceiptRegister } from "@/lib/direct-orders/receipt-books";
import { logError } from "@/lib/observability/log";

export const dynamic = "force-dynamic";

/**
 * The delivery-receipt books — Finance's desk (owner, 26 Nov 2026: "Finance").
 * Gated like the Held Desk: the actions are Finance's alone, so everyone else is sent back.
 */
export default async function DirectOrderReceiptBooksPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (!canManageDirectOrderReceiptBooks(access)) redirect("/admin/direct-orders");
  // A failed read is said as such — never an empty desk that reads as "nothing owed".
  let register: DirectOrderReceiptRegister | null = null;
  try {
    register = await loadDirectOrderReceiptRegister(access);
  } catch (error) {
    logError("Direct-order receipt register could not be read", { labels: { event: "direct_order_receipt_register_failed" }, error });
  }
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders — Receipt Books"
        description="Who holds each numbered receipt book, which approved orders still owe a signed and stamped receipt, and every receipt entered. A receipt proves one order only."
        icon={<BookCheck className="h-3.5 w-3.5" />}
      />
      {register ? (
        <ReceiptBooksDesk register={register} />
      ) : (
        <p className="border border-rose-300 bg-white px-3 py-2 text-phx-sm font-bold text-rose-700">
          The receipt register could not be read just now, so nothing on it is shown. Reload the page in a minute.
        </p>
      )}
    </div>
  );
}
