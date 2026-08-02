import {
  DoctorCoverageDoctorTable,
  DoctorCoverageRepTable,
  MonthPicker,
} from "@/components/crm/doctor-coverage-tables";
import type { SfeDoctorCoverageBoard } from "@/lib/crm/sfe-doctor-coverage";

// Server half of the Doctor Coverage board — shared verbatim by the admin page (SFE Manager +
// Super Admin) and the NSM portal twin; only `monthBasePath` differs. Styling copies the CEO/SFE
// command-center vocabulary exactly (Section shells, KPI tiles, divide-y mini lists, orange
// accent) — see ceo-phase-b.tsx; never a one-off look.

function Section({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-3.5">
        <div>
          <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-[10px] text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Tile({ label, sub, tone, value }: { label: string; sub?: string; tone?: "amber" | "emerald" | "rose"; value: string }) {
  const valueClass =
    tone === "emerald" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : tone === "rose" ? "text-rose-700" : "text-slate-900";
  return (
    <div className="border border-slate-200 px-3 py-2.5">
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-[10px] text-slate-400">{sub}</p> : null}
    </div>
  );
}

export function DoctorCoverageBoard({ board, monthBasePath }: { board: SfeDoctorCoverageBoard; monthBasePath: string }) {
  const scopeLine =
    "Regular customer visits (type 0) only · duplicates collapsed · departed agents excluded · grades supplied by iReports360 since 2026-07-24";
  const emptyPanel = board.totals.activePanel === 0;

  return (
    <div className="border border-slate-200">
      <Section
        action={<MonthPicker basePath={monthBasePath} month={board.month} />}
        description={`${scopeLine}${board.isCurrentMonth ? " · month to date" : ""}`}
        title={`Doctor Coverage & Frequency — ${board.monthLabel}`}
      >
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile
              label="Coverage"
              sub={board.isCurrentMonth ? "month to date" : undefined}
              tone={board.totals.coveragePct >= 80 ? "emerald" : board.totals.coveragePct >= 50 ? "amber" : "rose"}
              value={`${board.totals.coveragePct}%`}
            />
            <Tile label="Active panel" sub="graded doctors in play" value={String(board.totals.activePanel)} />
            <Tile label="Covered" tone="emerald" value={String(board.totals.green)} />
            <Tile label="Under-visited" tone="amber" value={String(board.totals.yellow)} />
            <Tile label="Lapsed" sub="seen recently, none this month" tone="rose" value={String(board.totals.red)} />
            <Tile label="Ungraded seen" sub="visited, no vendor grade" value={String(board.totals.ungradedContacts)} />
          </div>

          {emptyPanel ? (
            <p className="text-xs text-slate-400">
              No graded doctor panel for this month — iReports360 only began sending doctor grades on 2026-07-24, so
              earlier months have no coverage baseline.
            </p>
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Grade split</p>
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {board.gradeSplit.map((grade) => (
                    <div className="flex items-center gap-3 px-3 py-2" key={grade.tier}>
                      <span className="w-5 text-[11px] font-black text-slate-300">{grade.tier}</span>
                      <span className="flex-1 text-sm font-medium text-slate-700">{grade.doctors} doctors</span>
                      <span className="w-24 text-right text-sm font-black text-emerald-700">{grade.covered} covered</span>
                    </div>
                  ))}
                </div>
                <p className="mb-2 mt-4 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Coverage trend</p>
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {board.trend.map((point) => (
                    <div className="flex items-center gap-3 px-3 py-2" key={point.month}>
                      <span className="flex-1 text-sm font-medium text-slate-700">{point.label}</span>
                      <div className="h-2 w-28 bg-slate-100">
                        <div className="h-full bg-orange-500" style={{ width: `${Math.max(2, point.coveragePct)}%` }} />
                      </div>
                      <span className="w-12 text-right text-sm font-black text-slate-900">{point.coveragePct}%</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">Specialty mix (panel doctors)</p>
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {board.specialtyMix.map((specialty, index) => (
                    <div className="flex items-center gap-3 px-3 py-2" key={specialty.label}>
                      <span className="w-5 text-[11px] font-black text-slate-300">#{index + 1}</span>
                      <span className="flex-1 text-sm font-medium text-slate-700">{specialty.label}</span>
                      <span className="w-14 text-right text-sm font-black text-slate-900">{specialty.doctors}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section description="Sorted worst-first — the reps whose panels need attention." title="Coverage by rep">
        <DoctorCoverageRepTable rows={board.reps} />
      </Section>

      <Section
        description="Every doctor in the panel with status and last visit — filter to Under-visited or Lapsed to build call lists."
        title="Doctor drill-down"
      >
        <DoctorCoverageDoctorTable month={board.month} rows={board.doctors} />
      </Section>
    </div>
  );
}
