"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalMetricCard,
  PortalPagination,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  MarketingCustomerDatabaseRow,
  MarketingCustomerDatabaseWorkspace,
  MarketingValidationStatus,
} from "@/lib/marketing-requests/types";
import { venueCanAttributeSales, venueTypeLabel } from "@/lib/venues/venue-type";

const PAGE_SIZE = 25;

function emptyWorkspace(): MarketingCustomerDatabaseWorkspace {
  return {
    rows: [],
    summary: {
      customers: 0,
      pharmacies: 0,
      rows: 0,
      vendors: 0,
    },
  };
}

function statusVariant(status: MarketingValidationStatus): "success" | "warning" | "danger" | "neutral" {
  if (status === "system_validated" || status === "sfe_validated") return "success";
  if (status === "rejected") return "danger";
  if (status === "pending") return "warning";
  return "neutral";
}

function TextCell({ value }: { value: string | null | undefined }) {
  return <span className="text-slate-700">{value || "Not captured"}</span>;
}

function CodeCell({ value }: { value: number | string | null | undefined }) {
  return (
    <span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs font-bold text-slate-700">
      {value || "-"}
    </span>
  );
}

function PhotoCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-400">No photo</span>;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return (
      <a
        className="font-bold text-orange-700 underline decoration-orange-300 underline-offset-4"
        href={value}
        rel="noreferrer"
        target="_blank"
      >
        Open photo
      </a>
    );
  }
  return <CodeCell value={value} />;
}

/**
 * A venue with no distributor account did not FAIL to capture a vendor — it has none to capture.
 * A blank or a `-` reads as missing data and sends someone hunting for a code that does not exist,
 * which is how the invented ones (`0000`, `0001000000`, `0001511111`) reached production.
 */
function vendorNameLabel(row: MarketingCustomerDatabaseRow): string {
  if (row.distributorName) return row.distributorName;
  return venueCanAttributeSales(row.venueType) ? "Not captured" : "No distributor account";
}

function VendorCodeCell({
  row,
  value,
}: {
  row: MarketingCustomerDatabaseRow;
  value: number | string | null | undefined;
}) {
  if (!value && !venueCanAttributeSales(row.venueType)) {
    return <span className="whitespace-nowrap text-xs font-bold text-slate-500">No distributor account</span>;
  }
  return <CodeCell value={value} />;
}

function CustomerRowCard({ row }: { row: MarketingCustomerDatabaseRow }) {
  return (
    <PortalRecordCard
      accent={row.validationStatus === "rejected" ? "rose" : row.validationStatus === "pending" ? "amber" : "emerald"}
      meta={
        <span className="inline-flex flex-wrap gap-1.5">
          <CodeCell value={row.customerCode} />
          <span className="capitalize">{row.customerType}</span>
          {/* Only worth a chip when it changes how the row reads — a pharmacy's vendor columns already say it. */}
          {venueCanAttributeSales(row.venueType) ? null : (
            <span className="font-black text-orange-700">{venueTypeLabel(row.venueType)}</span>
          )}
        </span>
      }
      status={<Badge variant={statusVariant(row.validationStatus)}>{row.validationStatus.replace(/_/g, " ")}</Badge>}
      title={row.customerName || row.pharmacyName || "Customer row"}
    >
      <PortalRecordFields
        fields={[
          { label: "Customer area", value: row.customerArea || "Not captured" },
          { label: "Governorate", value: row.customerGovernorate || "Not captured" },
          { label: "Pharmacy", value: row.pharmacyName || "Not captured" },
          { label: "Vendor", value: vendorNameLabel(row) },
          {
            label: "Vendor code",
            value: row.vendorPharmacyCode || (venueCanAttributeSales(row.venueType) ? "-" : "None"),
          },
          { label: "Phone", value: row.customerPhone || "Not captured" },
        ]}
      />
      {row.customerAddress || row.pharmacyAddress ? (
        <p className="mt-2 rounded border border-slate-100 bg-white px-2.5 py-2 text-xs font-semibold leading-5 text-slate-600">
          {row.customerAddress || row.pharmacyAddress}
        </p>
      ) : null}
    </PortalRecordCard>
  );
}

export function MarketingCustomerDatabase() {
  const [workspace, setWorkspace] = useState<MarketingCustomerDatabaseWorkspace>(emptyWorkspace);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  async function loadWorkspace() {
    setIsLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/marketing-requests/customer-database", {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyWorkspace());
        setMessage(payload.message ?? "Unable to load customer database.");
        return;
      }
      setWorkspace({
        rows: payload.rows ?? [],
        summary: payload.summary ?? emptyWorkspace().summary,
      });
      setPage(1);
    } catch {
      setWorkspace(emptyWorkspace());
      setMessage("Unable to load customer database.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const totalPages = Math.max(1, Math.ceil(workspace.rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRows = useMemo(
    () => workspace.rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [safePage, workspace.rows],
  );
  const pageLabel = workspace.rows.length === 0
    ? "0 rows"
    : `${(safePage - 1) * PAGE_SIZE + 1}-${Math.min(safePage * PAGE_SIZE, workspace.rows.length)} of ${workspace.rows.length} rows`;

  return (
    <div className="space-y-6">
      <PortalSection className="p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-5">
          <PortalMetricCard label="Rows" value={workspace.summary.rows} />
          <PortalMetricCard accent="sky" label="Customers" value={workspace.summary.customers} />
          <PortalMetricCard accent="emerald" label="Pharmacies" value={workspace.summary.pharmacies} />
          <PortalMetricCard accent="slate" label="Vendors" value={workspace.summary.vendors} />
          <button
            className="flex min-h-[78px] items-center justify-center gap-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            onClick={() => void loadWorkspace()}
            type="button"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </PortalSection>

      {message ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          {message}
        </div>
      ) : null}

      <PortalSection
        actions={<Badge variant="neutral">{workspace.rows.length} rows</Badge>}
        eyebrow="Customer Database"
        title="Customer, pharmacy, and vendor rows"
      >
        <PortalResponsiveDataList
          empty={
            !isLoading ? (
              <PortalEmptyState
                message="Validated customer, pharmacy, and vendor rows will appear here once requests are approved."
                title="No customer database rows yet"
              />
            ) : (
              <div className="px-4 py-8 text-center text-sm font-semibold text-slate-500">
                <span className="inline-flex items-center gap-2"><LoadingSpinner /> Loading customer database...</span>
              </div>
            )
          }
          getKey={(row) => row.rowId}
          items={pagedRows}
          renderCard={(row) => <CustomerRowCard row={row} />}
          renderTable={() => (
            <PortalDesktopTable minWidth="1620px">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Customer Type</th>
                <th className="px-4 py-3">Customer ID</th>
                <th className="px-4 py-3">Customer Name</th>
                <th className="px-4 py-3">Customer Area</th>
                <th className="px-4 py-3">Customer Governorate</th>
                <th className="px-4 py-3">Customer Phone</th>
                <th className="px-4 py-3">Customer Address</th>
                <th className="px-4 py-3">Customer Validation Photo</th>
                <th className="px-4 py-3">Pharmacy ID</th>
                <th className="px-4 py-3">Pharmacy Name</th>
                <th className="px-4 py-3">Pharmacy Area</th>
                <th className="px-4 py-3">Pharmacy Governorate</th>
                <th className="px-4 py-3">Pharmacy Address</th>
                <th className="px-4 py-3">Venue Type</th>
                <th className="px-4 py-3">Vendor ID</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Vendor Pharmacy Code</th>
                <th className="px-4 py-3">Vendor Code Row ID</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {pagedRows.map((row: MarketingCustomerDatabaseRow) => (
                <tr className="align-top" key={row.rowId}>
                  <td className="px-4 py-3 font-bold capitalize text-slate-700">{row.customerType}</td>
                  <td className="px-4 py-3"><CodeCell value={row.customerCode} /></td>
                  <td className="px-4 py-3 font-black text-slate-950">{row.customerName}</td>
                  <td className="px-4 py-3"><TextCell value={row.customerArea} /></td>
                  <td className="px-4 py-3"><TextCell value={row.customerGovernorate} /></td>
                  <td className="px-4 py-3"><TextCell value={row.customerPhone} /></td>
                  <td className="max-w-[280px] px-4 py-3 leading-5"><TextCell value={row.customerAddress} /></td>
                  <td className="px-4 py-3"><PhotoCell value={row.customerValidationPhoto} /></td>
                  <td className="px-4 py-3"><CodeCell value={row.pharmacyCode} /></td>
                  <td className="px-4 py-3 font-black text-slate-950">{row.pharmacyName}</td>
                  <td className="px-4 py-3"><TextCell value={row.pharmacyArea} /></td>
                  <td className="px-4 py-3"><TextCell value={row.pharmacyGovernorate} /></td>
                  <td className="max-w-[280px] px-4 py-3 leading-5"><TextCell value={row.pharmacyAddress} /></td>
                  <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-700">{venueTypeLabel(row.venueType)}</td>
                  <td className="px-4 py-3"><VendorCodeCell row={row} value={row.distributorCode || row.distributorId} /></td>
                  <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-800">{vendorNameLabel(row)}</td>
                  <td className="px-4 py-3"><VendorCodeCell row={row} value={row.vendorPharmacyCode} /></td>
                  <td className="px-4 py-3"><VendorCodeCell row={row} value={row.pharmacyDistributorCodeId} /></td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant(row.validationStatus)}>{row.validationStatus.replace(/_/g, " ")}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
            </PortalDesktopTable>
          )}
        />
        <PortalPagination label={pageLabel}>
          <button
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40"
            disabled={safePage <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            type="button"
          >
            Previous
          </button>
          <button
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40"
            disabled={safePage >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            type="button"
          >
            Next
          </button>
        </PortalPagination>
      </PortalSection>
    </div>
  );
}
