"use client";

import { useEffect, useState } from "react";
import { RefreshCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  MarketingCustomerDatabaseRow,
  MarketingCustomerDatabaseWorkspace,
  MarketingValidationStatus,
} from "@/lib/marketing-requests/types";

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

function Metric({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-black text-slate-950">{value}</p>
    </div>
  );
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

export function MarketingCustomerDatabase() {
  const [workspace, setWorkspace] = useState<MarketingCustomerDatabaseWorkspace>(emptyWorkspace);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

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

  return (
    <div className="space-y-6">
      <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_18px_44px_rgba(15,23,42,0.06)] sm:p-5">
        <div className="grid gap-3 md:grid-cols-5">
          <Metric label="Rows" value={workspace.summary.rows} />
          <Metric label="Customers" value={workspace.summary.customers} />
          <Metric label="Pharmacies" value={workspace.summary.pharmacies} />
          <Metric label="Vendors" value={workspace.summary.vendors} />
          <button
            className="flex min-h-[78px] items-center justify-center gap-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            onClick={() => void loadWorkspace()}
            type="button"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </Card>

      {message ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          {message}
        </div>
      ) : null}

      <Card className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">SCP / PH Database</p>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">Customer, pharmacy, and vendor rows</h2>
          </div>
          <Badge variant="neutral">{workspace.rows.length} rows</Badge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1900px] border-collapse text-left text-sm">
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
                <th className="px-4 py-3">Vendor ID</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Vendor Pharmacy Code</th>
                <th className="px-4 py-3">Vendor Code Row ID</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {workspace.rows.map((row: MarketingCustomerDatabaseRow) => (
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
                  <td className="px-4 py-3"><CodeCell value={row.distributorCode || row.distributorId} /></td>
                  <td className="px-4 py-3 font-bold text-slate-800">{row.distributorName}</td>
                  <td className="px-4 py-3"><CodeCell value={row.vendorPharmacyCode} /></td>
                  <td className="px-4 py-3"><CodeCell value={row.pharmacyDistributorCodeId} /></td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant(row.validationStatus)}>{row.validationStatus.replace(/_/g, " ")}</Badge>
                  </td>
                </tr>
              ))}
              {!isLoading && workspace.rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm font-semibold text-slate-500" colSpan={18}>
                    No customer database rows yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
