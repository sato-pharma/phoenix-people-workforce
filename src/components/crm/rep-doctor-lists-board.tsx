import {
  RepDoctorListsControls,
  RepDoctorListsDoctorTable,
  RepDoctorListsRepTable,
} from "@/components/crm/rep-doctor-lists-tables";
import { REP_DOCTOR_DRILLDOWN_CAP, type RepDoctorListsBoard } from "@/lib/crm/rep-doctor-lists";

// Server half of Rep Doctor Lists. The Section/Tile vocabulary is copied verbatim from
// doctor-coverage-board.tsx, its neighbour in the same shell — flat borders, slate-900 header bar,
// KPI tiles, orange accent. Never a one-off look (owner's standing rule).

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
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "rose"
          ? "text-rose-700"
          : "text-slate-900";
  return (
    <div className="border border-slate-200 px-3 py-2.5">
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-[10px] text-slate-400">{sub}</p> : null}
    </div>
  );
}

/** Cairo wall-clock, per the owner's standing rule that no raw UTC is ever shown. */
function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(iso));
}

export function RepDoctorListsBoardView({ basePath, board }: { basePath: string; board: RepDoctorListsBoard }) {
  const empty = board.reps.length === 0;
  const adherenceTone = board.totals.adherencePct >= 80 ? "emerald" : board.totals.adherencePct >= 50 ? "amber" : "rose";
  const scopeLine =
    "Weekly CRM plan vs regular customer visits (type 0) · duplicates collapsed · departed agents excluded on both sides";
  const description = [
    scopeLine,
    board.planSyncedAt ? `plan last pulled ${cairoStamp(board.planSyncedAt)} Cairo` : "plan never pulled for this month",
    board.isCurrentMonth ? "month to date" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border border-slate-200">
      <Section
        action={
          <RepDoctorListsControls
            applied={board.appliedFilters}
            basePath={basePath}
            month={board.month}
            repOptions={board.repOptions}
          />
        }
        description={description}
        title={`Rep Doctor Lists — ${board.monthLabel}`}
      >
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Reps with a list" sub="from the CRM plan" value={String(board.totals.reps)} />
            <Tile label="Doctors on lists" sub={`${board.totals.plannedCalls} planned calls`} value={String(board.totals.plannedDoctors)} />
            <Tile label="Visited" tone="emerald" value={String(board.totals.visitedDoctors)} />
            <Tile label="Never visited" sub="on the list, not seen" tone="rose" value={String(board.totals.missedDoctors)} />
            <Tile label="Adherence" tone={adherenceTone} value={`${board.totals.adherencePct}%`} />
            <Tile label="Off plan" sub="visited, not on the list" tone="amber" value={String(board.totals.offPlanDoctors)} />
          </div>

          {empty ? (
            <p className="text-xs text-slate-400">
              No plan rows for this month yet. This board reads a mirror of the CRM&rsquo;s weekly plan, which is pulled on
              demand rather than by a scheduled job — press Refresh from CRM above to fetch this month. An empty result
              after a successful pull means the CRM genuinely holds no plan for these dates.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {board.totals.unverifiedCalls > 0 ? (
                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                  {board.totals.unverifiedCalls} planned calls are still at CRM status &ldquo;New&rdquo; — never verified by a
                  supervisor.
                </p>
              ) : null}
              {board.repsWithoutPlan > 0 ? (
                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                  {board.repsWithoutPlan} reps recorded visits this month with no plan in the CRM at all, so they have no
                  doctor list to measure against.
                </p>
              ) : null}
              {board.totals.plannedAccounts > 0 ? (
                <p className="border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                  {board.totals.plannedAccounts} pharmacies, hospitals and contract accounts are also on these lists. They
                  are counted separately — a pharmacy is not a doctor, and adherence above measures doctors only.
                </p>
              ) : null}
              {board.unclassifiedSpecialities.length > 0 ? (
                <p className="border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                  {board.unclassifiedSpecialities.length} specialty values are new to Phoenix and are counted as neither
                  doctor nor account until someone rules on them:{" "}
                  {board.unclassifiedSpecialities.map((entry) => `${entry.label} (${entry.contacts})`).join(", ")}.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </Section>

      <Section
        description="Sorted worst-first — the reps who reached least of their own list. Adherence counts doctors only."
        title="By rep"
      >
        <RepDoctorListsRepTable month={board.month} rows={board.reps} />
      </Section>

      <Section
        description={
          board.doctorsTotal > board.doctors.length
            ? `Never-visited first · showing ${board.doctors.length} of ${board.doctorsTotal} — pick one rep above to see a whole list without the ${REP_DOCTOR_DRILLDOWN_CAP}-row cap`
            : `Never-visited first · ${board.doctorsTotal} contacts`
        }
        title="Doctor by doctor"
      >
        <RepDoctorListsDoctorTable month={board.month} rows={board.doctors} />
      </Section>
    </div>
  );
}
