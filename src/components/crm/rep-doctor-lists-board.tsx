import {
  RepDoctorListsControls,
  RepDoctorListsDoctorTable,
  RepDoctorListsRepTable,
} from "@/components/crm/rep-doctor-lists-tables";
import { RepDoctorTrendPanel } from "@/components/crm/rep-doctor-trend-panel";
import { REP_DOCTOR_DRILLDOWN_CAP, type RepDoctorListsBoard } from "@/lib/crm/rep-doctor-lists";
import type { RepDoctorTrend } from "@/lib/crm/rep-doctor-lists-trend";

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

export function RepDoctorListsBoardView({
  basePath,
  board,
  trend,
}: {
  basePath: string;
  board: RepDoctorListsBoard;
  trend: RepDoctorTrend | null;
}) {
  const empty = board.reps.length === 0;
  const totals = board.totals;
  const coverageTone = totals.coveragePct >= 80 ? "emerald" : totals.coveragePct >= 50 ? "amber" : "rose";
  // Frequency uses lower bands than coverage — see rep-doctor-kpi-tone.ts for why an exact-match
  // KPI cannot share an at-least KPI's thresholds.
  const frequencyTone = totals.frequencyPct >= 60 ? "emerald" : totals.frequencyPct >= 35 ? "amber" : "rose";
  const scopeLine =
    "Weekly CRM plan vs regular customer visits · duplicates collapsed · departed agents excluded on both sides · campaign calls counted separately";
  const description = [
    scopeLine,
    board.planSyncedAt ? `plan last pulled ${cairoStamp(board.planSyncedAt)} Cairo` : "plan never pulled for this month",
    board.isCurrentMonth ? `month to date — scored through ${board.asOf}` : null,
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
          {/* Two rows, one KPI each. Coverage above, frequency below, each with the counts it is
              actually made of — the two answer different questions and a single mixed row of tiles
              invites reading one number as evidence for the other. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Reps with a list" sub="from the CRM plan" value={String(totals.reps)} />
            <Tile label="Doctors on lists" sub={`${totals.plannedCalls} planned calls`} value={String(totals.plannedDoctors)} />
            <Tile label="Coverage" sub="of the list, seen at all" tone={coverageTone} value={`${totals.coveragePct}%`} />
            <Tile label="Visited" tone="emerald" value={String(totals.visitedDoctors)} />
            <Tile label="Never visited" sub="on the list, not seen" tone="rose" value={String(totals.missedDoctors)} />
            <Tile label="Off plan" sub="visited, not on the list" tone="amber" value={String(totals.offPlanDoctors)} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Calls made" sub={`${totals.plannedCallsToDate} due by now`} value={String(totals.actualCalls)} />
            <Tile
              label="Frequency"
              sub="planned count matched exactly"
              tone={frequencyTone}
              value={`${totals.frequencyPct}%`}
            />
            <Tile label="On plan" sub="exactly as planned" tone="emerald" value={String(totals.onPlanDoctors)} />
            <Tile label="Under plan" sub="behind the schedule" tone="amber" value={String(totals.underDoctors)} />
            {/* Over-visiting is a deviation on the owner's rule, never a bonus — toned amber, and
                never emerald, so it can't be read as an achievement. */}
            <Tile label="Over plan" sub="more calls than planned" tone="amber" value={String(totals.overDoctors)} />
            <Tile label="Campaign" sub="worked, no doctor named" value={String(totals.campaignCalls)} />
          </div>

          {empty ? (
            <p className="text-xs text-slate-400">
              No plan rows for this month yet. This board reads a mirror of the CRM&rsquo;s weekly plan, which is pulled on
              demand rather than by a scheduled job — press Refresh from CRM above to fetch this month. An empty result
              after a successful pull means the CRM genuinely holds no plan for these dates.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {board.repsAllCampaign > 0 ? (
                <p className="border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] font-semibold text-sky-800">
                  {board.repsAllCampaign} reps reached none of their list but logged campaign calls instead. A campaign
                  visit records that the rep worked and never which doctor they saw, so it cannot count toward adherence
                  — read their 0% as &ldquo;no regular visits&rdquo;, not as an idle month.
                </p>
              ) : null}
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
              {totals.notDueDoctors > 0 ? (
                <p className="border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                  {totals.notDueDoctors} doctors are planned only for days that have not happened yet. They are held out
                  of the frequency percentage entirely — calling them missed would be an accusation about a call that is
                  not late.
                </p>
              ) : null}
              {/* The plan-quality signal. Reported BESIDE both KPIs and never inside either: a plan
                  that under-asks is a problem with the plan, not with the rep executing it. */}
              {totals.underPlannedVsGrade > 0 ? (
                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                  {totals.underPlannedVsGrade} doctors are planned for fewer calls than their grade norm asks for. That is
                  a signal about the plan, not the rep — frequency above still scores each rep against the plan he was
                  actually given. The norms are editable in{" "}
                  <a className="underline" href="/admin/doctor-coverage-settings">
                    Doctor Coverage settings
                  </a>
                  .
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
        description="Sorted worst-first — the reps who reached least of their own list. Both KPIs count doctors only; pharmacies, hospitals and contract accounts are in their own column."
        title="By rep"
      >
        <RepDoctorListsRepTable month={board.month} rows={board.reps} />
      </Section>

      {trend ? (
        <Section
          description={`${trend.from} to ${trend.to} · coverage and frequency per rep per month, with the change recorded`}
          title="Month by month"
        >
          <RepDoctorTrendPanel trend={trend} />
        </Section>
      ) : null}

      <Section
        description={
          board.doctorsTotal > board.doctors.length
            ? `Never-visited first · plan vs actual on every row · showing ${board.doctors.length} of ${board.doctorsTotal} — pick one rep above to see a whole list without the ${REP_DOCTOR_DRILLDOWN_CAP}-row cap`
            : `Never-visited first · plan vs actual on every row · ${board.doctorsTotal} contacts`
        }
        title="Doctor by doctor"
      >
        <RepDoctorListsDoctorTable month={board.month} rows={board.doctors} />
      </Section>
    </div>
  );
}
