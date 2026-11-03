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
import { LIFT_WARNING_TEXT } from "@/lib/email/suppression-words";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import type { EmailBlockRow, EmailBlockView } from "@/lib/email/suppression-admin";

/**
 * Who Phoenix refuses to email (owner, 2026-11-03). Mounted only for the Super Admin. Lifting a block
 * deletes one row and sends nothing, and a failed read says so rather than showing an empty list.
 */

const REASON_LABEL: Record<string, string> = {
  complaint: "Marked as spam",
  hard_bounce: "Bounced",
  manual: "Blocked by hand",
  unsubscribe: "Unsubscribed",
};

function cairoDate(iso: string): string {
  return stableEnGbFormatter({ day: "numeric", month: "short", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date(iso));
}

function personLine(row: EmailBlockRow): string {
  if (!row.personName) return "Not an employee";
  return row.personActive ? row.personName : `${row.personName} (no longer active)`;
}

export function EmailSuppressionPanel() {
  const [view, setView] = useState<EmailBlockView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/email-suppressions", { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.message ?? "Could not read the blocked emails.");
          return;
        }
        setView(payload);
      } catch {
        if (!cancelled) setError("Could not read the blocked emails.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function lift(row: EmailBlockRow) {
    if (!window.confirm(`Lift the block on ${row.address}?\n\n${LIFT_WARNING_TEXT}`)) return;
    setBusy(row.address);
    setError(null);
    try {
      const response = await fetch("/api/admin/email-suppressions", {
        body: JSON.stringify({ address: row.address }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? "Could not lift the block.");
        return;
      }
      setView(payload);
    } catch {
      setError("Could not lift the block.");
    } finally {
      setBusy(null);
    }
  }

  function action(row: EmailBlockRow) {
    if (!row.liftable) return <span className="text-xs font-semibold text-slate-500">The person&apos;s own choice</span>;
    return (
      <Button disabled={busy !== null} onClick={() => void lift(row)} size="sm" type="button" variant="outline">
        {busy === row.address ? <LoadingSpinner /> : "Lift"}
      </Button>
    );
  }

  const activeCount = view?.blocked.filter((row) => row.personActive).length ?? 0;

  return (
    <PortalSection
      actions={view ? <Badge variant={activeCount > 0 ? "warning" : "neutral"}>{`${activeCount} active employee(s) blocked`}</Badge> : null}
      description={LIFT_WARNING_TEXT}
      eyebrow="Email"
      title="Blocked work emails"
    >
      <div className="grid gap-4 p-4 sm:p-5">
        <FormError>{error}</FormError>
        {view === null && !error ? (
          <span className="inline-flex items-center gap-2 text-xs font-bold text-slate-500">
            <LoadingSpinner /> Loading blocked emails...
          </span>
        ) : null}
        {view ? (
          <>
            <PortalResponsiveDataList
              empty={<PortalEmptyState message="Phoenix is not refusing any address." title="Nothing is blocked" />}
              getKey={(row) => row.address}
              items={view.blocked}
              renderCard={(row) => (
                <PortalRecordCard actions={action(row)} title={personLine(row)}>
                  <PortalRecordFields
                    fields={[
                      { label: "Address", value: <span className="break-words">{row.address}</span> },
                      { label: "Why", value: REASON_LABEL[row.reason] ?? row.reason },
                      { label: "Since", value: cairoDate(row.blockedAt) },
                      { label: "Provider said", value: <span className="break-words">{row.providerWords ?? "Nothing"}</span> },
                    ]}
                  />
                </PortalRecordCard>
              )}
              renderTable={() => (
                <PortalDesktopTable
                  cols={
                    <colgroup>
                      <col className="w-[22%]" />
                      <col className="w-[24%]" />
                      <col className="w-[10%]" />
                      <col className="w-[10%]" />
                      <col className="w-[22%]" />
                      <col className="w-[12%]" />
                    </colgroup>
                  }
                >
                  <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="px-3 py-3">Person</th>
                      <th className="px-3 py-3">Address</th>
                      <th className="px-3 py-3">Why</th>
                      <th className="px-3 py-3">Since</th>
                      <th className="px-3 py-3">Provider said</th>
                      <th className="px-3 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {view.blocked.map((row) => (
                      <tr className="align-top" key={row.address}>
                        <td className="break-words px-3 py-2 font-semibold text-slate-950">{personLine(row)}</td>
                        <td className="break-words px-3 py-2">{row.address}</td>
                        <td className="px-3 py-2">{REASON_LABEL[row.reason] ?? row.reason}</td>
                        <td className="px-3 py-2">{cairoDate(row.blockedAt)}</td>
                        <td className="break-words px-3 py-2 text-xs">{row.providerWords ?? "Nothing"}</td>
                        <td className="px-3 py-2 text-right">{action(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
            <div className="grid gap-2 border-t border-slate-200 pt-4">
              <p className="text-xs font-black uppercase tracking-wide text-slate-500">
                {`Active people with no work email (${view.noWorkEmail.length})`}
              </p>
              {view.noWorkEmail.length === 0 ? (
                <p className="text-sm font-semibold text-slate-600">Every active person has a work email on file.</p>
              ) : (
                <ul className="grid gap-1 text-sm text-slate-800 sm:grid-cols-2">
                  {view.noWorkEmail.map((person) => (
                    <li className="break-words" key={`${person.name}-${person.jobTitle ?? ""}`}>
                      <span className="font-semibold">{person.name}</span>
                      {person.jobTitle ? `, ${person.jobTitle}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </PortalSection>
  );
}
