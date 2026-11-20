"use client";

import { useEffect, useMemo, useState } from "react";
import { Merge, RefreshCcw } from "lucide-react";

import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-kit";
import { phxButtonPrimaryClassName } from "@/components/ui/form-tokens";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingMeta,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalPagination,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { MarketingCustomerMergePanel } from "@/components/employee-portal/marketing-customer-merge-panel";
import { LinkFieldEvidenceBadge, NotFieldValidatedBadge } from "@/components/marketing-requests/not-field-validated-badge";
import { PharmacyLicenseEvidence } from "@/components/venues/pharmacy-license-evidence";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  MarketingCustomerDatabaseRow,
  MarketingCustomerDatabaseWorkspace,
  MarketingValidationStatus,
  MarketingVenueMergeCandidate,
} from "@/lib/marketing-requests/types";
import { humanizeCode } from "@/lib/format/code-label";
import { linkStatusIsSelectable } from "@/lib/marketing-requests/code-link-reach";
import { customerFieldEvidenceGap } from "@/lib/marketing-requests/validation-report";
import { pharmacyLicenseVerdictLabel } from "@/lib/venues/pharmacy-license";
import { venueCanAttributeSales, venueTypeLabel } from "@/lib/venues/venue-type";
import { cn } from "@/lib/utils";
import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

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

/** A state in small coloured capitals — the landing kit's replacement for a filled pill. */
const STATE_TEXT_CLASS = "text-phx-xs font-bold uppercase tracking-[0.08em]";

/** The link's status in its own colour: green once usable in requests, rose rejected, amber pending. */
function statusTone(status: MarketingValidationStatus): string {
  if (linkStatusIsSelectable(status)) return "text-emerald-700";
  if (status === "rejected") return "text-rose-700";
  if (status === "pending") return "text-amber-700";
  return "text-slate-500";
}

function StatusMark({ status }: { status: MarketingValidationStatus }) {
  return <span className={cn("break-words", STATE_TEXT_CLASS, statusTone(status))}>{humanizeCode(status)}</span>;
}

function TextCell({ value }: { value: string | null | undefined }) {
  return <span className="break-words text-slate-700" dir="auto">{value || "—"}</span>;
}

/** A code in plain monospace slate — never a tinted chip. */
function CodeCell({ value }: { value: number | string | null | undefined }) {
  return (
    <span className="break-all font-mono text-phx-xs font-bold tabular-nums text-slate-600">
      {value || "-"}
    </span>
  );
}

/** "Area, Governorate" with whichever part is missing left out. */
function placeLine(...parts: Array<string | null | undefined>): string | null {
  const text = parts.filter((part) => part && part.trim()).join(", ");
  return text || null;
}

function PhotoCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-400">No photo</span>;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return (
      <a
        className={`font-bold ${LANDING_INK} underline decoration-slate-300 underline-offset-4 transition-colors hover:decoration-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`}
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
  return venueCanAttributeSales(row.venueType) ? "—" : "No distributor account";
}

function VendorCodeCell({
  row,
  value,
}: {
  row: MarketingCustomerDatabaseRow;
  value: number | string | null | undefined;
}) {
  if (!value && !venueCanAttributeSales(row.venueType)) {
    return <span className="text-phx-xs font-bold text-slate-500">No distributor account</span>;
  }
  return <CodeCell value={value} />;
}

/**
 * The licence verdict, read back long after the request that produced it closed.
 *
 * Three looks for three states, and the middle one is why this is not a plain `<TextCell>`: a
 * "Does NOT match" is a live finding about a venue that has no distributor code to identify it by,
 * sitting in a 20-column table nobody scans carefully. It is coloured like a rejection because that
 * is what it is. "Not checked yet" is deliberately grey and deliberately PRESENT — the state of
 * almost every row in this register today, and an empty cell in its place would read as a pass.
 */
function LicenseVerdictCell({ value }: { value: boolean | null }) {
  const label = pharmacyLicenseVerdictLabel(value);
  if (value === true) {
    return <span className={`${STATE_TEXT_CLASS} text-emerald-700`}>{label}</span>;
  }
  if (value === false) {
    return <span className={`${STATE_TEXT_CLASS} text-rose-700`}>{label}</span>;
  }
  return <span className={`${STATE_TEXT_CLASS} text-slate-500`}>{label}</span>;
}

function CustomerRowCard({ row }: { row: MarketingCustomerDatabaseRow }) {
  // One card = one LINK, so the gap is decided over that single link rather than over a group.
  const fieldEvidenceGap = customerFieldEvidenceGap([row]);
  return (
    <PortalRecordCard
      accent={row.validationStatus === "rejected" ? "rose" : row.validationStatus === "pending" ? "amber" : "emerald"}
      meta={
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <CodeCell value={row.customerCode} />
          <span className="capitalize">{row.customerType}</span>
          {/* Only worth a mark when it changes how the row reads — a pharmacy's vendor columns already say it. */}
          {venueCanAttributeSales(row.venueType) ? null : (
            <span className={`${STATE_TEXT_CLASS} text-amber-700`}>{venueTypeLabel(row.venueType)}</span>
          )}
        </span>
      }
      status={<StatusMark status={row.validationStatus} />}
      title={row.customerName || row.pharmacyName || "Customer row"}
    >
      {/* In the card BODY, not the `status` slot. Measured both at 375px: the status slot does NOT
          overflow (its wrapper is a block div, so `shrink-0` still resolves to fill-available and
          the inner flex wraps) — this is a readability choice, not an overflow fix. A 218px badge
          right-aligned beside the status pill crowds a phone card, and the badge belongs next to
          the fields anyway: the status pill is the LINK's, and this is what explains how it can
          say "system validated" while the customer's evidence photo column is empty. */}
      {fieldEvidenceGap ? (
        <div className="mb-2">
          <NotFieldValidatedBadge reason={fieldEvidenceGap} />
        </div>
      ) : null}
      <PortalRecordFields
        fields={[
          ...(row.customerArea ? [{ label: "Customer area", value: row.customerArea }] : []),
          ...(row.customerGovernorate ? [{ label: "Governorate", value: row.customerGovernorate }] : []),
          ...(row.pharmacyName ? [{ label: "Pharmacy", value: row.pharmacyName }] : []),
          ...(venueCanAttributeSales(row.venueType) ? [{ label: "Venue type", value: venueTypeLabel(row.venueType) }] : []),
          ...(row.pharmacyArea ? [{ label: "Venue area", value: row.pharmacyArea }] : []),
          ...(row.pharmacyGovernorate ? [{ label: "Venue governorate", value: row.pharmacyGovernorate }] : []),
          { label: "Vendor", value: vendorNameLabel(row) },
          {
            label: "Vendor code",
            value: row.vendorPharmacyCode || (venueCanAttributeSales(row.venueType) ? "—" : "None"),
          },
          // Directly under the vendor code on purpose: the licence is the identity proof a venue
          // falls back on precisely BECAUSE it has no distributor code, so the two read as one fact.
          {
            label: "Licence vs sign",
            value: <LicenseVerdictCell value={row.licenseNameMatchesSign} />,
          },
          ...(row.customerPhone ? [{ label: "Phone", value: row.customerPhone }] : []),
          ...(row.customerValidationPhoto ? [{ label: "Validation photo", value: <PhotoCell value={row.customerValidationPhoto} /> }] : []),
        ]}
      />
      {row.customerAddress || row.pharmacyAddress ? (
        <p className="mt-2 break-words text-phx-sm font-medium leading-5 text-slate-600" dir="auto">
          {row.customerAddress || row.pharmacyAddress}
        </p>
      ) : null}
      {/* The licence, BIG, for whoever opens this register (Super Admin and SFE Manager - the CEO and
          marketing read it on the request approval screens). A pharmacy saved on its licence alone
          has nothing else to identify it, so it is said in words too - and only while it is still
          waiting: the marker stays in the notes for good, the banner follows the status. */}
      {row.licenseOnly ? (
        <div className="mt-2 flex min-w-0 gap-2.5">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
          <p className="min-w-0 break-words text-phx-xs font-bold leading-5 text-amber-800">
            Licence only — no distributor code. Not usable in requests yet.
          </p>
        </div>
      ) : null}
      {row.licenseReleased ? (
        <div className="mt-2 flex min-w-0 gap-2.5">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-[#08111f]" />
          <p className="min-w-0 break-words text-phx-xs font-bold leading-5 text-slate-700">
            Released on its licence — usable in requests, with no sales channel until a distributor code is added.
          </p>
        </div>
      ) : null}
      <PharmacyLicenseEvidence
        contentType={row.licenseContentType}
        label={row.pharmacyName || "this venue"}
        prominent
        url={row.licenseUrl}
      />
    </PortalRecordCard>
  );
}

/** One count of the register: a small-capital label over a navy tabular figure, on hairlines. */
function DatabaseFigure({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 border-b border-r border-slate-200 bg-white px-3 py-2.5 sm:px-4">
      <p className="break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{label}</p>
      <p className={`mt-1 break-words text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums ${LANDING_INK}`}>
        {value}
      </p>
    </div>
  );
}

type MergeOutcome = {
  alreadyOnSurvivor: number;
  codesMoved: number;
  customerLinksMoved: number;
  duplicateCodesRetired: number;
  repointed: number;
  requestTargetsMoved: number;
  transfersMoved: number;
};

function venueOptionLabel(venue: MarketingVenueMergeCandidate): string {
  const place = venue.area || venue.governorate;
  const parts = [`${venue.displayName} (${venue.pharmacyCode})`];
  if (place) parts.push(place);
  parts.push(venueTypeLabel(venue.venueType));
  if (venue.mergedIntoPharmacyId) parts.push("already merged");
  else if (!venue.active) parts.push("inactive");
  return parts.join(" · ");
}

/**
 * Retire a duplicate venue by folding it into the one that survives.
 *
 * This screen is the only place in the module where two rows for one physical shop sit next to
 * each other, which is why the action lives here rather than on Marketing Control. Reaching this
 * page is already Super Admin / SFE Manager only — the same pair `mergeMarketingVenue` admits — so
 * the panel needs no gate of its own beyond the server's.
 *
 * The survivor and the duplicate are the caller's judgement. Nothing here guesses identity from a
 * similar name: the names are typed by hand in two languages and two different shops routinely
 * share one. The written reason is the only record of why a human decided otherwise.
 */
function MergeVenuesPanel({ onMerged }: { onMerged: () => void }) {
  const [venues, setVenues] = useState<MarketingVenueMergeCandidate[]>([]);
  const [isLoadingVenues, setIsLoadingVenues] = useState(true);
  const [survivorId, setSurvivorId] = useState("");
  const [loserId, setLoserId] = useState("");
  const [reason, setReason] = useState("");
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);

  async function loadVenues() {
    setIsLoadingVenues(true);
    try {
      const response = await fetch("/api/marketing-requests/venue-merge", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setVenues([]);
        setError(payload.message ?? "Unable to load the venue list.");
        return;
      }
      setVenues(payload.venues ?? []);
    } catch {
      setVenues([]);
      setError("Unable to load the venue list.");
    } finally {
      setIsLoadingVenues(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadVenues();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  // A merged venue on either side is refused by the service, so offering one only produces an
  // error the caller has to read. They stay in the loaded list, though, so the counter still
  // reports how many rows the module actually holds.
  const mergeable = useMemo(() => venues.filter((venue) => !venue.mergedIntoPharmacyId), [venues]);
  const survivor = useMemo(() => venues.find((venue) => venue.id === survivorId) ?? null, [survivorId, venues]);
  const loser = useMemo(() => venues.find((venue) => venue.id === loserId) ?? null, [loserId, venues]);
  const canMerge = Boolean(survivorId && loserId && survivorId !== loserId && reason.trim() && !isMerging);

  async function submitMerge() {
    if (!canMerge || !survivor || !loser) return;
    const confirmed = window.confirm(
      `Merge "${loser.displayName}" (${loser.pharmacyCode}) into "${survivor.displayName}" (${survivor.pharmacyCode})?\n\n`
      + "Every customer link, request target, distributor code and transfer moves to the survivor, "
      + "and the duplicate is deactivated. This is written to the audit log and is not undone from this screen.",
    );
    if (!confirmed) return;

    setIsMerging(true);
    setError(null);
    setOutcome(null);
    try {
      const response = await fetch("/api/marketing-requests/venue-merge", {
        body: JSON.stringify({ loserId, reason: reason.trim(), survivorId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? "Could not merge the venues.");
        return;
      }
      setOutcome({
        alreadyOnSurvivor: Number(payload.alreadyOnSurvivor ?? 0),
        codesMoved: Number(payload.codesMoved ?? 0),
        customerLinksMoved: Number(payload.customerLinksMoved ?? 0),
        duplicateCodesRetired: Number(payload.duplicateCodesRetired ?? 0),
        repointed: Number(payload.customerLinksRepointed ?? 0) + Number(payload.requestTargetsRepointed ?? 0),
        requestTargetsMoved: Number(payload.requestTargetsMoved ?? 0),
        transfersMoved: Number(payload.transfersMoved ?? 0),
      });
      setLoserId("");
      setReason("");
      await loadVenues();
      onMerged();
    } catch {
      setError("Could not merge the venues.");
    } finally {
      setIsMerging(false);
    }
  }

  return (
    <PortalSection
      actions={<LandingMeta items={[`${venues.length} venues`]} />}
      eyebrow="Customer Database"
      title="Merge duplicate venues"
    >
      <div className="@container">
        <div className="grid gap-4 px-3 py-4 sm:px-4">
          <div className="grid gap-4 @2xl:grid-cols-2">
            <FormField htmlFor="venue-merge-survivor" label="Venue that survives">
              <SearchableSelect
                className="w-full px-3"
                disabled={isLoadingVenues || isMerging}
                id="venue-merge-survivor"
                onChange={(event) => setSurvivorId(event.target.value)}
                value={survivorId}
              >
                <option value="">Search by name or code</option>
                {mergeable.map((venue) => (
                  <option key={venue.id} value={venue.id}>{venueOptionLabel(venue)}</option>
                ))}
              </SearchableSelect>
            </FormField>

            <FormField htmlFor="venue-merge-loser" label="Duplicate to retire">
              <SearchableSelect
                className="w-full px-3"
                disabled={isLoadingVenues || isMerging}
                id="venue-merge-loser"
                onChange={(event) => setLoserId(event.target.value)}
                value={loserId}
              >
                <option value="">Search by name or code</option>
                {mergeable
                  .filter((venue) => venue.id !== survivorId)
                  .map((venue) => (
                    <option key={venue.id} value={venue.id}>{venueOptionLabel(venue)}</option>
                  ))}
              </SearchableSelect>
            </FormField>
          </div>

          <FormField htmlFor="venue-merge-reason" label="Why these two are one shop">
            <Input
              disabled={isMerging}
              id="venue-merge-reason"
              onChange={(event) => setReason(event.target.value)}
              placeholder="Same shop registered twice under two codes"
              value={reason}
            />
          </FormField>

          {/* What the merge will do, read as one sentence on a navy rail — a hairline tile, never a
              tinted box. */}
          {survivor && loser ? (
            <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminChipDepthClassName}`}>
              <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-[#08111f]" />
              <p className="min-w-0 break-words text-phx-sm font-medium leading-6 text-slate-600">
                <span className={`font-bold ${LANDING_INK}`} dir="auto">{loser.displayName}</span>
                <span className="font-mono text-phx-xs font-bold text-slate-500"> ({loser.pharmacyCode})</span>
                {" is retired into "}
                <span className={`font-bold ${LANDING_INK}`} dir="auto">{survivor.displayName}</span>
                <span className="font-mono text-phx-xs font-bold text-slate-500"> ({survivor.pharmacyCode})</span>
              </p>
            </div>
          ) : null}

          {error ? (
            <div className="flex min-w-0 gap-3" role="alert">
              <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-rose-500" />
              <p className="min-w-0 break-words text-phx-sm font-semibold text-rose-800">{error}</p>
            </div>
          ) : null}

          {outcome ? (
            <div className="flex min-w-0 gap-3" role="status">
              <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-emerald-500" />
              <p className="min-w-0 break-words text-phx-sm font-semibold leading-6 text-emerald-800">
              {`Merged. Moved ${outcome.customerLinksMoved} customer link(s), ${outcome.requestTargetsMoved} request target(s), `}
              {`${outcome.codesMoved} distributor code(s) and ${outcome.transfersMoved} transfer(s); `}
              {`${outcome.alreadyOnSurvivor} were already on the survivor.`}
              {outcome.duplicateCodesRetired > 0
                ? ` Switched off ${outcome.duplicateCodesRetired} duplicate distributor code(s) the survivor already had, and moved ${outcome.repointed} link(s) and target(s) onto the survivor's copy.`
                : null}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              className={cn(phxButtonPrimaryClassName, "motion-reduce:transition-none", LANDING_FOCUS)}
              disabled={!canMerge}
              onClick={() => void submitMerge()}
              type="button"
            >
              {isMerging ? <LoadingSpinner className="h-4 w-4 text-current" /> : <Merge aria-hidden="true" className="h-4 w-4" />}
              Merge venues
            </button>
            {isLoadingVenues ? (
              <span className="inline-flex items-center gap-2 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                <LoadingSpinner className="h-3.5 w-3.5 text-slate-400" /> Loading venues...
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </PortalSection>
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
    <div className="space-y-4">
      {/* The register's four counts on hairlines inside one white sheet, Refresh in the last cell —
          never four shadowed tiles on a panel. The same component serves the admin shell, so no
          navy board here. */}
      <section className={`@container min-w-0 overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <div className="-mb-px -mr-px grid grid-cols-2 @2xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
          <DatabaseFigure label="Rows" value={workspace.summary.rows} />
          <DatabaseFigure label="Customers" value={workspace.summary.customers} />
          <DatabaseFigure label="Pharmacies" value={workspace.summary.pharmacies} />
          <DatabaseFigure label="Vendors" value={workspace.summary.vendors} />
          <div className="col-span-2 flex items-center justify-end border-b border-r border-slate-200 px-3 py-2.5 @2xl:col-span-1 sm:px-4">
            <button
              className={landingActionClassName("outline", "bg-white")}
              onClick={() => void loadWorkspace()}
              type="button"
            >
              {isLoading ? (
                <LoadingSpinner className="h-3.5 w-3.5 text-current" />
              ) : (
                <RefreshCcw aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              Refresh
            </button>
          </div>
        </div>
      </section>

      {message ? (
        <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`} role="alert">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
          <p className="min-w-0 break-words text-phx-sm font-semibold text-slate-700">{message}</p>
        </div>
      ) : null}

      <MergeVenuesPanel onMerged={() => void loadWorkspace()} />
      <MarketingCustomerMergePanel onMerged={() => void loadWorkspace()} />

      <PortalSection
        actions={<LandingMeta items={[`${workspace.rows.length} rows`]} />}
        eyebrow="Customer Database"
        title="Customer, venue, and vendor rows"
      >
        <PortalResponsiveDataList
          breakpoint="lg"
          empty={
            !isLoading ? (
              <PortalEmptyState
                message="Validated customer, venue, and vendor rows will appear here once requests are approved."
                title="No customer database rows yet"
              />
            ) : (
              <div aria-busy="true" className="px-3 py-4 text-phx-sm font-medium text-slate-500 sm:px-4">
                <span className="inline-flex items-center gap-2"><LoadingSpinner className="h-3.5 w-3.5 text-slate-400" /> Loading customer database...</span>
              </div>
            )
          }
          getKey={(row) => row.rowId}
          items={pagedRows}
          renderCard={(row) => <CustomerRowCard row={row} />}
          renderTable={() => (
            <PortalDesktopTable
              breakpoint="lg"
              cols={
                <colgroup>
                  <col className="w-[13%]" />
                  <col className="w-[13%]" />
                  <col className="w-[13%]" />
                  <col className="w-[15%]" />
                  <col className="w-[15%]" />
                  <col className="w-[8%]" />
                  <col className="w-[13%]" />
                  <col className="w-[10%]" />
                </colgroup>
              }
            >
            <thead className="text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3">Customer Area &amp; Phone</th>
                <th className="px-3 py-3">Customer Address &amp; Photo</th>
                <th className="px-3 py-3">Venue</th>
                <th className="px-3 py-3">Venue Place</th>
                <th className="px-3 py-3">Licence vs Sign</th>
                <th className="px-3 py-3">Vendor</th>
                <th className="px-3 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white text-phx-sm">
              {pagedRows.map((row: MarketingCustomerDatabaseRow) => (
                <tr className="align-top transition-colors hover:bg-slate-50 motion-reduce:transition-none" key={row.rowId}>
                  <td className="min-w-0 break-words px-3 py-3">
                    <span className={`block font-bold ${LANDING_INK}`} dir="auto">{row.customerName}</span>
                    <span className="mt-1 block text-phx-xs font-semibold capitalize text-slate-600">{row.customerType}</span>
                    <span className="mt-1 block"><CodeCell value={row.customerCode} /></span>
                  </td>
                  <td className="min-w-0 break-words px-3 py-3">
                    <span className="block"><TextCell value={placeLine(row.customerArea, row.customerGovernorate)} /></span>
                    <span className="mt-1 block"><TextCell value={row.customerPhone} /></span>
                  </td>
                  <td className="min-w-0 break-words px-3 py-3 leading-5">
                    <span className="block"><TextCell value={row.customerAddress} /></span>
                    <span className="mt-1 block"><PhotoCell value={row.customerValidationPhoto} /></span>
                  </td>
                  <td className="min-w-0 break-words px-3 py-3">
                    <span className={`block font-bold ${LANDING_INK}`} dir="auto">{row.pharmacyName}</span>
                    <span className="mt-1 block text-phx-xs font-semibold text-slate-600">{venueTypeLabel(row.venueType)}</span>
                    {row.licenseOnly ? (
                      <span className={`mt-1 block ${STATE_TEXT_CLASS} text-amber-700`}>Licence only — not usable yet</span>
                    ) : null}
                    {row.licenseReleased ? (
                      <span className={`mt-1 block ${STATE_TEXT_CLASS} text-slate-600`}>Released on licence — no sales channel</span>
                    ) : null}
                    {/* A thumbnail in a narrow column — tap it to open the full-screen zoom. */}
                    <PharmacyLicenseEvidence
                      className="h-20"
                      contentType={row.licenseContentType}
                      label={row.pharmacyName || "this venue"}
                      url={row.licenseUrl}
                    />
                  </td>
                  <td className="min-w-0 break-words px-3 py-3 leading-5">
                    <span className="block"><TextCell value={placeLine(row.pharmacyArea, row.pharmacyGovernorate)} /></span>
                    <span className="mt-1 block"><TextCell value={row.pharmacyAddress} /></span>
                  </td>
                  <td className="min-w-0 break-words px-3 py-3"><LicenseVerdictCell value={row.licenseNameMatchesSign} /></td>
                  <td className="min-w-0 break-words px-3 py-3">
                    <span className={`block font-bold ${LANDING_INK}`} dir="auto">{vendorNameLabel(row)}</span>
                    <span className="mt-1 block"><VendorCodeCell row={row} value={row.vendorPharmacyCode} /></span>
                  </td>
                  <td className="min-w-0 break-words px-3 py-3">
                    <span className="inline-flex flex-col items-start gap-1.5">
                      <StatusMark status={row.validationStatus} />
                      <LinkFieldEvidenceBadge link={row} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            </PortalDesktopTable>
          )}
        />
        <PortalPagination label={pageLabel}>
          <button
            className={landingActionClassName("outline", "disabled:opacity-40")}
            disabled={safePage <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            type="button"
          >
            Previous
          </button>
          <button
            className={landingActionClassName("outline", "disabled:opacity-40")}
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
