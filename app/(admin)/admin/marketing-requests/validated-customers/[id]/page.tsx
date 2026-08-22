import { redirect } from "next/navigation";

import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenValidatedCustomerRegister } from "@/lib/marketing-requests/validated-customer-transfer";
import { ValidatedCustomerDetailView } from "@/components/marketing-requests/validated-customer-detail";

export const dynamic = "force-dynamic";

/**
 * One validated customer, in full — the page behind a row in the register. The owner's ask:
 * "when I press on the customer… a new page, and they have all details in it. His brick, his area,
 * the location, the photo, evidence, everything."
 */
export default async function AdminValidatedCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!canOpenValidatedCustomerRegister(access)) redirect("/admin/marketing-requests");

  const { id } = await params;

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Customer Check</h1>
        <p className="max-w-none overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium leading-6 text-slate-600">
          Everything captured for this customer, what is still missing, and the hand-off to Direct Orders.
        </p>
      </div>
      <ValidatedCustomerDetailView customerId={id} />
    </div>
  );
}
