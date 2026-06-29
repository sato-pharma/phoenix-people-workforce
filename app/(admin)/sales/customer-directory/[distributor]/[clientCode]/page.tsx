import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadCustomerSales } from "@/lib/sales/customer-directory";
import { formatCurrency, formatNumber } from "@/lib/sales/format";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ clientCode: string; distributor: string }>;
};

const headerCell = "whitespace-nowrap px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em]";

export default async function CustomerDetailPage({ params }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  if (access.role !== "Super Admin" && access.scope !== "system") {
    redirect(resolveLandingPathForRole(access.role));
  }

  const { clientCode, distributor } = await params;
  const decodedClientCode = decodeURIComponent(clientCode);
  const decodedDistributor = decodeURIComponent(distributor);

  let detail = null;
  let error: string | null = null;
  try {
    await assertPermission(access, "sales", "import");
    detail = await loadCustomerSales({ clientCode: decodedClientCode, distributorCode: decodedDistributor });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Failed to load customer sales.";
  }

  const backLink = (
    <Link
      className="inline-flex items-center gap-2 border border-[#D8E0EA] bg-white px-3 py-2 text-sm font-bold text-[#0F172A] transition hover:border-[#FDBA74] hover:text-[#F97316]"
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
        <div className="overflow-x-auto p-4 md:p-5">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[#0B0B0B] text-slate-100">
              <tr>
                <th className={headerCell}>Product</th>
                <th className={headerCell}>Line</th>
                <th className={`${headerCell} text-right`}>Units</th>
                <th className={`${headerCell} text-right`}>Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {detail.productTotals.map((product) => (
                <tr className="text-slate-600" key={product.productCode}>
                  <td className="px-3 py-2.5 font-semibold text-[#0F172A]">{product.productName} <span className="text-xs text-slate-400">{product.productCode}</span></td>
                  <td className="px-3 py-2.5">{product.officialLine}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(product.totalUnits)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(product.totalValue)}</td>
                </tr>
              ))}
              <tr className="bg-[#FDEAD0] font-black text-slate-900">
                <td className="px-3 py-2.5" colSpan={2}>Total</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(detail.totalUnits)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(detail.totalValue)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell description="Every sales line for this customer." title="Sales Detail">
        <div className="overflow-x-auto p-4 md:p-5">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-[#0B0B0B] text-slate-100">
              <tr>
                <th className={headerCell}>Period</th>
                <th className={headerCell}>Product</th>
                <th className={headerCell}>Line</th>
                <th className={headerCell}>Brick</th>
                <th className={`${headerCell} text-right`}>Qty</th>
                <th className={`${headerCell} text-right`}>Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {detail.lines.map((line, index) => (
                <tr className="text-slate-600" key={`${line.invoicePeriod}:${line.productCode}:${index}`}>
                  <td className="whitespace-nowrap px-3 py-2.5">{line.invoicePeriod ?? "—"}</td>
                  <td className="px-3 py-2.5 font-semibold text-[#0F172A]">{line.productName} <span className="text-xs text-slate-400">{line.productCode}</span></td>
                  <td className="px-3 py-2.5">{line.officialLine}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{line.brickId}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(line.qty)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(line.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminTableShell>
    </div>
  );
}
