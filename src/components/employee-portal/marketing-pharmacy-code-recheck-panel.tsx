"use client";

import { useEffect, useState } from "react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-kit";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { MasterRecheckListRow } from "@/lib/marketing-requests/master-recheck";

/**
 * Person-decided pharmacy codes the sales master now matches (REC-077, owner's "pin untouched, list
 * rest", 14 Nov 2026). The night matches only codes nobody has decided on; these were approved or noted
 * by a person, so each waits here. The master's shop sits beside the pharmacy's own name, because the
 * master can give a code to a different shop, and that is what the person pressing is judging.
 */

type Action = "confirm" | "keep";

function masterShop(code: MasterRecheckListRow): string {
  const name = code.masterCustomerName ? ` · ${code.masterCustomerName}` : "";
  return `${code.masterDistributorCode} ${code.masterCustomerCode}${name}`;
}

function decidedBy(code: MasterRecheckListRow): string {
  return code.validatedByName ?? "No name recorded";
}

function confirmationFor(code: MasterRecheckListRow, action: Action): string {
  if (action === "confirm") {
    return (
      `Match ${code.pharmacyName} (${code.vendorName} ${code.enteredCode}) to the sales master's shop?\n\n`
      + `${masterShop(code)}${code.masterAreaName ? `, ${code.masterAreaName}` : ""}.\n\n`
      + "The code's own approval and note are kept; the match is added to its note."
    );
  }
  return `Keep ${code.pharmacyName} (${code.vendorName} ${code.enteredCode}) as decided?\n\nIt leaves this list and stays unmatched.`;
}

export function MarketingPharmacyCodeRecheckPanel() {
  const [codes, setCodes] = useState<MasterRecheckListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/marketing-requests/pharmacy-code-recheck", { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.message ?? "Could not read the codes awaiting confirmation.");
          return;
        }
        setCodes(payload.codes ?? []);
      } catch {
        if (!cancelled) setError("Could not read the codes awaiting confirmation.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function decide(code: MasterRecheckListRow, action: Action) {
    if (!window.confirm(confirmationFor(code, action))) return;
    setBusyId(code.codeId);
    setError(null);
    try {
      const response = await fetch("/api/marketing-requests/pharmacy-code-recheck", {
        body: JSON.stringify({ action, codeId: code.codeId }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? "Could not change the code.");
        return;
      }
      setCodes(payload.codes ?? []);
    } catch {
      setError("Could not change the code.");
    } finally {
      setBusyId(null);
    }
  }

  function actions(code: MasterRecheckListRow) {
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={busyId !== null} onClick={() => void decide(code, "confirm")} size="sm" type="button" variant="outline">
          {busyId === code.codeId ? <LoadingSpinner /> : "Confirm match"}
        </Button>
        <Button disabled={busyId !== null} onClick={() => void decide(code, "keep")} size="sm" type="button" variant="outline">
          Keep as decided
        </Button>
      </div>
    );
  }

  return (
    <PortalSection
      actions={codes ? <Badge variant="neutral">{`${codes.length} waiting`}</Badge> : null}
      description="Codes a person approved or noted that the sales master now matches to one shop. The nightly re-check never changes them; confirm the master's shop or keep the code as decided."
      eyebrow="Marketing Control"
      title="Pharmacy codes the sales master now knows"
    >
      <div className="grid gap-3 p-4 sm:p-5">
        <FormError>{error}</FormError>
        {codes === null && !error ? (
          <span className="inline-flex items-center gap-2 text-xs font-bold text-slate-500">
            <LoadingSpinner /> Loading codes...
          </span>
        ) : null}
        {codes ? (
          <PortalResponsiveDataList
            empty={<PortalEmptyState message="No person-decided code is waiting on the sales master." title="Nothing waiting" />}
            getKey={(code) => code.codeId}
            items={codes}
            renderCard={(code) => (
              <PortalRecordCard actions={actions(code)} status={<Badge variant="neutral">{code.status}</Badge>} title={code.pharmacyName}>
                <PortalRecordFields
                  fields={[
                    { label: "Entered code", value: `${code.vendorName} ${code.enteredCode}` },
                    { label: "Sales master shop", value: masterShop(code) },
                    { label: "Master area", value: code.masterAreaName ?? "Not recorded" },
                    { label: "Decided by", value: decidedBy(code) },
                    { label: "Note", value: code.note ?? "No note" },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[18%]" />
                    <col className="w-[14%]" />
                    <col className="w-[22%]" />
                    <col className="w-[26%]" />
                    <col className="w-[20%]" />
                  </colgroup>
                }
              >
                <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3">Pharmacy</th>
                    <th className="break-words px-3 py-3">Entered code</th>
                    <th className="break-words px-3 py-3">Sales master shop</th>
                    <th className="break-words px-3 py-3">Decided</th>
                    <th className="px-3 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {codes.map((code) => (
                    <tr className="align-top" key={code.codeId}>
                      <td className="break-words px-3 py-2 font-semibold text-slate-950">{code.pharmacyName}</td>
                      <td className="break-words px-3 py-2 tabular-nums">{`${code.vendorName} ${code.enteredCode}`}</td>
                      <td className="break-words px-3 py-2">
                        {masterShop(code)}
                        {code.masterAreaName ? <span className="block text-xs text-slate-500">{code.masterAreaName}</span> : null}
                      </td>
                      <td className="break-words px-3 py-2">
                        <span className="block">{`${code.status} · ${decidedBy(code)}`}</span>
                        {code.note ? <span className="block break-words text-xs text-slate-500">{code.note}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-right">{actions(code)}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        ) : null}
      </div>
    </PortalSection>
  );
}
