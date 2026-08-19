import { MarketingRequestCaseFile } from "@/components/marketing-requests/marketing-request-case-file";

import { assertMarketingAdminPageAccess } from "../../admin-access";

/**
 * The Case File in the ADMIN shell.
 *
 * One of three mounts of the same component, following the MarketingRequestSalesView precedent.
 * The duplication is intentional: each role reaches this screen inside its own layout, and the
 * server-side gate differs per shell. Collapsing the three into one would either strand a shell or
 * put a role in the wrong chrome — the component itself is written once.
 *
 * No navigation entry is added anywhere. Build alongside, retire later; linking it in is its own
 * step and its own decision.
 */
export const dynamic = "force-dynamic";

export default async function AdminMarketingRequestCaseFilePage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  await assertMarketingAdminPageAccess({ allowCompanyOversight: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#F97316]">Marketing · Case File</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Marketing Request Case File</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Everything about one marketing request in one place — the ask, the chain that decided it, where the money is
          pointed, and what came back. A check that could not run is shown as unknown, never as a clean pass.
        </p>
      </div>
      <MarketingRequestCaseFile requestId={requestId} />
    </div>
  );
}
