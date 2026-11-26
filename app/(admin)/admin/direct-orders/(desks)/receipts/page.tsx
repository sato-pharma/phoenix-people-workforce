import { redirect } from "next/navigation";
import { BookCheck } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ReceiptBooksDesk } from "@/components/direct-orders/receipt-books-desk";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canManageDirectOrderReceiptBooks } from "@/lib/direct-orders/finance-authority";
import { loadDirectOrderReceiptRegister } from "@/lib/direct-orders/receipt-books";

export const dynamic = "force-dynamic";

/**
 * The delivery-receipt books — Finance's desk (owner, 26 Nov 2026: "Finance").
 * Gated like the Held Desk: the actions are Finance's alone, so everyone else is sent back.
 */
export default async function DirectOrderReceiptBooksPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (!canManageDirectOrderReceiptBooks(access)) redirect("/admin/direct-orders");
  const register = await loadDirectOrderReceiptRegister(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders — Receipt Books"
        description="Who holds each numbered receipt book, which approved orders still owe a signed and stamped receipt, and every receipt entered. A receipt proves one order only."
        icon={<BookCheck className="h-3.5 w-3.5" />}
      />
      <ReceiptBooksDesk register={register} />
    </div>
  );
}
