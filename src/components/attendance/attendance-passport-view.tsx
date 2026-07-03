"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, BadgeCheck, Search, UserRound } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { AttendancePassport } from "@/lib/attendance/attendance-passport";

type Props = {
  passport: AttendancePassport | null;
  error: string | null;
  searchedHrId?: string;
};

const DIGEST_STATUS_LABELS: Record<AttendancePassport["digests"][number]["status"], string> = {
  auto_confirmed: "Auto-confirmed",
  draft: "Draft",
  pending_admin_review: "Awaiting admin review",
  sent: "Awaiting response",
  settled: "Settled",
  void: "Void",
};

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function SearchBar({ defaultValue }: { defaultValue?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue ?? "");

  function go() {
    const trimmed = value.trim();
    if (!trimmed) return;
    router.push(`/attendance/passport/${encodeURIComponent(trimmed)}`);
  }

  return (
    <div className="flex items-center gap-2">
      <input
        className="h-9 w-48 rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
        placeholder="HR ID (e.g. A-13)"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && go()}
      />
      <Button type="button" variant="secondary" onClick={go}>
        <Search className="h-4 w-4" />
        View Passport
      </Button>
    </div>
  );
}

export function AttendancePassportView({ passport, error, searchedHrId }: Props) {
  if (!passport) {
    return (
      <div className="space-y-5">
        <AdminPageHero
          description="A complete, per-employee attendance-settlement history: every digest, decision, and missing-punch case in one place."
          eyebrow="Attendance"
          icon={<UserRound className="h-3.5 w-3.5" />}
          title="Attendance Passport"
        />
        <AdminTableShell action={<SearchBar defaultValue={searchedHrId} />} description="Search an employee by HR ID to open their passport." title="Find an employee">
          {error ? <div className="p-4"><AdminCallout tone="danger">{error}</AdminCallout></div> : <div className="p-8 text-center text-sm font-semibold text-slate-500">Enter an HR ID above.</div>}
        </AdminTableShell>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={
          <>
            <AdminInsightChip tone="orange">{passport.stats.totalDigests} digest(s)</AdminInsightChip>
            <AdminInsightChip tone="orange">{passport.stats.totalDeductionValueEgp.toFixed(2)} EGP total deducted</AdminInsightChip>
            {passport.stats.missingPunchCasesOpen > 0 ? (
              <AdminInsightChip tone="orange">{passport.stats.missingPunchCasesOpen} missing-punch case(s) open</AdminInsightChip>
            ) : null}
          </>
        }
        description={`${passport.employeeName} (${passport.employeeHrId})`}
        eyebrow="Attendance Passport"
        icon={<UserRound className="h-3.5 w-3.5" />}
        title={passport.employeeName}
      />

      <AdminTableShell action={<SearchBar defaultValue={passport.employeeHrId} />} description="Search another employee." title="Find an employee">
        <div className="p-4 text-xs font-semibold text-slate-500">Type an HR ID above to switch passports.</div>
      </AdminTableShell>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Confirmed</p>
          <p className="mt-1 text-2xl font-black text-slate-950">{passport.stats.confirmed}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Auto-confirmed</p>
          <p className="mt-1 text-2xl font-black text-slate-950">{passport.stats.autoConfirmed}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Disputes upheld</p>
          <p className="mt-1 text-2xl font-black text-slate-950">{passport.stats.disputeUpheld}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Disputes rejected</p>
          <p className="mt-1 text-2xl font-black text-slate-950">{passport.stats.disputeRejected}</p>
        </div>
      </div>

      <AdminTableShell description="Every weekly digest this employee has received." title="Digest History">
        {passport.digests.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No digests yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {passport.digests.map((digest) => (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={digest.id}>
                <div>
                  <p className="text-sm font-black text-slate-950">
                    {digest.cycleKey} — Week {digest.weekIndex} ({digest.weekStart} to {digest.weekEnd})
                  </p>
                  <p className="text-xs font-semibold text-slate-500">
                    {DIGEST_STATUS_LABELS[digest.status]} &middot; {digest.totalDeductionDays} day(s) &middot; {digest.totalDeductionValue.toFixed(2)} EGP
                  </p>
                </div>
                <p className="text-xs font-semibold text-slate-500">Sent {formatDateTime(digest.sentAt)}</p>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>

      <AdminTableShell description="Immutable record of every confirm / auto-confirm / dispute-review decision." title="Settlement History">
        {passport.settlements.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No settlements yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {passport.settlements.map((entry) => (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={entry.id}>
                <div className="flex items-center gap-2">
                  <BadgeCheck className="h-4 w-4 shrink-0 text-orange-500" />
                  <div>
                    <p className="text-sm font-black text-slate-950">{entry.workDate} — {entry.action.replace(/_/g, " ")}</p>
                    <p className="text-xs font-semibold text-slate-500">
                      {entry.lineStatus} &middot; {entry.deductionDays} day(s) &middot; {entry.deductionValue.toFixed(2)} EGP
                    </p>
                  </div>
                </div>
                <p className="text-xs font-semibold text-slate-500">{formatDateTime(entry.decidedAt)}</p>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>

      <AdminTableShell description="Documented reasons for a single-punch day, and where each case stands in the A-13 -> HR -> CEO chain." title="Missing-Punch Cases">
        {passport.missingPunchCases.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No missing-punch cases.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {passport.missingPunchCases.map((entry) => (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={entry.id}>
                <div className="flex items-center gap-2">
                  {entry.status === "rejected" ? <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500" /> : null}
                  <p className="text-sm font-black text-slate-950">{entry.workDate} — {entry.status.replace(/_/g, " ")}</p>
                </div>
                <p className="text-xs font-semibold text-slate-500">Submitted {formatDateTime(entry.submittedAt)}</p>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
