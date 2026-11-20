"use client";

import { useEffect, useMemo, useState } from "react";
import { Merge } from "lucide-react";

import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingMeta,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import { PortalSection } from "@/components/employee-portal/portal-primitives";
import { CheckTile, FormError, FormField, FormGrid } from "@/components/ui/form-kit";
import { phxButtonPrimaryClassName } from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { humanizeCode } from "@/lib/format/code-label";
import { cn } from "@/lib/utils";
import {
  customerMergeRefusal,
  evidenceCanCarry,
  sameNameGroups,
  type MarketingCustomerMergeOption,
} from "@/lib/marketing-requests/customer-merge-rules";

/**
 * Fold a duplicate marketing customer into the one that stays (owner, 2026-11-03). A person's press only:
 * the same-name pairs are offered to CHECK and are never called duplicates, and any two rows can be picked,
 * because a name scan misses an Arabic and a Latin spelling of one doctor. The Customer Database also admits
 * the SFE Manager, so this panel renders nothing when the server answers 403.
 */

type Outcome = {
  contactsMoved: number;
  evidenceCarried: boolean;
  linksLeftOnRetired: number;
  linksMoved: number;
  linksStatusCarried: number;
  requestsMoved: number;
  transfersMoved: number;
  validationCarried: string | null;
  venuesMoved: number;
};

function optionLabel(customer: MarketingCustomerMergeOption): string {
  return `${customer.name} · ${customer.code} · ${customer.areaName ?? "no area"}`;
}

/**
 * One side of the comparison: a column of the hairline pair, never a card on the panel. The heading
 * carries the side's tone in coloured small capitals — emerald for the row that stays, rose for the
 * one that is retired.
 */
function Side({
  customer,
  heading,
  tone,
}: {
  customer: MarketingCustomerMergeOption;
  heading: string;
  tone: "text-emerald-700" | "text-rose-700";
}) {
  const facts: Array<[string, string]> = [
    ["Code", customer.code],
    ["Kind", humanizeCode(customer.customerType)],
    ["Line", customer.lineName ?? "None"],
    ["Area", customer.areaName ?? "None"],
    ["Owner", customer.ownerName ?? "None"],
    ["Evidence", humanizeCode(customer.evidenceStatus)],
    ["Validation", humanizeCode(customer.validationStatus)],
    ["Requests", String(customer.requests)],
    ["Contacts", String(customer.contacts)],
    ["Pharmacy links", String(customer.links)],
    ["Live transfer", customer.liveTransfer ? "Yes" : "No"],
  ];
  return (
    <div className="min-w-0 bg-white px-3 py-3 sm:px-4">
      <p className={`text-phx-xs font-bold uppercase tracking-[0.1em] ${tone}`}>{heading}</p>
      <p className={`mt-1 break-words text-phx-md font-bold ${LANDING_INK}`} dir="auto">{customer.name}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-phx-xs">
        {facts.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="font-bold uppercase tracking-[0.08em] text-slate-500">{label}</dt>
            <dd className={`min-w-0 break-words font-semibold tabular-nums ${LANDING_INK}`} dir="auto">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function MarketingCustomerMergePanel({ onMerged }: { onMerged: () => void }) {
  const [customers, setCustomers] = useState<MarketingCustomerMergeOption[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [survivorId, setSurvivorId] = useState("");
  const [retiredId, setRetiredId] = useState("");
  const [reason, setReason] = useState("");
  const [carryEvidence, setCarryEvidence] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function load() {
    try {
      const response = await fetch("/api/marketing-requests/customer-merge", { cache: "no-store" });
      if (response.status === 403) {
        setHidden(true);
        return;
      }
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? "Could not load the customer list.");
        return;
      }
      setCustomers(payload.customers ?? []);
    } catch {
      setError("Could not load the customer list.");
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const groups = useMemo(() => sameNameGroups(customers ?? []), [customers]);
  const survivor = customers?.find((row) => row.id === survivorId) ?? null;
  const retired = customers?.find((row) => row.id === retiredId) ?? null;
  const refusal = survivor && retired ? customerMergeRefusal(survivor, retired) : null;
  const canCarry = survivor && retired ? evidenceCanCarry(survivor, retired) : false;
  const canMerge = Boolean(survivor && retired && !refusal && reason.trim() && !isMerging);

  function pick(nextSurvivor: string, nextRetired: string) {
    setSurvivorId(nextSurvivor);
    setRetiredId(nextRetired);
    setCarryEvidence(false);
    setOutcome(null);
    setError(null);
  }

  async function submit() {
    if (!canMerge || !survivor || !retired) return;
    const confirmed = window.confirm(
      `Merge "${retired.name}" (${retired.code}) into "${survivor.name}" (${survivor.code})?\n\n`
      + `${retired.requests} request(s), ${retired.contacts} contact(s) and ${retired.links} pharmacy link(s) move to the customer that stays, `
      + "and the retired row is deactivated. This is written to the audit log and is not undone from this screen.",
    );
    if (!confirmed) return;
    setIsMerging(true);
    setError(null);
    setOutcome(null);
    try {
      const response = await fetch("/api/marketing-requests/customer-merge", {
        body: JSON.stringify({ carryEvidence: canCarry && carryEvidence, reason: reason.trim(), retiredId, survivorId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? "Could not merge the customers.");
        return;
      }
      setReason("");
      pick("", "");
      setOutcome(payload);
      await load();
      onMerged();
    } catch {
      setError("Could not merge the customers.");
    } finally {
      setIsMerging(false);
    }
  }

  if (hidden) return null;

  return (
    <PortalSection
      actions={customers ? <LandingMeta items={[`${customers.length} customers`]} /> : null}
      eyebrow="Customer Database"
      title="Merge duplicate customers"
    >
      <div className="@container grid gap-4 px-3 py-4 sm:px-4">
        {groups.length > 0 ? (
          <div className="grid gap-2">
            <p className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">Same name, check</p>
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <button
                  className={landingActionClassName("outline", "h-auto max-w-full whitespace-normal break-words py-1 text-left normal-case tracking-normal")}
                  dir="auto"
                  disabled={isMerging}
                  key={group[0].id}
                  onClick={() => pick(group[0].id, group[1].id)}
                  type="button"
                >
                  {`${group[0].name} (${group.length})`}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <FormGrid>
          <FormField htmlFor="customer-merge-survivor" label="Customer that stays" required>
            <SearchableSelect
              className="w-full px-3"
              disabled={!customers || isMerging}
              id="customer-merge-survivor"
              onChange={(event) => pick(event.target.value, retiredId)}
              value={survivorId}
            >
              <option value="">Search by name or code</option>
              {(customers ?? []).map((row) => (
                <option key={row.id} value={row.id}>{optionLabel(row)}</option>
              ))}
            </SearchableSelect>
          </FormField>
          <FormField htmlFor="customer-merge-retired" label="Customer to retire" required>
            <SearchableSelect
              className="w-full px-3"
              disabled={!customers || isMerging}
              id="customer-merge-retired"
              onChange={(event) => pick(survivorId, event.target.value)}
              value={retiredId}
            >
              <option value="">Search by name or code</option>
              {(customers ?? [])
                .filter((row) => row.id !== survivorId)
                .map((row) => (
                  <option key={row.id} value={row.id}>{optionLabel(row)}</option>
                ))}
            </SearchableSelect>
          </FormField>
        </FormGrid>

        {survivor && retired ? (
          <div className="grid divide-y divide-slate-200 border border-slate-200 @2xl:grid-cols-2 @2xl:divide-x @2xl:divide-y-0">
            <Side customer={survivor} heading="Stays" tone="text-emerald-700" />
            <Side customer={retired} heading="Retired" tone="text-rose-700" />
          </div>
        ) : null}

        {refusal ? <FormError>{refusal}</FormError> : null}

        {canCarry && !refusal ? (
          <CheckTile checked={carryEvidence} onChange={setCarryEvidence}>
            Carry the retired row&apos;s field evidence. Tick this only if its photo and location are the same place as the
            customer that stays.
          </CheckTile>
        ) : null}

        <FormField htmlFor="customer-merge-reason" label="Why these two are one customer" required>
          <Input
            disabled={isMerging}
            id="customer-merge-reason"
            onChange={(event) => setReason(event.target.value)}
            placeholder="The same doctor registered twice"
            value={reason}
          />
        </FormField>

        <FormError>{error}</FormError>

        {outcome ? (
          <div className="flex min-w-0 gap-3" role="status">
            <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-emerald-500" />
            <p className="min-w-0 break-words text-phx-sm font-semibold leading-6 text-emerald-900">
            {`Merged. Moved ${outcome.requestsMoved} request(s), ${outcome.contactsMoved} contact(s), ${outcome.linksMoved} pharmacy link(s) and ${outcome.transfersMoved} transfer(s). `}
            {outcome.linksLeftOnRetired > 0 ? `${outcome.linksLeftOnRetired} link(s) were already on the customer that stays, so the retired copies were switched off. ` : ""}
            {outcome.linksStatusCarried > 0 ? `${outcome.linksStatusCarried} link(s) took the retired row's higher validation. ` : ""}
            {outcome.validationCarried ? `Validation carried: ${humanizeCode(outcome.validationCarried)}. ` : ""}
            {outcome.evidenceCarried ? "Field evidence carried. " : ""}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            className={cn(phxButtonPrimaryClassName, "gap-2 motion-reduce:transition-none", LANDING_FOCUS)}
            disabled={!canMerge}
            onClick={() => void submit()}
            type="button"
          >
            {isMerging ? <LoadingSpinner /> : <Merge aria-hidden="true" className="h-4 w-4" />}
            Merge customers
          </button>
          {customers === null && !error ? (
            <span className="inline-flex items-center gap-2 text-phx-xs font-bold text-slate-500">
              <LoadingSpinner /> Loading customers...
            </span>
          ) : null}
        </div>
      </div>
    </PortalSection>
  );
}
