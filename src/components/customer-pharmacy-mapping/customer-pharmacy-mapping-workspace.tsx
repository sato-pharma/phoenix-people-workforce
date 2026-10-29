"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckTile } from "@/components/ui/form-kit";
import { Input } from "@/components/ui/input";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { PharmacyLicenseEvidence } from "@/components/venues/pharmacy-license-evidence";
import type {
  CustomerPharmacyCustomerType,
  CustomerPharmacyLinkSummary,
  CustomerPharmacyReadiness,
  CustomerPharmacyReadinessBucket,
  CustomerPharmacyReadinessRow,
  CustomerPharmacyValidationStatus,
} from "@/lib/customer-pharmacy-mapping/readiness";
import { cn } from "@/lib/utils";
import {
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

// This component is intentionally standalone. It shares no state, props, or rendering with the
// Customer Validation workspace (`marketing-validation-workspace.tsx`) and talks only to the
// dedicated `/api/customer-pharmacy-mapping` endpoints. It supports exactly two mutations —
// approve and reject a pending link — both via `/api/customer-pharmacy-mapping/[id]/decision`.
// No delete, no bulk actions, no merge logic, no automatic matching.

type BucketFilter = "all" | CustomerPharmacyReadinessBucket;
type TypeFilter = "all" | CustomerPharmacyCustomerType;
type LinkFlagFilter = "all" | "inferred" | "rejected";
type LinkDecision = "approve" | "reject";

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

// "Admin approved" is what the Approve button on this page writes: a person looked. "System
// validated" is the evidence gate, where no person did, so the two must never share a label.
const STATUS_LABELS: Record<CustomerPharmacyValidationStatus, string> = {
  pending: "Pending",
  system_validated: "System validated",
  sfe_validated: "SFE validated",
  admin_approved: "Admin approved",
  rejected: "Rejected",
};

function statusBadgeVariant(status: CustomerPharmacyValidationStatus) {
  if (status === "system_validated" || status === "sfe_validated" || status === "admin_approved") {
    return "success" as const;
  }
  if (status === "rejected") return "danger" as const;
  return "warning" as const;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

async function fetchReadinessPayload(): Promise<CustomerPharmacyReadiness> {
  const response = await fetch("/api/customer-pharmacy-mapping", { headers: { accept: "application/json" } });
  const payload = (await response.json().catch(() => null)) as
    | (CustomerPharmacyReadiness & { message?: string; error?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.message || "Failed to load customer pharmacy mapping.");
  }
  return { rows: payload?.rows ?? [], summary: payload?.summary ?? EMPTY_READINESS.summary };
}

type DecisionTarget = {
  linkId: string;
  customerName: string;
  pharmacyName: string;
  decision: LinkDecision;
  /** A pharmacy saved on its licence alone: approving it RELEASES it, and the licence is what is read. */
  licenseOnly: boolean;
  licenseUrl: string | null;
  licenseContentType: string | null;
};

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
        "flex flex-col items-start gap-1 border px-4 py-3 text-left transition",
        active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white hover:border-slate-400",
      )}
    >
      <span className={cn("text-phx-2xs font-bold uppercase tracking-[0.14em]", active ? "text-white/70" : accent)}>
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
  const [linkFlagFilter, setLinkFlagFilter] = useState<LinkFlagFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [decisionTarget, setDecisionTarget] = useState<DecisionTarget | null>(null);

  useEffect(() => {
    // Runs once on mount; initial state is already { loading: true, error: null },
    // so no synchronous setState reset is needed here (avoids cascading renders).
    let cancelled = false;

    fetchReadinessPayload()
      .then((data) => {
        if (!cancelled) setReadiness(data);
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

  const refreshReadiness = useCallback(async () => {
    try {
      const data = await fetchReadinessPayload();
      setReadiness(data);
    } catch {
      // The mutation already reported success/failure to the user; keep showing the last
      // known-good table rather than replacing it with an error on a background refresh.
    }
  }, []);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return readiness.rows.filter((row) => {
      if (bucketFilter !== "all" && row.bucket !== bucketFilter) return false;
      if (typeFilter !== "all" && row.customerType !== typeFilter) return false;
      if (linkFlagFilter === "inferred" && row.inferredLinkCount === 0) return false;
      if (linkFlagFilter === "rejected" && row.rejectedLinkCount === 0) return false;
      if (term.length > 0) {
        const haystack = `${row.customerName} ${row.customerCode ?? ""}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [readiness.rows, search, bucketFilter, typeFilter, linkFlagFilter]);

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

  function requestDecision(row: CustomerPharmacyReadinessRow) {
    return (link: CustomerPharmacyLinkSummary, decision: LinkDecision) =>
      setDecisionTarget({
        linkId: link.linkId,
        customerName: row.customerName,
        pharmacyName: link.pharmacyName,
        decision,
        licenseOnly: link.licenseOnly,
        licenseUrl: link.licenseUrl,
        licenseContentType: link.licenseContentType,
      });
  }

  if (loading) {
    return <p className="text-sm font-medium text-slate-500">Loading customer pharmacy mapping…</p>;
  }

  if (error) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
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
            className={phxSelectClassName}
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
            className={phxSelectClassName}
          >
            <option value="all">All types</option>
            {CUSTOMER_TYPES.map((type) => (
              <option key={type} value={type}>
                {titleCase(type)}
              </option>
            ))}
          </select>
          <select
            value={linkFlagFilter}
            onChange={(event) => setLinkFlagFilter(event.target.value as LinkFlagFilter)}
            aria-label="Filter by link flags"
            className={phxSelectClassName}
          >
            <option value="all">All links</option>
            <option value="inferred">Inferred historical links</option>
            <option value="rejected">Rejected links</option>
          </select>
        </div>
      </div>

      <p className="text-xs font-medium text-slate-500">
        Showing {filteredRows.length} of {summary.total} customers
        {summary.inferredCustomers > 0 ? ` · ${summary.inferredCustomers} with inferred historical links` : ""}
      </p>

      {filteredRows.length === 0 ? (
        <p className="border border-slate-200 px-3 py-6 text-center text-sm font-medium text-slate-500">
          No customers match the current filters.
        </p>
      ) : (
        <>
          <CrmTable columns={["26%", "17%", "17%", "9%", "9%", "8%", "14%"]}>
            <thead>
              <tr className="bg-slate-900 text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-white">
                <th className="px-3 py-2.5">Customer</th>
                <th className="px-3 py-2.5">Area</th>
                <th className="px-3 py-2.5">Readiness</th>
                <th className="px-3 py-2.5 text-right">Validated</th>
                <th className="px-3 py-2.5 text-right">Pending</th>
                <th className="px-3 py-2.5 text-right">Total</th>
                <th className="px-3 py-2.5">Links</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <CustomerRow
                  key={row.customerId}
                  row={row}
                  expanded={expanded.has(row.customerId)}
                  onToggle={() => toggleExpanded(row.customerId)}
                  onRequestDecision={requestDecision(row)}
                />
              ))}
            </tbody>
          </CrmTable>
          <CrmCardsOnPhone>
            {filteredRows.map((row) => (
              <CustomerCard
                key={row.customerId}
                row={row}
                expanded={expanded.has(row.customerId)}
                onToggle={() => toggleExpanded(row.customerId)}
                onRequestDecision={requestDecision(row)}
              />
            ))}
          </CrmCardsOnPhone>
        </>
      )}

      {decisionTarget ? (
        <LinkDecisionDialog
          target={decisionTarget}
          onClose={() => setDecisionTarget(null)}
          onDecided={() => {
            setDecisionTarget(null);
            void refreshReadiness();
          }}
        />
      ) : null}
    </div>
  );
}

type CustomerRowProps = {
  row: CustomerPharmacyReadinessRow;
  expanded: boolean;
  onToggle: () => void;
  onRequestDecision: (link: CustomerPharmacyLinkSummary, decision: LinkDecision) => void;
};

function LinkList({
  links,
  onRequestDecision,
}: {
  links: CustomerPharmacyLinkSummary[];
  onRequestDecision: (link: CustomerPharmacyLinkSummary, decision: LinkDecision) => void;
}) {
  return (
    <div className="space-y-2">
      {links.map((link) => (
                <div key={link.linkId} className="border border-slate-200 bg-white px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-semibold text-slate-900">{link.pharmacyName}</span>
                  <span className="text-slate-300">·</span>
                  <span className="text-sm text-slate-700">{link.distributorName}</span>
                  {link.distributorPharmacyCode ? (
                    <span className="text-xs font-medium text-slate-500">
                      code {link.distributorPharmacyCode}
                    </span>
                  ) : null}
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    <Badge variant={statusBadgeVariant(link.validationStatus)}>
                      {STATUS_LABELS[link.validationStatus]}
                    </Badge>
                    {link.inferredFromHistory ? (
                      <Badge variant="neutral" title="Inferred from historical marketing requests">
                        Inferred — not GPS field-validated
                      </Badge>
                    ) : null}
                    {link.validationStatus === "pending" ? (
                      <span className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="default"
                          className="px-2.5 py-1 text-xs"
                          onClick={() => onRequestDecision(link, "approve")}
                        >
                          Approve
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          className="px-2.5 py-1 text-xs"
                          onClick={() => onRequestDecision(link, "reject")}
                        >
                          Reject
                        </Button>
                      </span>
                    ) : null}
                  </span>
                </div>
                {/* A pharmacy saved on its licence alone: the banner follows the STATUS (the marker
                    stays in the notes for good), and the licence is drawn big for whoever decides. */}
                {link.licenseOnly && link.validationStatus === "pending" ? (
                  <p className="mt-2 border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs font-black leading-5 text-amber-900">
                    Licence only — no distributor code. Not usable in requests yet. Read the licence below
                    against the shop sign, then approve to release it.
                  </p>
                ) : null}
                {link.licenseOnly && link.validationStatus === "admin_approved" ? (
                  <p className="mt-2 border border-slate-300 bg-slate-50 px-2.5 py-2 text-xs font-black leading-5 text-slate-800">
                    Released on its licence — usable in requests, with no sales channel until a distributor
                    code is added.
                  </p>
                ) : null}
                {link.licenseOnly && !link.licenseUrl ? (
                  <p className="mt-2 text-xs font-bold text-rose-700">
                    No licence file could be loaded for this pharmacy.
                  </p>
                ) : null}
                {link.licenseOnly ? (
                  <PharmacyLicenseEvidence
                    contentType={link.licenseContentType}
                    label={link.pharmacyName}
                    prominent={link.validationStatus === "pending"}
                    url={link.licenseUrl}
                  />
                ) : null}
                </div>
              ))}
    </div>
  );
}

function readinessBadges(row: CustomerPharmacyReadinessRow) {
  return (
    <>
      <Badge variant={bucketBadgeVariant(row.bucket)}>{BUCKET_LABELS[row.bucket]}</Badge>
      {row.inferredLinkCount > 0 ? (
        <Badge variant="neutral" title="Contains links inferred from history, not GPS field-validated">
          Inferred
        </Badge>
      ) : null}
    </>
  );
}

function LinksToggle({
  row,
  expanded,
  onToggle,
  detailId,
}: {
  row: CustomerPharmacyReadinessRow;
  expanded: boolean;
  onToggle: () => void;
  detailId: string;
}) {
  if (row.totalLinkCount === 0) return <span className="text-xs font-medium text-slate-400">None</span>;
  return (
    <button
      type="button"
      onClick={onToggle}
      {...rowDetailToggleProps(detailId, expanded)}
      className="border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-500"
    >
      {expanded ? "Hide" : `View ${row.totalLinkCount}`}
    </button>
  );
}

function CustomerRow({ row, expanded, onToggle, onRequestDecision }: CustomerRowProps) {
  const canExpand = row.totalLinkCount > 0;
  const detailId = `mapping-links-${row.customerId}`;
  const customerLine = [row.customerCode, row.customerType ? titleCase(row.customerType) : null]
    .filter(Boolean)
    .join(" · ");
  const place = [row.areaName, row.governorateName].filter(Boolean);

  return (
    <>
      <tr className="border-b border-orange-100 align-top">
        <td className="min-w-0 break-words px-3 py-2.5">
          <span className="block font-semibold text-slate-900">{row.customerName}</span>
          {customerLine ? <span className="block text-xs text-slate-600">{customerLine}</span> : null}
        </td>
        <td className="min-w-0 break-words px-3 py-2.5 text-slate-600">
          {place.length === 0 ? "—" : place.map((part, index) => <span className="block" key={index}>{part}</span>)}
        </td>
        <td className="min-w-0 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">{readinessBadges(row)}</div>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{row.validatedLinkCount}</td>
        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{row.pendingLinkCount}</td>
        <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">{row.totalLinkCount}</td>
        <td className="px-3 py-2.5">
          <LinksToggle row={row} expanded={expanded} onToggle={onToggle} detailId={detailId} />
        </td>
      </tr>
      {expanded && canExpand ? (
        <TableRowDetail colSpan={7} id={detailId}>
          <LinkList links={row.links} onRequestDecision={onRequestDecision} />
        </TableRowDetail>
      ) : null}
    </>
  );
}

function CustomerCard({ row, expanded, onToggle, onRequestDecision }: CustomerRowProps) {
  const detailId = `mapping-links-card-${row.customerId}`;
  return (
    <CrmCard
      title={row.customerName}
      status={readinessBadges(row)}
      actions={<LinksToggle row={row} expanded={expanded} onToggle={onToggle} detailId={detailId} />}
    >
      <CrmFacts
        facts={[
          { label: "Code", value: row.customerCode ?? "—" },
          { label: "Type", value: row.customerType ? titleCase(row.customerType) : "—" },
          { label: "Area", value: row.areaName ?? "—" },
          { label: "Governorate", value: row.governorateName ?? "—" },
          { label: "Validated", value: row.validatedLinkCount },
          { label: "Pending", value: row.pendingLinkCount },
          { label: "Total", value: row.totalLinkCount },
        ]}
      />
      {expanded && row.totalLinkCount > 0 ? (
        <div className="mt-3" id={detailId}>
          <LinkList links={row.links} onRequestDecision={onRequestDecision} />
        </div>
      ) : null}
    </CrmCard>
  );
}

type LinkDecisionDialogProps = {
  target: DecisionTarget;
  onClose: () => void;
  onDecided: () => void;
};

function LinkDecisionDialog({ target, onClose, onDecided }: LinkDecisionDialogProps) {
  const [note, setNote] = useState("");
  // The reviewer's answer to "does the trade name on the licence match the shop sign?". Releasing a
  // licence-only pharmacy is impossible without it - and a name that does not match is a Reject.
  const [licenseMatches, setLicenseMatches] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const dialogRef = useDialogA11y({ open: true, onClose });

  const isApprove = target.decision === "approve";
  const releasesOnLicense = isApprove && target.licenseOnly;
  const title = releasesOnLicense
    ? "Release Pharmacy On Its Licence"
    : isApprove ? "Approve Customer Pharmacy Link" : "Reject Customer Pharmacy Link";
  const noteLabel = isApprove ? "Validation notes (optional)" : "Rejection reason (required)";
  const confirmLabel = isApprove ? "Approve link" : "Reject link";

  async function handleConfirm() {
    const trimmed = note.trim();
    if (!isApprove && trimmed.length === 0) {
      setRequestError("A rejection reason is required.");
      return;
    }
    if (releasesOnLicense && !licenseMatches) {
      setRequestError("Confirm that the trade name on the licence matches the shop sign, or reject the link.");
      return;
    }

    setSubmitting(true);
    setRequestError(null);
    try {
      const response = await fetch(
        `/api/customer-pharmacy-mapping/${encodeURIComponent(target.linkId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            isApprove
              ? {
                decision: "approve",
                notes: trimmed,
                ...(releasesOnLicense ? { licenseMatchesSign: true } : {}),
              }
              : { decision: "reject", reason: trimmed },
          ),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { message?: string; success?: boolean }
        | null;
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message || "Failed to record the decision.");
      }
      onDecided();
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Failed to record the decision.");
    } finally {
      setSubmitting(false);
    }
  }

  const modal = (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "max-h-[92vh] w-full overflow-y-auto bg-white shadow-2xl sm:rounded-none",
          target.licenseOnly ? "max-w-2xl" : "max-w-md",
        )}
      >
        <div className="flex items-center justify-between bg-slate-900 px-4 py-3">
          <h2 className="text-sm font-black uppercase tracking-wide text-white">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="text-slate-400 hover:text-white" type="button">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div className="border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <p className="font-semibold text-slate-900">{target.customerName}</p>
            <p className="text-slate-600">{target.pharmacyName}</p>
          </div>

          {/* "Admin approved", never "System validated": a person pressed this button, and the two
              labels must not share a meaning (AGENTS.md 4.1). */}
          <p className="text-sm text-slate-600">
            This link will move from <span className="font-semibold">Pending</span> to{" "}
            <span className="font-semibold">{isApprove ? "Admin approved" : "Rejected"}</span>.
            {!isApprove ? " It will not be deleted." : ""}
          </p>

          {target.licenseOnly ? (
            <div>
              <p className="border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs font-black leading-5 text-amber-900">
                Licence only — this pharmacy has no distributor code.{" "}
                {isApprove
                  ? "Approving releases it as a request target with no sales channel, until a distributor code is added."
                  : "Rejecting keeps it unusable in requests."}
              </p>
              {target.licenseUrl ? null : (
                <p className="mt-2 text-xs font-bold text-rose-700">No licence file could be loaded for this pharmacy.</p>
              )}
              <PharmacyLicenseEvidence
                contentType={target.licenseContentType}
                label={target.pharmacyName}
                prominent
                url={target.licenseUrl}
              />
            </div>
          ) : null}

          {releasesOnLicense ? (
            <CheckTile checked={licenseMatches} onChange={setLicenseMatches}>
              <span className="text-sm font-bold text-slate-800">
                I read the licence: the trade name on it matches the name on the shop sign.
              </span>
            </CheckTile>
          ) : null}

          <div>
            <label
              htmlFor="link-decision-note"
              className="mb-1 block text-phx-xs font-bold uppercase tracking-wide text-slate-600"
            >
              {noteLabel}
            </label>
            <textarea
              id="link-decision-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              className={phxTextareaClassName}
              placeholder={
                isApprove ? "Optional context for the audit trail…" : "Explain why this link is being rejected…"
              }
            />
          </div>

          {requestError ? <p className="text-sm font-medium text-rose-600">{requestError}</p> : null}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-xs font-bold text-slate-500 hover:text-slate-800 disabled:opacity-50"
            type="button"
          >
            Cancel
          </button>
          <Button
            type="button"
            variant={isApprove ? "default" : "destructive"}
            disabled={submitting || (releasesOnLicense && !licenseMatches)}
            onClick={handleConfirm}
          >
            {submitting ? "Submitting…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
