"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, Camera, MapPin, Phone, Store } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { PharmacyLicenseEvidence } from "@/components/venues/pharmacy-license-evidence";
import { ValidatedEvidenceLink } from "@/components/validation/validated-evidence-link";
import type { MarketingApproverRequestDetail } from "@/lib/marketing-requests/approver-detail";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { ListCheckTwoPhotos } from "@/components/marketing-requests/list-check-two-photos";
import { NotOnCrmListFlag } from "@/components/marketing-requests/not-on-crm-list-flag";
import { SamePharmacyCrossUseNotice } from "@/components/approvals-hub/same-pharmacy-cross-use-flag";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

/* ------------------------------------------------------------------------------------------- */
/* Formatters                                                                                    */
/* ------------------------------------------------------------------------------------------- */

function egp(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatStableEnGb(parsed, {
    day: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  });
}

function Section({
  children,
  title,
  anchorId,
}: {
  children: React.ReactNode;
  title: string;
  /** Optional in-page anchor target — the "already validated" jump lands on this section. */
  anchorId?: string;
}) {
  return (
    <div id={anchorId} className="scroll-mt-4 space-y-1.5">
      <p className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">{title}</p>
      {children}
    </div>
  );
}

/**
 * A labelled value that states absence explicitly.
 *
 * `emptyLabel` is required rather than defaulted: a missing address and an address of "-" look
 * identical to a reader, and this module exists so the approver is never guessing.
 */
function Field({
  emptyLabel,
  label,
  value,
}: {
  emptyLabel: string;
  label: string;
  value: string | null | undefined;
}) {
  const clean = typeof value === "string" ? value.trim() : "";
  return (
    <div className="flex flex-col">
      <span className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">{label}</span>
      {clean ? (
        <span className="text-phx-sm font-bold text-slate-900">{clean}</span>
      ) : (
        <span className="text-phx-sm font-medium italic text-slate-400">{emptyLabel}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Panel                                                                                         */
/* ------------------------------------------------------------------------------------------- */

/**
 * Everything about the request, on the approver's row.
 *
 * The approval inbox used to show a customer NAME, a cost and a pay date; every other thing the
 * requester submitted lived behind a decision button, so the only way to read the detail was to
 * start committing to an answer. This renders it in place.
 */
/**
 * "Does the licence trade name match the shop sign?" — the marketing half of the check.
 *
 * Only rendered when there IS a licence to judge. Three-valued and undoable: clicking the active
 * answer clears it back to "nobody was asked", which is a different fact from "no" and is stored
 * as null rather than as false.
 *
 * SAVES ON CLICK rather than travelling with the approve/reject decision, unlike the Direct Orders
 * desk. The verdict is recorded against the PHARMACY, not against this request, so it must outlive
 * a decision that may never be taken here — an approver who compares the two names and then returns
 * the request has still done the check, and that answer is worth keeping.
 *
 * It never blocks anything. A failed save says so and leaves the previous answer standing; it does
 * not disable the decision buttons, because the system flags and never rejects.
 */
function LicenseNameCheck({
  initialVerdict,
  pharmacyId,
  requestId,
}: {
  initialVerdict: boolean | null;
  pharmacyId: string | null;
  requestId: string;
}) {
  const [verdict, setVerdict] = useState<boolean | null>(initialVerdict);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // An unresolved link has no pharmacy id to write against. Nothing to offer, so nothing is shown
  // rather than a control that would 404 on every click.
  if (!pharmacyId) return null;

  async function record(next: boolean | null) {
    const previous = verdict;
    setSaveError(null);
    setIsSaving(true);
    // Optimistic: the answer is one bit and the round trip is short, so the button responds at once
    // and rolls back if the write is refused.
    setVerdict(next);
    try {
      const response = await fetch(`/api/marketing-requests/${encodeURIComponent(requestId)}/license-verdict`, {
        body: JSON.stringify({ matchesSign: next, pharmacyId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setVerdict(previous);
        setSaveError(typeof payload?.message === "string" ? payload.message : "That answer could not be saved.");
      }
    } catch {
      setVerdict(previous);
      setSaveError("That answer could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mt-1 border border-slate-200 px-2 py-1.5">
      <p className="text-phx-3xs font-bold uppercase tracking-[0.12em] text-slate-400">
        Does the licence trade name match the shop sign?
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {([
          { label: "Yes, it matches", tone: "emerald", value: true },
          { label: "No, it differs", tone: "rose", value: false },
        ] as const).map((choice) => {
          const active = verdict === choice.value;
          return (
            <button
              key={choice.label}
              type="button"
              disabled={isSaving}
              // Clicking the active choice clears it, so a mis-click is undoable in place.
              onClick={() => void record(active ? null : choice.value)}
              className={
                active
                  ? `rounded-sm border px-2 py-0.5 text-phx-2xs font-black ${
                    choice.tone === "emerald"
                      ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                      : "border-rose-400 bg-rose-50 text-rose-800"
                  }`
                  : "rounded-sm border border-slate-300 px-2 py-0.5 text-phx-2xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              }
            >
              {choice.label}
            </button>
          );
        })}
        <span className="text-phx-3xs font-medium text-slate-400">
          {isSaving ? "Saving…" : verdict === null ? "Not answered — optional" : "Recorded"}
        </span>
      </div>
      {saveError ? <p className="mt-1 text-phx-2xs font-bold text-rose-700">{saveError}</p> : null}
    </div>
  );
}

export function MarketingRequestApproverDetail({ requestId }: { requestId: string }) {
  const [detail, setDetail] = useState<MarketingApproverRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // The approver window renders in BOTH the admin shell and the employee portal, at
  // `.../marketing-requests/inbox`. The full-dossier page lives beside the inbox in whichever tree
  // the approver is in, so derive the base from the current path rather than hard-coding one shell.
  const pathname = usePathname();

  // Same shape as MarketingRequestedProductHistory, the sibling per-row fetcher: an inline async
  // IIFE guarded by `cancelled`, never a useCallback the effect then invokes — that trips
  // react-hooks/set-state-in-effect, because the lint rule sees setState reachable directly from
  // the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/marketing-requests/${encodeURIComponent(requestId)}/approver-detail`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(typeof payload?.message === "string" ? payload.message : "Could not load the request detail.");
        } else {
          setDetail(payload as MarketingApproverRequestDetail);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Could not load the request detail.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-phx-xs font-medium text-slate-500">
        <LoadingSpinner /> Loading the full request…
      </div>
    );
  }

  // Never render an empty panel that reads as "there is nothing to see".
  if (error || !detail) {
    return (
      <p className="rounded-sm border border-amber-200 bg-amber-50 px-2.5 py-2 text-phx-xs font-bold text-amber-900">
        {error ?? "Could not load the request detail."} The figures above are still accurate — this panel is not.
      </p>
    );
  }

  const history = detail.customerHistory;

  // Beside the inbox in whichever shell we are in: `/admin/marketing-requests/customer-dossier/<id>`
  // or `/employee-portals/marketing-requests/customer-dossier/<id>`. The page and its API both
  // authorize against the request, so the URL is safe to build on the client.
  const marketingBase = (() => {
    const marker = "/marketing-requests/";
    const idx = pathname.indexOf(marker);
    return idx >= 0
      ? pathname.slice(0, idx + marker.length)
      : "/employee-portals/marketing-requests/";
  })();
  const customerDossierHref = `${marketingBase}customer-dossier/${encodeURIComponent(requestId)}`;

  return (
    <div className="space-y-3.5">
      {/* The "already validated" stamp (owner, 2026-09-22): when this request stands on a customer
          the desk (or the evidence-gate) already validated, say so at the top — who validated it and
          when — and jump the approver to the customer evidence already lower on this same window. */}
      {/* Typed by hand at validation — not on a rep's Phoenix CRM list (owner, 2026-10-23). First,
          because it changes how much the rest of the customer evidence can be trusted. */}
      <NotOnCrmListFlag flag={detail.customerCrmListFlag} />
      {/* Beside the flag, never instead of a decision (owner, 2026-10-27: "you must don't block but
          flag … in the approval window, you will show the two photos"). */}
      {detail.customerListCheckPhotos ? (
        <ListCheckTwoPhotos
          customerName={detail.customerName}
          customerPhotoUrl={detail.customerListCheckPhotos.customerPhotoUrl}
          doctorName={detail.customerListCheckPhotos.doctorName}
          doctorPhotoUrl={detail.customerListCheckPhotos.doctorPhotoUrl}
          metresApart={detail.customerListCheckPhotos.metresApart}
          reason={detail.customerListCheckPhotos.reason}
        />
      ) : null}

      {detail.customerValidation ? (
        <ValidatedEvidenceLink
          badge={detail.customerValidation}
          href={customerDossierHref}
          venueNoun="customer"
        />
      ) : null}

      {detail.customer360Href ? (
        <a className="block break-words text-sm font-bold text-orange-700 hover:underline" dir="auto" href={detail.customer360Href}>
          Open {detail.customerName ?? "this customer"} in Customer 360
        </a>
      ) : null}

      {/* Same pharmacy, same person, both modules (owner, 2026-10-28): the requester also raised a
          direct order to a pharmacy this request targets — that order already carries its bonus. */}
      <SamePharmacyCrossUseNotice flag={detail.samePharmacyDirectOrders} />

      {/* ── Twin warning: the same requester, customer, type and cost already live — a possible
          double payment (twin-request.ts). Named, never decided. ─────────────────────────────── */}
      {detail.twinOf.length > 0 ? (
        <div className="border border-rose-300 bg-rose-50 px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-phx-xs font-black text-rose-900">
            <AlertTriangle className="h-3.5 w-3.5" />
            {detail.twinOf.length === 1
              ? "This looks like a second copy of an earlier request"
              : `This looks like a copy of ${detail.twinOf.length} earlier requests`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {detail.twinOf.map((twin) => (
              <li className="text-phx-xs font-medium text-rose-900" key={twin.requestCode}>
                {twin.requestCode} ({twin.statusLabel}, submitted {twin.submittedDay}) — {twin.description}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── Double-count warning first: it changes whether the rest even matters ───────────── */}
      {detail.contestedBy.length > 0 ? (
        <div className="rounded-sm border border-rose-300 bg-rose-50 px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-phx-xs font-black text-rose-900">
            <AlertTriangle className="h-3.5 w-3.5" />
            {detail.contestedBy.length === 1
              ? "Another live request would be credited the same sales"
              : `${detail.contestedBy.length} other live requests would be credited the same sales`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {detail.contestedBy.map((overlap) => (
              <li className="text-phx-xs font-medium text-rose-900" key={overlap.requestCode}>
                {overlap.requestCode} ({overlap.status}) — {overlap.description}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── Products ──────────────────────────────────────────────────────────────────────── */}
      <Section title="Products promoted">
        {detail.products.length === 0 ? (
          <p className="text-phx-xs font-medium italic text-slate-400">No products were listed on this request.</p>
        ) : (
          <div>
            <table className="w-full table-fixed text-left">
              <colgroup>
                <col className="w-[56%]" />
                <col className="w-[14%]" />
                <col className="w-[30%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="pb-1 text-phx-3xs font-bold uppercase tracking-[0.1em] text-slate-400">Product</th>
                  <th className="pb-1 text-right text-phx-3xs font-bold uppercase tracking-[0.1em] text-slate-400">Qty</th>
                  <th className="pb-1 text-right text-phx-3xs font-bold uppercase tracking-[0.1em] text-slate-400">Value</th>
                </tr>
              </thead>
              <tbody>
                {detail.products.map((product) => (
                  <tr className="border-b border-slate-100 last:border-0" key={product.name}>
                    <td className="break-words py-1 text-phx-sm font-bold text-slate-900">{product.name}</td>
                    <td className="py-1 text-right text-phx-sm font-medium text-slate-700">{product.quantity}</td>
                    <td className="py-1 text-right text-phx-sm font-bold text-slate-900">{egp(product.value) ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Money and ROI ─────────────────────────────────────────────────────────────────── */}
      <Section title="Cost and expected return">
        <div className="grid gap-2 sm:grid-cols-4">
          <Field emptyLabel="Not set" label="Estimated cost" value={egp(detail.estimatedCost)} />
          <Field emptyLabel="Not set" label="Expected return" value={egp(detail.expectedRoiValue)} />
          <Field emptyLabel="Not set" label="Required return" value={egp(detail.requiredRoiValue)} />
          <Field
            emptyLabel="Not measured yet"
            label="ROI window"
            value={detail.roiWindow ?? (detail.roiDurationMonths ? `${detail.roiDurationMonths} months` : null)}
          />
        </div>
      </Section>

      {/* ── Customer ──────────────────────────────────────────────────────────────────────── */}
      <Section title="Customer" anchorId="mkt-customer-evidence">
        <div className="grid gap-2 sm:grid-cols-3">
          <Field emptyLabel="No code" label="Code" value={detail.customerCode} />
          <Field emptyLabel="Not recorded" label="Type" value={detail.customerType} />
          <Field emptyLabel="Not recorded" label="Speciality" value={detail.customerSpeciality} />
          <Field emptyLabel="Not recorded" label="Line" value={detail.lineName} />
          <Field emptyLabel="Not recorded" label="Area" value={detail.customerArea ?? detail.areaName} />
          <Field emptyLabel="Not recorded" label="Governorate" value={detail.customerGovernorate} />
        </div>
        <div className="mt-1.5 space-y-1">
          {detail.customerAddress ? (
            <p className="flex items-start gap-1.5 text-phx-xs font-medium text-slate-700">
              <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
              {detail.customerAddress}
            </p>
          ) : (
            <p className="text-phx-xs font-medium italic text-slate-400">No captured address on file.</p>
          )}
          <p className="flex items-center gap-1.5 text-phx-xs font-medium text-slate-700">
            <Phone className="h-3 w-3 shrink-0 text-slate-400" />
            {detail.customerContactName ? (
              <>
                {detail.customerContactName}
                {detail.customerContactMobile ? ` · ${detail.customerContactMobile}` : " · no mobile on file"}
              </>
            ) : (
              <span className="italic text-slate-400">No contact person recorded.</span>
            )}
          </p>
          {/* The caveat that used to live here ("filename only, the image is not stored") was
              correct when it was written: the captured bytes were discarded in the browser and
              nothing but the name reached the server. The image is now retained in the private
              `marketing-evidence` bucket and served through a short-lived signed URL, so the photo
              is shown when one genuinely exists. A name with no image keeps the old honest wording,
              because for every customer validated before 2026-08-04 that is still the whole truth. */}
          {detail.evidencePhotoUrl ? (
            <figure className="rounded-sm border border-slate-200">
              <ZoomablePhoto
                alt={`Live capture of ${detail.customerName ?? "the customer"} premises`}
                caption={`Live capture · ${detail.customerName ?? "the customer"}`}
                className="h-56 w-full rounded-t-sm bg-slate-50 object-contain"
                src={detail.evidencePhotoUrl}
              />
              <figcaption className="flex items-center gap-1.5 border-t border-slate-200 px-2 py-1 text-phx-xs font-medium text-slate-700">
                <Camera className="h-3 w-3 shrink-0 text-slate-400" />
                Live capture on file{detail.evidencePhotoName ? `: ${detail.evidencePhotoName}` : ""}
              </figcaption>
            </figure>
          ) : (
            <p className="flex items-center gap-1.5 text-phx-xs font-medium text-slate-700">
              <Camera className="h-3 w-3 shrink-0 text-slate-400" />
              {detail.evidencePhotoName ? (
                <>
                  Live capture recorded: {detail.evidencePhotoName}
                  <span className="italic text-slate-400"> — filename only, no image was retained</span>
                </>
              ) : (
                <span className="italic text-slate-400">No live capture recorded for this customer.</span>
              )}
            </p>
          )}
        </div>
      </Section>

      {/* ── Target pharmacies ─────────────────────────────────────────────────────────────── */}
      <Section title={`Target pharmacies (${detail.targetPharmacies.length})`}>
        {detail.targetPharmacies.length === 0 ? (
          <p className="text-phx-xs font-medium italic text-slate-400">
            No target pharmacies were attached to this request.
          </p>
        ) : (
          <ul className="space-y-1">
            {detail.targetPharmacies.map((pharmacy, index) => (
              <li
                className="rounded-sm border border-slate-200 px-2 py-1"
                // Index is part of the key on purpose. buildTargetPharmacies defaults BOTH
                // pharmacyCode and distributorPharmacyCode to "-" when the lookup fails
                // (service.ts), so two unresolved pharmacies on one request would otherwise share
                // the key "---" and React would reconcile them as the same row. The list is
                // server-ordered and never reordered client-side, so the index is stable.
                key={`${pharmacy.pharmacyCode}-${pharmacy.distributorPharmacyCode}-${index}`}
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <Store className="h-3 w-3 shrink-0 text-slate-400" />
                  <span className="text-phx-sm font-bold text-slate-900">{pharmacy.pharmacyName}</span>
                  <span className="text-phx-2xs font-medium text-slate-500">
                    {pharmacy.distributorName} · {pharmacy.distributorPharmacyCode || "no distributor code"}
                  </span>
                  {pharmacy.referenceStatus !== "matched" ? (
                    <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.08em] text-amber-900">
                      {pharmacy.referenceStatus}
                    </span>
                  ) : null}
                  {/* Validated-or-not, per pharmacy (owner, 2026-09-22). The green stamp appears only
                      when the venue is in a validated state; every other state — including the
                      pending pharmacies with no photo — reads an explicit "Not validated", so the
                      approver is never left guessing at a bare name. */}
                  {pharmacy.validationBadge ? (
                    <span className="inline-flex items-center gap-1 rounded-sm border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.08em] text-emerald-800">
                      <span aria-hidden className="inline-block h-1.5 w-1.5 bg-emerald-500" />
                      Validated
                    </span>
                  ) : (
                    <span className="rounded-sm border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.08em] text-slate-600">
                      Not validated
                    </span>
                  )}
                </div>
                {/* Who validated it and when — only in the validated case, and never a fabricated
                    reviewer: the system case reads "by the system", the human case the resolved name. */}
                {pharmacy.validationBadge ? (
                  <p className="mt-0.5 text-phx-2xs font-medium text-emerald-800" dir="auto">
                    {pharmacy.validationBadge.isHuman
                      ? pharmacy.validationBadge.byName
                        ? `Validated by ${pharmacy.validationBadge.byName}`
                        : "Validated by a reviewer"
                      : "Validated by the system"}
                    {formatDate(pharmacy.validationBadge.atIso)
                      ? ` · ${formatDate(pharmacy.validationBadge.atIso)}`
                      : ""}
                    {pharmacy.validationBadge.isHuman && pharmacy.validationBadge.method
                      ? ` · ${pharmacy.validationBadge.method}`
                      : ""}
                  </p>
                ) : null}
                {/* Validated WITH this request's customer — the pairing, not the venue (owner,
                    2026-10-31). Sentence resolved on the server; amber whenever it is not a yes. */}
                <p
                  className={`mt-0.5 text-phx-2xs font-bold ${
                    pharmacy.customerLink.state === "validated" ? "text-emerald-800" : "text-amber-800"
                  }`}
                  dir="auto"
                >
                  {pharmacy.customerLink.sentence}
                </p>
                {/* The pharmacy's own retained shop front, on the same rule as the customer's. */}
                {pharmacy.evidencePhotoUrl ? (
                  <ZoomablePhoto
                    alt={`Live capture of ${pharmacy.pharmacyName}`}
                    caption={`Live capture · ${pharmacy.pharmacyName}`}
                    className="mt-1 h-36 w-full border border-slate-200 bg-slate-50 object-contain"
                    src={pharmacy.evidencePhotoUrl}
                  />
                ) : null}
                {/* The trade licence, when one was attached. Deliberately directly under the shop
                    front: the whole point of holding both is to read the name on the sign in the
                    photo and the name on the licence without leaving the row. */}
                <PharmacyLicenseEvidence
                  contentType={pharmacy.licenseContentType}
                  label={pharmacy.pharmacyName}
                  prominent
                  url={pharmacy.licenseUrl}
                />
                {/* The answer, immediately under the two documents it compares. Only offered when
                    a licence is actually on file — asking about one that is not there would record
                    a verdict about nothing, which the service refuses anyway. */}
                {pharmacy.licenseUrl ? (
                  <LicenseNameCheck
                    initialVerdict={pharmacy.licenseNameMatchesSign}
                    pharmacyId={pharmacy.pharmacyId}
                    requestId={requestId}
                  />
                ) : null}
                {/* No "and no licence either" warning is drawn here on purpose. It would have to be
                    read off `distributorPharmacyCode`, which defaults to "-" for a code that exists
                    but could not be RESOLVED (see `referenceLookup` in request-loaders.ts) — so the
                    warning would fire on a lookup failure and tell the approver a pharmacy has no
                    distributor account when it has one. The prompt is raised where the fact is
                    known for certain: on the rep's form, and on the validation desk. */}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── What this customer has already cost, and returned ─────────────────────────────── */}
      <Section title="This customer's earlier marketing">
        {!history.available ? (
          <p className="text-phx-xs font-bold text-amber-800">
            The earlier-spend history could not be loaded — treat this as unknown, not as zero.
          </p>
        ) : history.isFirstRequest ? (
          <p className="text-phx-xs font-bold text-slate-700">
            First marketing request ever raised for this customer.
          </p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field emptyLabel="Unknown" label="Earlier requests" value={String(history.entries.length)} />
              <Field emptyLabel="Unknown" label="Spent before" value={egp(history.priorSpend)} />
              <Field
                emptyLabel="Never measured"
                label="Sales returned"
                value={egp(history.priorRealisedSales)}
              />
            </div>
            <ul className="mt-1.5 space-y-1">
              {history.entries.map((entry) => (
                <li
                  className="flex flex-wrap items-baseline gap-x-2 rounded-sm border border-slate-200 px-2 py-1"
                  key={entry.requestCode}
                >
                  <span className="text-phx-xs font-black text-slate-900">{entry.requestCode}</span>
                  <span className="text-phx-xs font-medium text-slate-600">{entry.status}</span>
                  {formatDate(entry.payDate) ? (
                    <span className="text-phx-2xs font-medium text-slate-500">{formatDate(entry.payDate)}</span>
                  ) : null}
                  <span className="text-phx-xs font-bold text-slate-900">{egp(entry.estimatedCost) ?? "-"}</span>
                  <span className="text-phx-xs font-medium text-slate-600">
                    {entry.actualSalesValue === null ? (
                      <span className="italic text-slate-400">return not measured</span>
                    ) : (
                      <>returned {egp(entry.actualSalesValue)}</>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      {/* ── The requester's own words ─────────────────────────────────────────────────────── */}
      <Section title="Requester's notes">
        {detail.notes ? (
          <p className="text-phx-xs font-medium leading-snug text-slate-800">{detail.notes}</p>
        ) : (
          <p className="text-phx-xs font-medium italic text-slate-400">The requester left no notes.</p>
        )}
      </Section>
    </div>
  );
}
