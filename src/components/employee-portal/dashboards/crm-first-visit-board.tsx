import { AlarmClock, AlertTriangle, CheckCircle2, Clock, Sunrise } from "lucide-react";

import { SectionHead } from "@/components/employee-portal/portal-command-center";
import type { NsmCrmComplianceData } from "@/lib/employee-portal/nsm-crm-compliance";

// Shared "who has submitted their first CRM visit today" board. Extracted from the NSM command
// center so the National (line-scoped) and Regional (region-scoped) dashboards render one
// identical widget — the data is roster-driven (see nsm-crm-compliance.ts), so the only difference
// between the two is which roster the caller passes in.

function cairoTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Early-bird `at` comes from the vendor's crm_save_date — a zone-less Cairo wall-clock stored as
// +00, so its clock reading is ALREADY Cairo-local. Render as-is (timeZone "UTC"); using cairoTime
// here (as lastSyncAt correctly does for the true-UTC synced_at) would double-add the offset and
// show submission times 2–3h late.
function vendorLocalTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PersonChips({ people, tone }: { people: Array<{ hrId: string; name: string }>; tone: "danger" | "muted" }) {
  const cls =
    tone === "danger"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <div className="flex flex-wrap gap-1.5">
      {people.map((p) => (
        <span key={p.hrId || p.name} className={`whitespace-nowrap border px-2 py-1 text-[11px] font-semibold ${cls}`}>
          {p.name}
        </span>
      ))}
    </div>
  );
}

export function CrmFirstVisitBoard({
  crm,
  allClearMessage = "Everyone on your line has submitted their first visit.",
}: {
  crm: NsmCrmComplianceData | null;
  /** Scope-specific wording for the all-clear state (e.g. "your region" vs "your line"). */
  allClearMessage?: string;
}) {
  const syncLabel = crm?.lastSyncAt ? `as of ${cairoTime(crm.lastSyncAt)}` : "awaiting sync";

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead
        title="CRM First Visit"
        right={<span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">{syncLabel}</span>}
      />
      {crm?.error ? (
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-slate-500">
            CRM data is temporarily unavailable — this is a fetch issue, not a compliance gap. Try again shortly.
          </p>
        </div>
      ) : !crm || !crm.synced ? (
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <Clock className="h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-sm text-slate-500">
            Awaiting today&apos;s first CRM sync — visits mirror from iReports360 roughly every 15&nbsp;minutes from 8:30&nbsp;AM
            to noon, then again at 12:07&nbsp;PM and 7:07&nbsp;PM.
          </p>
        </div>
      ) : (
        <div className="space-y-px bg-slate-200">
          {/* Submitted counts */}
          <div className="grid grid-cols-2 gap-px bg-slate-200">
            {[
              { label: "Reps submitted", submitted: crm.reps.submitted, total: crm.reps.total },
              { label: "DSMs submitted", submitted: crm.dsms.submitted, total: crm.dsms.total },
            ].map((s) => {
              const complete = s.total > 0 && s.submitted >= s.total;
              return (
                <div key={s.label} className="bg-white px-4 py-3">
                  <p className={`text-xl font-black tabular-nums ${complete ? "text-emerald-600" : "text-slate-900"}`}>
                    {s.submitted}
                    <span className="text-sm font-bold text-slate-400">/{s.total}</span>
                  </p>
                  <p className="mt-0.5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-widest text-slate-400">{s.label}</p>
                </div>
              );
            })}
          </div>

          {/* Early birds */}
          <div className="bg-white px-4 py-3 sm:px-5">
            <div className="mb-2 flex items-center gap-2">
              <Sunrise className="h-4 w-4 text-emerald-600" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Early birds</p>
            </div>
            {crm.earlyBirds.length === 0 ? (
              <p className="text-sm text-slate-500">No visits submitted yet today.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {crm.earlyBirds.map((b, i) => {
                  const isGps = b.source === "gps_checkin";
                  return (
                    <span
                      key={b.hrId || b.name}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700"
                    >
                      <span className="font-black text-emerald-600">{i + 1}</span>
                      {b.name}
                      <span className="font-normal text-emerald-600/70">{vendorLocalTime(b.at)}</span>
                      <span
                        className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                          isGps ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                        }`}
                        title={isGps ? "Real GPS check-in time (on site)" : "Logged/save time — not GPS-verified; may be logged later"}
                      >
                        {isGps ? "GPS" : "Logged"}
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Not-yet-submitted alarm */}
          <div className="bg-white px-4 py-3 sm:px-5">
            {crm.reps.missing.length === 0 && crm.dsms.missing.length === 0 ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                <p className="text-sm font-medium text-emerald-700">{allClearMessage}</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <AlarmClock className="h-4 w-4 shrink-0 text-rose-600" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-rose-600">
                    {crm.reps.missing.length + crm.dsms.missing.length} not yet submitted
                  </p>
                </div>
                {crm.dsms.missing.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      <AlertTriangle className="h-3 w-3 text-rose-500" /> DSMs ({crm.dsms.missing.length})
                    </p>
                    <PersonChips people={crm.dsms.missing} tone="danger" />
                  </div>
                )}
                {crm.reps.missing.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      <AlertTriangle className="h-3 w-3 text-rose-500" /> Med reps ({crm.reps.missing.length})
                    </p>
                    <PersonChips people={crm.reps.missing} tone="danger" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
