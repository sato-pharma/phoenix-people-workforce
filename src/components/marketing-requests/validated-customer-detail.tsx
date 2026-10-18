"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Info,
  MapPin,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  PortalEmptyState,
  PortalMetricCard,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { cairoDateTime } from "@/components/marketing-requests/validated-customer-register";
import type {
  ValidatedCustomerCompletenessItem,
  ValidatedCustomerDetail as Detail,
} from "@/lib/marketing-requests/validated-customer-transfer";

const REGISTER_HREF = "/admin/marketing-requests/validated-customers";

function severityBadge(severity: ValidatedCustomerCompletenessItem["severity"]) {
  if (severity === "ok") return <Badge variant="success">Complete</Badge>;
  if (severity === "warning") return <Badge variant="warning">Missing</Badge>;
  return <Badge variant="danger">Needed</Badge>;
}

function SeverityIcon({ severity }: { severity: ValidatedCustomerCompletenessItem["severity"] }) {
  if (severity === "ok") return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />;
  if (severity === "warning") return <AlertTriangle className="h-4 w-4 shrink-0 text-orange-600" />;
  return <XCircle className="h-4 w-4 shrink-0 text-rose-600" />;
}

/**
 * The whole record on one page — "all details in it. His brick, his area, the location, the photo,
 * evidence, everything" (owner, 2026-08-22) — and the two buttons that move it.
 *
 * The completeness panel INFORMS; it never blocks. The owner was explicit: the transfer is a
 * manual admin decision, the only gate is a confirmation, and a revert has to exist for when he
 * spots something afterwards. So a red row here changes what the dialog SAYS, not whether the
 * button works.
 */
export function ValidatedCustomerDetailView({
  customerId,
  endpoint,
  backHref = REGISTER_HREF,
  backLabel = "Back to validated customers",
}: {
  customerId: string;
  /**
   * Where to FETCH the dossier. Defaults to the Super-Admin register API keyed by customer id. The
   * marketing approver dossier passes its own request-keyed endpoint, which is gated to the
   * approver holding the request rather than to the register.
   */
  endpoint?: string;
  /** Where the "back" link points, and its label. Default: back to the validated-customers register. */
  backHref?: string;
  backLabel?: string;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"transfer" | "revert" | null>(null);
  const [revertReason, setRevertReason] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    setMessage(null);
    try {
      const response = await fetch(
        endpoint ?? `/api/marketing-requests/validated-customers/${customerId}`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok) {
        setDetail(null);
        setMessage(payload.message ?? "Unable to load that customer.");
        return;
      }
      setDetail(payload as Detail);
    } catch {
      setDetail(null);
      setMessage("Unable to load that customer.");
    } finally {
      setIsLoading(false);
    }
  }, [customerId, endpoint]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function runTransfer() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/marketing-requests/validated-customers/${customerId}/transfer`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setMessage(payload.message ?? "Could not transfer that customer.");
        return;
      }
      setMessage(
        `Transferred. It is now on the Direct Order validation desk as ${payload.phoenixPharmacyCode}.`,
      );
      await load();
    } catch {
      setMessage("Could not transfer that customer.");
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  async function runRevert(transferId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/marketing-requests/validated-customers/transfers/${transferId}/revert`,
        {
          body: JSON.stringify({ reason: revertReason.trim() || null }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setMessage(payload.message ?? "Could not revert that transfer.");
        return;
      }
      setMessage("Transfer reverted. The customer is back to not-transferred.");
      setRevertReason("");
      await load();
    } catch {
      setMessage("Could not revert that transfer.");
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    );
  }

  if (!detail) {
    return (
      <PortalSection>
        <PortalEmptyState
          action={
            <Link
              className="inline-flex items-center gap-1.5 rounded border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700"
              href={backHref}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {backLabel}
            </Link>
          }
          message={message ?? "That customer could not be loaded."}
          title="Not available"
        />
      </PortalSection>
    );
  }

  const { completeness, contacts, customer, geography, pharmacies, transfer, viewerCanTransfer } = detail;
  // The SFE Manager opens this page VIEW ONLY (owner, 2026-09-21): no transfer, no revert. The
  // service refuses both for him anyway; hiding them here keeps a button he cannot use off his screen.
  const canTransfer = viewerCanTransfer && (!transfer || transfer.status === "reverted");
  const canRevert = viewerCanTransfer && transfer?.status === "transferred" && transfer.canRevert;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 transition hover:border-orange-200 hover:text-orange-700"
          href={backHref}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {backLabel}
        </Link>
        <div className="flex flex-wrap gap-2">
          {canTransfer ? (
            <button
              className="inline-flex items-center gap-2 rounded border border-orange-300 bg-orange-600 px-4 py-2 text-sm font-black text-white shadow-sm transition hover:bg-orange-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => setConfirming("transfer")}
              type="button"
            >
              <Send className="h-4 w-4" />
              Transfer to Direct Orders
            </button>
          ) : null}
          {canRevert ? (
            <button
              className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-4 py-2 text-sm font-black text-slate-700 transition hover:border-rose-300 hover:text-rose-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => setConfirming("revert")}
              type="button"
            >
              <RotateCcw className="h-4 w-4" />
              Revert transfer
            </button>
          ) : null}
        </div>
      </div>

      {message ? (
        <div className="rounded border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-semibold text-sky-900">
          {message}
        </div>
      ) : null}

      {/* ── Confirmation. The owner's one required gate: "after he press transfer, you ask him,
          are you sure you want to transfer this customer for direct order?" ── */}
      {confirming === "transfer" ? (
        <div className="rounded border border-orange-300 bg-orange-50 px-4 py-4">
          <p className="text-sm font-black text-orange-900">
            Are you sure you want to transfer {customer.displayName || "this customer"} to Direct Orders?
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-orange-800">
            It will appear on the Direct Order validation desk with everything already captured — the
            photo, the GPS fix, the address and the codes. The rep does not capture anything again.
            {completeness.blockers > 0
              ? ` ${completeness.blockers} item${completeness.blockers === 1 ? " is" : "s are"} still outstanding below; you can transfer anyway.`
              : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="inline-flex items-center gap-2 rounded border border-orange-300 bg-orange-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void runTransfer()}
              type="button"
            >
              {busy ? <LoadingSpinner /> : <Send className="h-4 w-4" />}
              Yes, transfer it
            </button>
            <button
              className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-black text-slate-700"
              disabled={busy}
              onClick={() => setConfirming(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {confirming === "revert" && transfer ? (
        <div className="rounded border border-rose-300 bg-rose-50 px-4 py-4">
          <p className="text-sm font-black text-rose-900">Revert this transfer?</p>
          <p className="mt-1 text-sm font-medium leading-6 text-rose-800">
            The Direct Order desk will stop seeing it, and the customer goes back to not-transferred.
            Nothing is deleted — the record of this transfer and the revert both stay on file.
          </p>
          <label className="mt-3 block">
            <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-rose-700">
              Reason (optional)
            </span>
            <input
              className={portalInputClassName}
              onChange={(event) => setRevertReason(event.target.value)}
              placeholder="What did you notice?"
              value={revertReason}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="inline-flex items-center gap-2 rounded border border-rose-300 bg-rose-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void runRevert(transfer.id)}
              type="button"
            >
              {busy ? <LoadingSpinner /> : <RotateCcw className="h-4 w-4" />}
              Yes, revert it
            </button>
            <button
              className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-black text-slate-700"
              disabled={busy}
              onClick={() => setConfirming(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Transfer state ── */}
      {transfer ? (
        <PortalSection eyebrow="Direct Orders" title="Transfer state">
          <div className="p-4 sm:p-5">
            <PortalRecordFields
              fields={[
                {
                  label: "State",
                  value:
                    transfer.status === "reverted"
                      ? "Reverted"
                      : transfer.directOrderValidationStatus === "pending" || !transfer.directOrderValidationStatus
                        ? "Waiting on the Direct Order desk"
                        : `Decided there: ${transfer.directOrderValidationStatus.replace(/_/g, " ")}`,
                },
                { label: "Transferred by", value: transfer.transferredByName || transfer.transferredByHrId },
                { label: "Transferred at", value: cairoDateTime(transfer.transferredAt) },
                { label: "Phoenix code", value: transfer.phoenixPharmacyCode || "Not assigned" },
                { label: "Reverted at", value: transfer.revertedAt ? cairoDateTime(transfer.revertedAt) : "Not reverted" },
                { label: "Revert reason", value: transfer.revertReason || "Not recorded" },
              ]}
            />
            {transfer.cannotRevertReason ? (
              <p className="mt-3 flex items-start gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold leading-5 text-slate-600">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {transfer.cannotRevertReason}
              </p>
            ) : null}
          </div>
        </PortalSection>
      ) : null}

      {/* ── Completeness ── */}
      <PortalSection
        description="What the automatic validation did NOT check. Marketing grants system_validated on evidence alone — a GPS fix and a timestamped photo — so everything else is here."
        eyebrow="Data check"
        title="Is this record full?"
      >
        <div className="grid gap-3 p-4 sm:grid-cols-3 sm:p-5">
          <PortalMetricCard
            accent={completeness.blockers > 0 ? "rose" : "emerald"}
            label="Needed"
            value={completeness.blockers}
          />
          <PortalMetricCard
            accent={completeness.warnings > 0 ? "amber" : "emerald"}
            label="Missing"
            value={completeness.warnings}
          />
          <PortalMetricCard
            accent={completeness.isComplete ? "emerald" : "slate"}
            label="Overall"
            value={completeness.isComplete ? "Full" : "Has gaps"}
          />
        </div>
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {completeness.items.map((item) => (
            <li className="flex items-start gap-3 px-4 py-3 sm:px-5" key={item.key}>
              <SeverityIcon severity={item.severity} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-black text-slate-900">{item.label}</span>
                  {severityBadge(item.severity)}
                </div>
                <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-600">
                  {item.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </PortalSection>

      {/* ── Identity ── */}
      <PortalSection eyebrow="Customer" title={customer.displayName || "Unnamed customer"}>
        <div className="p-4 sm:p-5">
          <PortalRecordFields
            fields={[
              { label: "Code", value: customer.customerCode || "Not recorded" },
              { label: "Type", value: customer.customerType || "Not recorded" },
              { label: "Validation", value: customer.validationStatus.replace(/_/g, " ") },
              { label: "Evidence", value: customer.evidenceStatus || "missing" },
              { label: "Validated by", value: customer.ownerName || "Not recorded" },
              { label: "Manager", value: customer.managerName || "Not recorded" },
              { label: "Captured at", value: cairoDateTime(customer.capturedAt) },
              { label: "Created at", value: cairoDateTime(customer.createdAt) },
              { label: "Line", value: customer.lineName || "Not recorded" },
              { label: "Marketing area", value: customer.areaName || "Not recorded" },
              { label: "Governorate", value: customer.governorate || "Not recorded" },
              { label: "Region", value: customer.regionName || "Not recorded" },
            ]}
          />
          {customer.validationNotes ? (
            <p className="mt-3 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-semibold leading-5 text-slate-600">
              {customer.validationNotes}
            </p>
          ) : null}
        </div>
      </PortalSection>

      {/* ── Location and geography ── */}
      <PortalSection eyebrow="Where" title="Location, area and brick">
        <div className="p-4 sm:p-5">
          <PortalRecordFields
            fields={[
              { label: "Address", value: customer.capturedAddress || "Not captured" },
              {
                label: "GPS",
                value:
                  customer.capturedLatitude !== null && customer.capturedLongitude !== null
                    ? `${customer.capturedLatitude}, ${customer.capturedLongitude}`
                    : "Not captured",
              },
              {
                label: "Accuracy",
                value:
                  customer.capturedAccuracyMeters !== null
                    ? `About ${Math.round(customer.capturedAccuracyMeters)} m`
                    : "Not recorded",
              },
              {
                label: "Direct Order area",
                value: geography.resolvedAreaCode || "Does not map",
              },
              { label: "Region code", value: geography.resolvedRegionCode || "Not resolved" },
              {
                label: "Brick",
                value: geography.suggestedBrickId
                  ? `${geography.suggestedBrickName ?? geography.suggestedBrickId}${
                      geography.brickIsFromMaster ? "" : " (suggested)"
                    }`
                  : "Not resolved",
              },
            ]}
          />
          <p className="mt-3 flex items-start gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold leading-5 text-slate-600">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {geography.resolvedFrom === "master_code"
              ? "Area and brick come from the Phoenix master database, matched on this pharmacy's distributor code. This is the same source the Direct Order catalogue uses."
              : geography.resolvedFrom === "photo_pin"
                ? "Area and brick come from where the live evidence photo's GPS pin falls — the photo is the primary source of trust, so this can differ from the customer's marketing area and from what the distributor code's master record names."
                : geography.resolvedFrom === "marketing_area"
                ? `Area comes from the customer's marketing area (${geography.marketingAreaName ?? "unknown"}). The distributor code did not match the master database, so the brick below is a nearest-centroid guess, not an authority.`
                : `The marketing area "${geography.marketingAreaName ?? "unknown"}" does not exist in the Direct Order area list. A transfer will carry no area, and the Direct Order desk will not know whose territory this is.`}
          </p>
          {geography.suggestedBrickDistanceKm !== null ? (
            <p className="mt-2 text-xs font-bold text-slate-500">
              Nearest brick centroid is {geography.suggestedBrickDistanceKm} km from the captured pin.
            </p>
          ) : null}
        </div>
      </PortalSection>

      {/* ── Evidence photo ── */}
      <PortalSection eyebrow="Evidence" title="Storefront photo">
        <div className="p-4 sm:p-5">
          {detail.photoUrl ? (
            <div className="max-w-md">
              <ZoomablePhoto
                alt={`Live capture for ${customer.displayName ?? "this customer"}`}
                caption={`Captured ${cairoDateTime(customer.evidencePhotoCapturedAt ?? customer.capturedAt)} — Cairo time`}
                src={detail.photoUrl}
              />
            </div>
          ) : (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-900">
              No retrievable photo for this customer. Desk-entered customers never have one, so this
              is not necessarily wrong — but there is no image to check.
            </p>
          )}
        </div>
      </PortalSection>

      {/* ── Contacts ── */}
      <PortalSection eyebrow="Who" title="Contacts">
        {contacts.length === 0 ? (
          <PortalEmptyState
            message="No contact was captured against this customer."
            title="No contacts"
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {contacts.map((contact) => (
              <li className="px-4 py-3 sm:px-5" key={contact.id}>
                <PortalRecordFields
                  fields={[
                    { label: "Name", value: contact.contactName || "Not recorded" },
                    { label: "Specialty", value: contact.specialty || "Not recorded" },
                    { label: "Mobile", value: contact.mobileNumber || "Not recorded" },
                    { label: "CRM code", value: contact.crmCode || "Not recorded" },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </PortalSection>

      {/* ── Pharmacies ── */}
      <PortalSection
        description="Direct Orders validates a PHARMACY. This is what would be sent across."
        eyebrow="What gets sent"
        title="Linked pharmacies"
      >
        {pharmacies.length === 0 ? (
          <PortalEmptyState
            message="No pharmacy is linked to this customer, so there is nothing to transfer."
            title="No pharmacy"
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {pharmacies.map((pharmacy) => (
              <li className="px-4 py-4 sm:px-5" key={pharmacy.id}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-black text-slate-900">
                    {pharmacy.displayName || "Unnamed pharmacy"}
                  </span>
                  <Badge
                    variant={
                      pharmacy.referenceStatus === "matched" || pharmacy.referenceStatus === "manual_approved"
                        ? "success"
                        : "warning"
                    }
                  >
                    {pharmacy.referenceStatus === "matched"
                      ? "Code matched"
                      : pharmacy.referenceStatus === "manual_approved"
                        ? "Manually approved"
                        : "Code not in master"}
                  </Badge>
                </div>
                <PortalRecordFields
                  fields={[
                    { label: "Distributor", value: pharmacy.distributorName || "Not recorded" },
                    { label: "Distributor code", value: pharmacy.distributorCode || "Not resolved" },
                    { label: "Customer code", value: pharmacy.distributorCustomerCode || "Not resolved" },
                    { label: "Address", value: pharmacy.capturedAddress || "Not captured" },
                    { label: "Evidence", value: pharmacy.evidenceStatus || "missing" },
                    { label: "Validation", value: (pharmacy.validationStatus || "pending").replace(/_/g, " ") },
                  ]}
                />
                {pharmacy.photoUrl ? (
                  <div className="mt-3 max-w-xs">
                    <ZoomablePhoto
                      alt={`Live capture for ${pharmacy.displayName ?? "this pharmacy"}`}
                      caption="Pharmacy storefront"
                      src={pharmacy.photoUrl}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PortalSection>
    </div>
  );
}
