import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { loadCustomerSales } from "@/lib/sales/customer-directory";
import { formatCurrency, formatNumber } from "@/lib/sales/format";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ clientCode: string; distributor: string }>;
};

const headerCell = "px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em]";

export default async function CustomerDetailPage({ params }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  // Every row of the directory links here, so this admits whoever the directory admits.
  if (access.role !== "Super Admin" && access.role !== "SFE Manager" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }

  const { clientCode, distributor } = await params;
  const decodedClientCode = decodeURIComponent(clientCode);
  const decodedDistributor = decodeURIComponent(distributor);

  let detail = null;
  let error: string | null = null;
  try {
    await assertPermission(access, "sales", "import");
    detail = await loadCustomerSales({ clientCode: decodedClientCode, distributorCode: decodedDistributor }, access.role);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Failed to load customer sales.";
  }

  const backLink = (
    <Link
      className="inline-flex items-center gap-2 border border-phx-line bg-white px-3 py-2 text-sm font-bold text-phx-ink transition hover:border-phx-accent-line hover:text-phx-accent"
      href="/sales/customer-directory"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to Customer Directory
    </Link>
  );

  if (error || !detail) {
    return (
      <div className="min-h-[calc(100vh-7rem)] space-y-6">
        <AdminPageHero
          actions={backLink}
          description="The requested customer could not be found for this distributor."
          eyebrow="Customer Directory"
          title="Customer not found"
        />
        {error ? (
          <AdminCallout tone="danger">
            <p>{error}</p>
          </AdminCallout>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        actions={backLink}
        badges={(
          <>
            <AdminInsightChip>Code: {detail.clientCode}</AdminInsightChip>
            <AdminInsightChip>Distributor: {detail.distributorName}</AdminInsightChip>
            <AdminInsightChip tone="slate">{detail.brickName} · {detail.areaName} · {detail.regionName}</AdminInsightChip>
            <AdminInsightChip tone="orange">Total: {formatCurrency(detail.totalValue)} · {formatNumber(detail.totalUnits)} units</AdminInsightChip>
          </>
        )}
        description={detail.clientAddress || "No address on file."}
        eyebrow="Customer Directory"
        title={detail.clientName || detail.clientCode}
      />

      <AdminTableShell description="Each product this customer purchased (from this distributor), with computed value." title="Sales by Product">
        <div className="p-4 md:p-5">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[22%]" />
              <col className="w-[14%]" />
              <col className="w-[24%]" />
            </colgroup>
            <thead className="bg-[#0B0B0B] text-slate-100">
              <tr>
                <th className={headerCell}>Product</th>
                <th className={headerCell}>Line</th>
                <th className={`${headerCell} text-right`}>Units</th>
                <th className={`${headerCell} text-right`}>Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line">
              {detail.productTotals.map((product) => (
                <tr className="align-top text-slate-600" key={product.productCode}>
                  <td className="min-w-0 break-words px-3 py-2.5 font-semibold text-phx-ink">{product.productName}</td>
                  <td className="min-w-0 break-words px-3 py-2.5">{product.officialLine}</td>
                  <td className="min-w-0 break-words px-3 py-2.5 text-right tabular-nums">{formatNumber(product.totalUnits)}</td>
                  <td className="min-w-0 break-words px-3 py-2.5 text-right tabular-nums">{formatCurrency(product.totalValue)}</td>
                </tr>
              ))}
              <tr className="bg-[#FDEAD0] font-black text-slate-900">
                <td className="px-3 py-2.5" colSpan={2}>Total</td>
                <td className="min-w-0 break-words px-3 py-2.5 text-right tabular-nums">{formatNumber(detail.totalUnits)}</td>
                <td className="min-w-0 break-words px-3 py-2.5 text-right tabular-nums">{formatCurrency(detail.totalValue)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell description="Every sales line for this customer." title="Sales Detail">
        <div className="p-4 md:p-5">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[40%]" />
              <col className="w-[14%]" />
              <col className="w-[28%]" />
            </colgroup>
            <thead className="bg-[#0B0B0B] text-slate-100">
              <tr>
                <th className={headerCell}>Period / Brick</th>
                <th className={headerCell}>Product / Line</th>
                <th className={`${headerCell} text-right`}>Qty</th>
                <th className={`${headerCell} text-right`}>Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line">
              {detail.lines.map((line, index) => (
                <tr className="align-top text-slate-600" key={`${line.invoicePeriod}:${line.productCode}:${index}`}>
                  <td className="min-w-0 break-words px-3 py-2.5">
                    <p>{line.invoicePeriod ?? "—"}</p>
                    {line.brickId ? <p className="text-xs text-slate-500">{line.brickId}</p> : null}
                  </td>
                  <td className="min-w-0 break-words px-3 py-2.5">
                    <p className="font-semibold text-phx-ink">{line.productName}</p>
                    {line.officialLine ? <p className="text-xs text-slate-500">{line.officialLine}</p> : null}
                  </td>
                  <td className="min-w-0 break-words px-3 py-2.5 text-right tabular-nums">{formatNumber(line.qty)}</td>
                  <td className="min-w-0 break-words px-3 py-2.5 text-right tabular-nums">{formatCurrency(line.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminTableShell>
    </div>
  );
}
