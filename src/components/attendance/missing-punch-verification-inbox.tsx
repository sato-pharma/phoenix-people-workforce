"use client";

import { useState } from "react";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { MissingPunchVerificationRow } from "@/lib/attendance/missing-punch-verification";

type Props = {
  initialVerifications: MissingPunchVerificationRow[];
  initialError: string | null;
};

const stepLabel: Record<string, string> = {
  awaiting_ceo: "Awaiting your confirmation (CEO step)",
  awaiting_hr: "Awaiting your confirmation (HR step)",
  awaiting_verifier: "Awaiting your confirmation (verifier step)",
};

// iso is a plain YYYY-MM-DD calendar date (no real instant semantics) — anchor
// construction and display to explicit UTC so this never depends on the runtime's
// implicit default (matches the pattern used elsewhere for date-only values).
function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function MissingPunchVerificationInbox({ initialVerifications, initialError }: Props) {
  const [verifications, setVerifications] = useState(initialVerifications);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notesById, setNotesById] = useState<Record<number, string>>({});

  async function decide(verification: MissingPunchVerificationRow, decision: "confirm" | "reject") {
    setBusyId(verification.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/missing-punch/${verification.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, notes: notesById[verification.id]?.trim() || null }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Decision failed.");
      setVerifications((current) => current.filter((entry) => entry.id !== verification.id));
      setNotice(`Missing-punch verification for ${verification.employee_hr_id} (${formatDate(verification.work_date)}) ${decision === "confirm" ? "confirmed" : "rejected"}.`);
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Decision failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={<AdminInsightChip tone="orange">{verifications.length} pending your action</AdminInsightChip>}
        description="Sequential sign-off for missing-punch days: verifier confirms it happened, then HR, then the CEO. Zero salary impact — informational only."
        eyebrow="Attendance"
        icon={<ShieldCheck className="h-3.5 w-3.5" />}
        title="Missing-Punch Verification"
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="neutral">{notice}</AdminCallout> : null}

      <AdminTableShell description="Only verifications where you are the current step's authorized approver appear here." title="Pending Your Action">
        {verifications.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">Nothing pending your action.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {verifications.map((verification) => (
              <div className="space-y-3 p-4" key={verification.id}>
                <div>
                  <p className="text-sm font-black text-slate-950">{verification.employee_hr_id} — {formatDate(verification.work_date)}</p>
                  <p className="text-xs font-semibold text-orange-600">{stepLabel[verification.status] ?? verification.status}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Employee&apos;s reason</p>
                  <p className="mt-1">{verification.employee_reason ?? "—"}</p>
                  {verification.employee_proof_url ? (
                    <a className="mt-1 inline-block text-xs font-bold text-orange-600 underline" href={verification.employee_proof_url} rel="noreferrer" target="_blank">
                      View proof
                    </a>
                  ) : null}
                </div>
                <label className="block space-y-1.5">
                  <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Note (optional)</span>
                  <textarea
                    className="h-16 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-inner outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                    value={notesById[verification.id] ?? ""}
                    onChange={(event) => setNotesById({ ...notesById, [verification.id]: event.target.value })}
                  />
                </label>
                <div className="flex gap-2">
                  <Button disabled={busyId !== null} type="button" onClick={() => decide(verification, "confirm")}>
                    <CheckCircle2 className="h-4 w-4" />
                    {busyId === verification.id ? "…" : "Confirm"}
                  </Button>
                  <Button disabled={busyId !== null} type="button" variant="secondary" onClick={() => decide(verification, "reject")}>
                    <XCircle className="h-4 w-4" />
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
