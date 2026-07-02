"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type {
  CustomerPharmacyReadiness,
  CustomerPharmacyReadinessBucket,
  CustomerPharmacyReadinessRow,
  CustomerPharmacyCustomerType,
  CustomerPharmacyValidationStatus,
} from "@/lib/customer-pharmacy-mapping/readiness";
import { cn } from "@/lib/utils";

// This component is intentionally standalone. It shares no state, props, or rendering with the
// Customer Validation workspace (`marketing-validation-workspace.tsx`) and talks only to the
// dedicated `/api/customer-pharmacy-mapping` endpoint. Read-only: no editing, matching, or writes.

type BucketFilter = "all" | CustomerPharmacyReadinessBucket;
type TypeFilter = "all" | CustomerPharmacyCustomerType;
type InferredFilter = "all" | "inferred";

const EMPTY_READINESS: CustomerPharmacyReadiness = {
  rows: [],
  summary: { ready: 0, pendingOnly: 0, noLinks: 0, total: 0, inferredCustomers: 0 },
};

const CUSTOMER_TYPES: CustomerPharmacyCustomerType[] = [
  "doctor",
  "hospital",
  "clinic",
  "account",
  "other",
];

const BUCKET_LABELS: Record<CustomerPharmacyReadinessBucket, string> = {
  ready: "Ready",
  pending_only: "Pending only",
  no_links: "No pharmacy links",
};

function bucketBadgeVariant(bucket: CustomerPharmacyReadinessBucket) {
  if (bucket === "ready") return "success" as const;
  if (bucket === "pending_only") return "warning" as const;
  return "neutral" as const;
}

const STATUS_LABELS: Record<CustomerPharmacyValidationStatus, string> = {
  pending: "Pending",
  system_validated: "System validated",
  sfe_validated: "SFE validated",
  rejected: "Rejected",
};

function statusBadgeVariant(status: CustomerPharmacyValidationStatus) {
  if (status === "system_validated" || status === "sfe_validated") return "success" as const;
  if (status === "rejected") return "danger" as const;
  return "warning" as const;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

type SummaryCardProps = {
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
  accent: string;
};

function SummaryCard({ label, value, active, onClick, accent }: SummaryCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-1 rounded-sm border px-4 py-3 text-left transition",
        active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white hover:border-slate-400",
      )}
    >
      <span className={cn("text-[10px] font-bold uppercase tracking-[0.14em]", active ? "text-white/70" : accent)}>
        {label}
      </span>
      <span className="text-2xl font-bold tabular-nums">{value}</span>
    </button>
  );
}

export function CustomerPharmacyMappingWorkspace() {
  const [readiness, setReadiness] = useState<CustomerPharmacyReadiness>(EMPTY_READINESS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [inferredFilter, setInferredFilter] = useState<InferredFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Runs once on mount; initial state is already { loading: true, error: null },
    // so no synchronous setState reset is needed here (avoids cascading renders).
    let cancelled = false;

    fetch("/api/customer-pharmacy-mapping", { headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (CustomerPharmacyReadiness & { message?: string; error?: string })
          | null;
        if (!response.ok) {
          throw new Error(payload?.message || "Failed to load customer pharmacy mapping.");
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setReadiness({
          rows: payload?.rows ?? [],
          summary: payload?.summary ?? EMPTY_READINESS.summary,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load customer pharmacy mapping.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return readiness.rows.filter((row) => {
      if (bucketFilter !== "all" && row.bucket !== bucketFilter) return false;
      if (typeFilter !== "all" && row.customerType !== typeFilter) return false;
      if (inferredFilter === "inferred" && row.inferredLinkCount === 0) return false;
      if (term.length > 0) {
        const haystack = `${row.customerName} ${row.customerCode ?? ""}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [readiness.rows, search, bucketFilter, typeFilter, inferredFilter]);

  function toggleExpanded(customerId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) {
        next.delete(customerId);
      } else {
        next.add(customerId);
      }
      return next;
    });
  }

  if (loading) {
    return <p className="text-sm font-medium text-slate-500">Loading customer pharmacy mapping…</p>;
  }

  if (error) {
    return (
      <div className="rounded-sm border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
        {error}
      </div>
    );
  }

  const { summary } = readiness;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard
          label="Ready"
          value={summary.ready}
          accent="text-emerald-600"
          active={bucketFilter === "ready"}
          onClick={() => setBucketFilter((prev) => (prev === "ready" ? "all" : "ready"))}
        />
        <SummaryCard
          label="Pending only"
          value={summary.pendingOnly}
          accent="text-orange-600"
          active={bucketFilter === "pending_only"}
          onClick={() => setBucketFilter((prev) => (prev === "pending_only" ? "all" : "pending_only"))}
        />
        <SummaryCard
          label="No pharmacy links"
          value={summary.noLinks}
          accent="text-slate-600"
          active={bucketFilter === "no_links"}
          onClick={() => setBucketFilter((prev) => (prev === "no_links" ? "all" : "no_links"))}
        />
        <SummaryCard
          label="Total customers"
          value={summary.total}
          accent="text-slate-600"
          active={bucketFilter === "all"}
          onClick={() => setBucketFilter("all")}
        />
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full lg:max-w-sm">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search customer name or code…"
            aria-label="Search customer name or code"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={bucketFilter}
            onChange={(event) => setBucketFilter(event.target.value as BucketFilter)}
            aria-label="Filter by readiness bucket"
            className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text"
          >
            <option value="all">All readiness</option>
            <option value="ready">Ready</option>
            <option value="pending_only">Pending only</option>
            <option value="no_links">No pharmacy links</option>
          </select>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
            aria-label="Filter by customer type"
            className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text"
          >
            <option value="all">All types</option>
            {CUSTOMER_TYPES.map((type) => (
              <option key={type} value={type}>
                {titleCase(type)}
              </option>
            ))}
          </select>
          <select
            value={inferredFilter}
            onChange={(event) => setInferredFilter(event.target.value as InferredFilter)}
            aria-label="Filter by inferred links"
            className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-text"
          >
            <option value="all">All links</option>
            <option value="inferred">Has inferred links</option>
          </select>
        </div>
      </div>

      <p className="text-xs font-medium text-slate-500">
        Showing {filteredRows.length} of {summary.total} customers
        {summary.inferredCustomers > 0 ? ` · ${summary.inferredCustomers} with inferred historical links` : ""}
      </p>

      <div className="overflow-x-auto rounded-sm border border-slate-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-slate-900 text-left text-[11px] font-bold uppercase tracking-[0.1em] text-white">
              <th className="whitespace-nowrap px-3 py-2.5">Customer</th>
              <th className="whitespace-nowrap px-3 py-2.5">Code</th>
              <th className="whitespace-nowrap px-3 py-2.5">Type</th>
              <th className="whitespace-nowrap px-3 py-2.5">Area</th>
              <th className="whitespace-nowrap px-3 py-2.5">Governorate</th>
              <th className="whitespace-nowrap px-3 py-2.5">Readiness</th>
              <th className="whitespace-nowrap px-3 py-2.5 text-right">Validated</th>
              <th className="whitespace-nowrap px-3 py-2.5 text-right">Pending</th>
              <th className="whitespace-nowrap px-3 py-2.5 text-right">Total</th>
              <th className="whitespace-nowrap px-3 py-2.5">Links</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-sm font-medium text-slate-500">
                  No customers match the current filters.
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => (
                <CustomerRow
                  key={row.customerId}
                  row={row}
                  expanded={expanded.has(row.customerId)}
                  onToggle={() => toggleExpanded(row.customerId)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type CustomerRowProps = {
  row: CustomerPharmacyReadinessRow;
  expanded: boolean;
  onToggle: () => void;
};

function CustomerRow({ row, expanded, onToggle }: CustomerRowProps) {
  const canExpand = row.totalLinkCount > 0;

  return (
    <>
      <tr className="border-b border-orange-100 align-middle">
        <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-slate-900">{row.customerName}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.customerCode ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
          {row.customerType ? titleCase(row.customerType) : "—"}
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.areaName ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.governorateName ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <Badge variant={bucketBadgeVariant(row.bucket)}>{BUCKET_LABELS[row.bucket]}</Badge>
            {row.inferredLinkCount > 0 ? (
              <Badge variant="neutral" title="Contains links inferred from history, not GPS field-validated">
                Inferred
              </Badge>
            ) : null}
          </div>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-700">{row.validatedLinkCount}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-700">{row.pendingLinkCount}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">
          {row.totalLinkCount}
        </td>
        <td className="whitespace-nowrap px-3 py-2.5">
          {canExpand ? (
            <button
              type="button"
              onClick={onToggle}
              className="rounded-sm border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-500"
            >
              {expanded ? "Hide" : `View ${row.totalLinkCount}`}
            </button>
          ) : (
            <span className="text-xs font-medium text-slate-400">None</span>
          )}
        </td>
      </tr>
      {expanded && canExpand ? (
        <tr className="border-b border-orange-100 bg-slate-50">
          <td colSpan={10} className="px-3 py-3">
            <div className="space-y-2">
              {row.links.map((link) => (
                <div
                  key={link.linkId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-slate-200 bg-white px-3 py-2"
                >
                  <span className="whitespace-nowrap text-sm font-semibold text-slate-900">{link.pharmacyName}</span>
                  {link.pharmacyCode ? (
                    <span className="whitespace-nowrap text-xs font-medium text-slate-500">({link.pharmacyCode})</span>
                  ) : null}
                  <span className="text-slate-300">·</span>
                  <span className="whitespace-nowrap text-sm text-slate-700">{link.distributorName}</span>
                  {link.distributorPharmacyCode ? (
                    <span className="whitespace-nowrap text-xs font-medium text-slate-500">
                      code {link.distributorPharmacyCode}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1.5">
                    <Badge variant={statusBadgeVariant(link.validationStatus)}>
                      {STATUS_LABELS[link.validationStatus]}
                    </Badge>
                    {link.inferredFromHistory ? (
                      <Badge variant="neutral" title="Inferred from historical marketing requests">
                        Inferred — not GPS field-validated
                      </Badge>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
