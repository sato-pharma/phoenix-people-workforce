"use client";

import { useEffect, useMemo, useState } from "react";
import { Merge, RefreshCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { LinkFieldEvidenceBadge, NotFieldValidatedBadge } from "@/components/marketing-requests/not-field-validated-badge";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  MarketingCustomerDatabaseRow,
  MarketingCustomerDatabaseWorkspace,
  MarketingValidationStatus,
  MarketingVenueMergeCandidate,
} from "@/lib/marketing-requests/types";
import { customerFieldEvidenceGap } from "@/lib/marketing-requests/validation-report";
import { pharmacyLicenseVerdictLabel } from "@/lib/venues/pharmacy-license";
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
    return <span className="whitespace-nowrap text-xs font-black text-emerald-700">{label}</span>;
  }
  if (value === false) {
    return <span className="whitespace-nowrap text-xs font-black text-rose-700">{label}</span>;
  }
  return <span className="whitespace-nowrap text-xs font-bold text-slate-400">{label}</span>;
}

function CustomerRowCard({ row }: { row: MarketingCustomerDatabaseRow }) {
  // One card = one LINK, so the gap is decided over that single link rather than over a group.
  const fieldEvidenceGap = customerFieldEvidenceGap([row]);
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
          { label: "Customer area", value: row.customerArea || "Not captured" },
          { label: "Governorate", value: row.customerGovernorate || "Not captured" },
          { label: "Pharmacy", value: row.pharmacyName || "Not captured" },
          { label: "Vendor", value: vendorNameLabel(row) },
          {
            label: "Vendor code",
            value: row.vendorPharmacyCode || (venueCanAttributeSales(row.venueType) ? "-" : "None"),
          },
          // Directly under the vendor code on purpose: the licence is the identity proof a venue
          // falls back on precisely BECAUSE it has no distributor code, so the two read as one fact.
          {
            label: "Licence vs sign",
            value: <LicenseVerdictCell value={row.licenseNameMatchesSign} />,
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

type MergeOutcome = {
  alreadyOnSurvivor: number;
  codesMoved: number;
  customerLinksMoved: number;
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
      actions={<Badge variant="neutral">{venues.length} venues</Badge>}
      description="Fold a duplicate shop into the row that survives. Every customer link, request target, distributor code and transfer moves across, the duplicate is deactivated, and the merge is written to the audit log."
      eyebrow="Customer Database"
      title="Merge duplicate venues"
    >
      <div className="grid gap-4 p-4 sm:p-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-1.5">
            <label
              className="text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500"
              htmlFor="venue-merge-survivor"
            >
              Venue that survives
            </label>
            <SearchableSelect
              className="h-10 w-full rounded border border-slate-200 bg-white px-3 text-sm font-bold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
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
          </div>

          <div className="grid gap-1.5">
            <label
              className="text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500"
              htmlFor="venue-merge-loser"
            >
              Duplicate to retire
            </label>
            <SearchableSelect
              className="h-10 w-full rounded border border-slate-200 bg-white px-3 text-sm font-bold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
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
          </div>
        </div>

        <div className="grid gap-1.5">
          <label
            className="text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500"
            htmlFor="venue-merge-reason"
          >
            Why these two are one shop
          </label>
          <Input
            className="h-10 border-slate-200 bg-white font-bold"
            disabled={isMerging}
            id="venue-merge-reason"
            onChange={(event) => setReason(event.target.value)}
            placeholder="Same shop registered twice under two codes"
            value={reason}
          />
        </div>

        {survivor && loser ? (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold leading-6 text-slate-700">
            <span className="font-black text-slate-950">{loser.displayName}</span>
            <span className="font-mono text-xs font-black text-slate-600"> ({loser.pharmacyCode})</span>
            {" is retired into "}
            <span className="font-black text-slate-950">{survivor.displayName}</span>
            <span className="font-mono text-xs font-black text-slate-600"> ({survivor.pharmacyCode})</span>
          </div>
        ) : null}

        {error ? (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-900">
            {error}
          </div>
        ) : null}

        {outcome ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold leading-6 text-emerald-900">
            {`Merged. Moved ${outcome.customerLinksMoved} customer link(s), ${outcome.requestTargetsMoved} request target(s), `}
            {`${outcome.codesMoved} distributor code(s) and ${outcome.transfersMoved} transfer(s); `}
            {`${outcome.alreadyOnSurvivor} were already on the survivor.`}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="gap-2 rounded bg-orange-600 px-3 font-black hover:bg-orange-700"
            disabled={!canMerge}
            onClick={() => void submitMerge()}
            type="button"
          >
            {isMerging ? <LoadingSpinner /> : <Merge className="h-4 w-4" />}
            Merge venues
          </Button>
          {isLoadingVenues ? (
            <span className="inline-flex items-center gap-2 text-xs font-bold text-slate-500">
              <LoadingSpinner /> Loading venues...
            </span>
          ) : null}
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

      <MergeVenuesPanel onMerged={() => void loadWorkspace()} />

      <PortalSection
        actions={<Badge variant="neutral">{workspace.rows.length} rows</Badge>}
        eyebrow="Customer Database"
        title="Customer, venue, and vendor rows"
      >
        <PortalResponsiveDataList
          empty={
            !isLoading ? (
              <PortalEmptyState
                message="Validated customer, venue, and vendor rows will appear here once requests are approved."
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
            <PortalDesktopTable minWidth="1800px">
            <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Customer Type</th>
                <th className="px-4 py-3">Customer ID</th>
                <th className="px-4 py-3">Customer Name</th>
                <th className="px-4 py-3">Customer Area</th>
                <th className="px-4 py-3">Customer Governorate</th>
                <th className="px-4 py-3">Customer Phone</th>
                <th className="px-4 py-3">Customer Address</th>
                <th className="px-4 py-3">Customer Validation Photo</th>
                <th className="px-4 py-3">Venue ID</th>
                <th className="px-4 py-3">Venue Name</th>
                <th className="px-4 py-3">Venue Area</th>
                <th className="px-4 py-3">Venue Governorate</th>
                <th className="px-4 py-3">Venue Address</th>
                <th className="px-4 py-3">Venue Type</th>
                <th className="px-4 py-3">Licence vs Sign</th>
                <th className="px-4 py-3">Vendor ID</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Vendor Venue Code</th>
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
                  <td className="px-4 py-3"><LicenseVerdictCell value={row.licenseNameMatchesSign} /></td>
                  <td className="px-4 py-3"><VendorCodeCell row={row} value={row.distributorCode || row.distributorId} /></td>
                  <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-800">{vendorNameLabel(row)}</td>
                  <td className="px-4 py-3"><VendorCodeCell row={row} value={row.vendorPharmacyCode} /></td>
                  <td className="px-4 py-3"><VendorCodeCell row={row} value={row.pharmacyDistributorCodeId} /></td>
                  <td className="px-4 py-3">
                    <span className="inline-flex flex-col items-start gap-1">
                      <Badge variant={statusVariant(row.validationStatus)}>{row.validationStatus.replace(/_/g, " ")}</Badge>
                      {/* Stacked, not inline: this column already sits at the far right of a wide table. */}
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
