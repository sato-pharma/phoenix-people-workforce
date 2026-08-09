import { DoctorCoverageDoctorTable, DoctorCoverageRepTable } from "@/components/crm/doctor-coverage-tables";
import { DoctorCoverageFilterBar } from "@/components/crm/doctor-coverage-filter-bar";
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
  const scopeLine = "Regular customer visits (type 0) only · duplicates collapsed · departed agents excluded";
  const emptyPanel = board.totals.activePanel === 0;
  // Whose numbers these are, always on screen — the owner's standing rule. Empty only on the
  // fixture path, which has no viewer.
  const description = [board.scopeLabel, scopeLine, board.isCurrentMonth ? "month to date" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border border-slate-200">
      <Section
        action={
          <DoctorCoverageFilterBar
            applied={board.appliedFilters}
            basePath={monthBasePath}
            month={board.month}
            repOptions={board.repOptions}
          />
        }
        description={description}
        title={`Doctor Coverage & Frequency — ${board.monthLabel}`}
      >
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile
              label="Coverage"
              // Pace-adjusted: on day 8 of 31 an on-track team has not covered 80% of its panel yet,
              // and colouring that rose taught everyone to ignore the tile. The bar comes from the
              // domain (board.pace), never re-derived here, so both twins agree.
              sub={
                board.isCurrentMonth
                  ? `vs ${board.pace.expectedCoveragePct}% on-pace · ${board.pace.daysRemaining}d left`
                  : undefined
              }
              tone={board.pace.tone}
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
              No graded doctor panel for this month. This reads as empty when the month genuinely has no graded
              regular-visit activity in scope — not because grading is missing: iReports360 grades run back to
              January 2026.
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
                {/* Two lists, never one. A pharmacy is not a specialty, and ranking them together
                    put pharmacies above most real specialties (owner, 2026-08-08). */}
                <p className="mb-2 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">
                  Specialty mix — doctors (SP)
                </p>
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {board.specialtyMix.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-400">No doctors in this panel.</p>
                  ) : (
                    board.specialtyMix.map((specialty, index) => (
                      <div className="flex items-center gap-3 whitespace-nowrap px-3 py-2" key={specialty.label}>
                        <span className="w-5 text-[11px] font-black text-slate-300">#{index + 1}</span>
                        <span className="flex-1 text-sm font-medium text-slate-700">{specialty.label}</span>
                        <span className="w-14 text-right text-sm font-black text-slate-900">{specialty.doctors}</span>
                      </div>
                    ))
                  )}
                </div>

                <p className="mb-2 mt-4 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">
                  Account mix — pharmacies, hospitals &amp; contracts (HCP)
                </p>
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {board.accountMix.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-400">No HCP accounts in this panel.</p>
                  ) : (
                    board.accountMix.map((account, index) => (
                      <div className="flex items-center gap-3 whitespace-nowrap px-3 py-2" key={account.label}>
                        <span className="w-5 text-[11px] font-black text-slate-300">#{index + 1}</span>
                        <span className="flex-1 text-sm font-medium text-slate-700">{account.label}</span>
                        <span className="w-14 text-right text-sm font-black text-slate-900">{account.doctors}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </Section>

      {board.callList.length > 0 ? (
        <Section
          description={
            board.callListTotal > board.callList.length
              ? `A-grade first, then furthest behind, then longest unseen · showing ${board.callList.length} of ${board.callListTotal} doctors still short of norm`
              : `A-grade first, then furthest behind, then longest unseen · ${board.callListTotal} doctors still short of norm`
          }
          title={board.isCurrentMonth ? `Call list — ${board.pace.daysRemaining} days left` : "Call list — month closed"}
        >
          <div className="overflow-x-auto">
            <div className="divide-y divide-slate-100">
              {board.callList.map((doctor, index) => (
                <div className="flex items-center gap-3 whitespace-nowrap px-5 py-2" key={doctor.contactCrmId}>
                  <span className="w-6 text-[11px] font-black text-slate-300">#{index + 1}</span>
                  <span
                    className={`w-5 text-[11px] font-black ${
                      doctor.gradeTier === "A" ? "text-rose-700" : doctor.gradeTier === "B" ? "text-amber-700" : "text-slate-400"
                    }`}
                  >
                    {doctor.gradeTier}
                  </span>
                  <span className="min-w-56 flex-1 text-sm font-semibold text-slate-800">{doctor.contactName}</span>
                  <span className="min-w-40 text-xs text-slate-400">{doctor.speciality ?? "Unspecified"}</span>
                  <span className="min-w-44 text-xs font-medium text-slate-600">{doctor.repName}</span>
                  <span className="w-28 text-right text-xs font-black text-slate-900">
                    needs {doctor.visitsNeeded}
                  </span>
                  <span className="w-32 text-right text-xs text-slate-400">
                    {doctor.lastVisitDate ? `last ${doctor.lastVisitDate}` : "never seen"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      ) : null}

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
