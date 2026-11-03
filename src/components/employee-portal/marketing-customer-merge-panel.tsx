"use client";

import { useEffect, useMemo, useState } from "react";
import { Merge } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { PortalSection } from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckTile, FormError, FormField, FormGrid } from "@/components/ui/form-kit";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { humanizeCode } from "@/lib/format/code-label";
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

function Side({ customer, heading }: { customer: MarketingCustomerMergeOption; heading: string }) {
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
    <div className={`min-w-0 border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
      <p className="text-xs font-black uppercase tracking-wide text-slate-500">{heading}</p>
      <p className="mt-1 break-words text-sm font-black text-slate-950">{customer.name}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {facts.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="font-semibold text-slate-500">{label}</dt>
            <dd className="break-words font-bold text-slate-900">{value}</dd>
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
      actions={customers ? <Badge variant="neutral">{`${customers.length} customers`}</Badge> : null}
      description="Fold a duplicate customer into the row that stays. Requests, contacts, pharmacy links and transfers move; costs and dates do not change. Only the same line, kind and area can merge."
      eyebrow="Customer Database"
      title="Merge duplicate customers"
    >
      <div className="grid gap-4 p-4 sm:p-5">
        {groups.length > 0 ? (
          <div className="grid gap-2">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Same name, check</p>
            <p className="text-xs font-semibold text-slate-600">
              Sharing a name does not make two rows one customer. Compare them before you merge.
            </p>
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <Button
                  className="h-auto max-w-full whitespace-normal break-words py-1 text-left"
                  disabled={isMerging}
                  key={group[0].id}
                  onClick={() => pick(group[0].id, group[1].id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {`${group[0].name} (${group.length})`}
                </Button>
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
          <div className="grid gap-3 md:grid-cols-2">
            <Side customer={survivor} heading="Stays" />
            <Side customer={retired} heading="Retired" />
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
          <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold leading-6 text-emerald-900">
            {`Merged. Moved ${outcome.requestsMoved} request(s), ${outcome.contactsMoved} contact(s), ${outcome.linksMoved} pharmacy link(s) and ${outcome.transfersMoved} transfer(s). `}
            {outcome.linksLeftOnRetired > 0 ? `${outcome.linksLeftOnRetired} link(s) were already on the customer that stays, so the retired copies were switched off. ` : ""}
            {outcome.linksStatusCarried > 0 ? `${outcome.linksStatusCarried} link(s) took the retired row's higher validation. ` : ""}
            {outcome.validationCarried ? `Validation carried: ${humanizeCode(outcome.validationCarried)}. ` : ""}
            {outcome.evidenceCarried ? "Field evidence carried. " : ""}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button className="gap-2" disabled={!canMerge} onClick={() => void submit()} type="button">
            {isMerging ? <LoadingSpinner /> : <Merge className="h-4 w-4" />}
            Merge customers
          </Button>
          {customers === null && !error ? (
            <span className="inline-flex items-center gap-2 text-xs font-bold text-slate-500">
              <LoadingSpinner /> Loading customers...
            </span>
          ) : null}
        </div>
      </div>
    </PortalSection>
  );
}
