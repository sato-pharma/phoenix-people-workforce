import { RepsPlansControls, RepsPlansRepTable } from "@/components/crm/reps-plans-tables";
import { attainmentTone, riskTone, shareTone, type RepsPlansBoard } from "@/lib/crm/reps-plans";

// Server half of Reps Plans. The Section/Tile vocabulary is copied verbatim from
// brick-coverage-board.tsx, its neighbour in the same shell — flat borders, slate-900 header bar,
// KPI tiles, orange accent. Never a one-off look (owner's standing rule).
//
// It was copied from rep-doctor-lists-board.tsx, which was deleted on 2026-09-02 as unreachable
// code. The vocabulary is unchanged: brick-coverage-board.tsx is the same lineage and is live.

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
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-3.5">
        <div>
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-2xs text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Tile({
  label,
  sub,
  tone,
  value,
}: {
  label: string;
  sub?: string;
  tone?: "amber" | "emerald" | "rose" | "sky";
  value: string;
}) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "rose"
          ? "text-rose-700"
          : tone === "sky"
            ? "text-sky-700"
            : "text-slate-900";
  return (
    <div className="border border-slate-200 px-3 py-2.5">
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-phx-2xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-08-27" -> "27 Aug 2026", read straight off the string.
 *
 * These are Cairo CALENDAR days with no time and no zone. Handing one to Date and formatting it
 * back would shift the day for anyone west of Cairo, which is exactly the class of bug the CRM
 * domain's date discipline exists to prevent.
 */
function dayLabel(iso: string): string {
  const month = MONTH_SHORT[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7);
  return `${iso.slice(8, 10)} ${month} ${iso.slice(0, 4)}`;
}

function rate(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

/**
 * Counts on this board run to five figures — 14,224 calls in one August. Bare digits are the
 * owner's "human-readable" rule broken in the smallest possible way, and every sibling CRM board
 * already groups them, so this matches them rather than inventing a format.
 */
function count(value: number): string {
  return value.toLocaleString();
}

function pct(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

export function RepsPlansBoardView({ basePath, board }: { basePath: string; board: RepsPlansBoard }) {
  const totals = board.totals;
  const scoredThrough = dayLabel(board.dateTo);
  // WHICH WINDOW, in the header, whenever it is not the whole month. The rate is per working day and
  // always was; what it divides by is what the reader could not see, and a week's numbers under a
  // heading that says only "August" is the misreading the period picker was built to end.
  const windowText = board.notStarted
    ? `${board.periodLabel} has not started — nothing to score yet`
    : board.isWholeMonth
      ? board.isCurrentMonth
        ? `month to date — scored through ${scoredThrough}`
        : `full month to ${scoredThrough}`
      : board.cappedAtToday
        ? `${board.periodLabel} — scored through ${scoredThrough}, the days since have not happened yet`
        : `${board.periodLabel} — ${dayLabel(board.dateFrom)} to ${scoredThrough}`;
  const description = [
    `${board.workingDays} working days (Sat–Wed) · Thursday worked but not counted, Friday off`,
    "duplicates collapsed · departed agents excluded · leave, meetings and training are not field work",
    windowText,
  ].join(" · ");

  return (
    <div className="border border-slate-200">
      <Section
        action={
          <RepsPlansControls
            appliedLine={board.appliedLine}
            appliedRegion={board.appliedRegion}
            appliedRepKey={board.appliedRepKey}
            basePath={basePath}
            geographyAvailable={board.geographyAvailable}
            lineOptions={board.lineOptions}
            month={board.month}
            periodKey={board.periodKey}
            regionOptions={board.regionOptions}
            repOptions={board.repOptions}
            weekOptions={board.weekOptions}
          />
        }
        description={description}
        title={
          [
            `Reps Plans — ${board.monthLabel}`,
            // The window is part of the TITLE when it is not the whole month, so a screenshot of
            // these tiles carries what they were measured over.
            board.isWholeMonth ? null : board.periodLabel,
            board.geographyLabel,
          ]
            .filter((part): part is string => Boolean(part))
            .join(" · ")
        }
      >
        <div className="space-y-4 p-5">
          {/* THE RULE, in one line, above the numbers it governs. The two rates are the owner's own
              standard and the page is unreadable without it. */}
          <p className="border-l-[3px] border-l-orange-500 bg-orange-50 px-4 py-2.5 text-xs font-semibold text-slate-700">
            A perfect day is <span className="font-black text-slate-900">{board.amTarget} AM accounts</span> and{" "}
            <span className="font-black text-slate-900">{board.pmTarget} PM clinics</span>. The targets are PER DAY, so
            every rate below divides by the{" "}
            <span className="font-black text-slate-900">
              {board.workingDays} calendar working {board.workingDays === 1 ? "day" : "days"}
            </span>{" "}
            in {board.isWholeMonth ? "this month" : board.periodLabel}, not by the days the rep chose to work and not by
            a whole month when a shorter window is in view.
          </p>

          {/* Stated, never implied — WHO the numbers above leave out, and why.
              OWNER'S RULE, 2026-08-28: the two rates are a MEDICAL REP'S KPI. A manager is listed
              with his own territory and his own activity and is measured against nothing, because a
              District Manager's field day is coaching and double visits rather than his own call
              rate. And anyone the SALES organogram has no seat for — head office, where every
              Product Manager legitimately sits — stays listed under his HR job title rather than
              filtered away, because those rows are mostly the zero-proved ones this page exists to
              find. */}
          {board.managersShown + board.unplacedShown > 0 ? (
            <p className="border-l-[3px] border-l-slate-400 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-600">
              The rates above are the{" "}
              <span className="font-black text-slate-900">medical rep</span> KPI
              {board.geographyLabel ? (
                <>
                  {" "}
                  for <span className="font-black text-slate-900">{board.geographyLabel}</span>
                </>
              ) : null}
              , built from{" "}
              <span className="font-black text-slate-900">{board.totals.reps}</span>{" "}
              {board.totals.reps === 1 ? "rep" : "reps"}.
              {board.managersShown > 0 ? (
                <>
                  {" "}
                  <span className="font-black text-slate-900">{board.managersShown}</span>{" "}
                  {board.managersShown === 1 ? "manager is" : "managers are"} listed below with{" "}
                  {board.managersShown === 1 ? "his" : "their"} territory and activity, and scored
                  against no target.
                </>
              ) : null}
              {board.unplacedShown > 0 ? (
                <>
                  {" "}
                  <span className="font-black text-slate-900">{board.unplacedShown}</span>{" "}
                  {board.unplacedShown === 1 ? "person sits" : "people sit"} outside the sales
                  organogram — head office and leavers — and{" "}
                  {board.unplacedShown === 1 ? "is" : "are"} listed by{" "}
                  {board.unplacedShown === 1 ? "his" : "their"} HR job title, with no territory and
                  no target.
                </>
              ) : null}
            </p>
          ) : null}

          {/* Row one: the KPI itself, AM then PM, each with the target it is measured against. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile
              label="AM proved"
              sub={`target ${totals.am.target} · reported ${rate(totals.am.reportedRate)}`}
              tone={attainmentTone(totals.am.attainmentPct)}
              value={rate(totals.am.verifiedRate)}
            />
            <Tile
              label="AM of target"
              sub="proved rate ÷ target"
              tone={attainmentTone(totals.am.attainmentPct)}
              value={pct(totals.am.attainmentPct)}
            />
            <Tile
              label="PM proved"
              sub={`target ${totals.pm.target} · reported ${rate(totals.pm.reportedRate)}`}
              tone={attainmentTone(totals.pm.attainmentPct)}
              value={rate(totals.pm.verifiedRate)}
            />
            <Tile
              label="PM of target"
              sub="proved rate ÷ target"
              tone={attainmentTone(totals.pm.attainmentPct)}
              value={pct(totals.pm.attainmentPct)}
            />
            <Tile
              label="Reps on both"
              // "medical reps", not "with field work": the denominator is the SCORED rows only, so
              // the managers listed below are deliberately not in it.
              sub={`of ${count(totals.reps)} medical reps`}
              tone={shareTone(totals.reps > 0 ? (totals.repsOnTarget / totals.reps) * 100 : null)}
              value={count(totals.repsOnTarget)}
            />
            <Tile label="Working days" sub="Sat · Sun · Mon · Tue · Wed" value={count(board.workingDays)} />
          </div>

          {/* Row two: what the numbers above are made of. Three proof buckets, never summed back
              into one figure — that would undo the entire point of the split. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile
              label="Calls reported"
              sub="every field row in the period"
              value={count(totals.am.reported + totals.pm.reported + totals.unspecified)}
            />
            <Tile
              label="Proved"
              sub="visit + GPS check-in, same doctor"
              tone="emerald"
              value={count(totals.am.verified + totals.pm.verified)}
            />
            <Tile
              label="No check-in"
              sub="real doctor, nothing to confirm it"
              tone="amber"
              value={count(totals.am.unverified + totals.pm.unverified)}
            />
            <Tile
              label="Campaign"
              sub={`${totals.campaignSharePct}% of all field work`}
              tone="sky"
              value={count(totals.campaignCalls)}
            />
            <Tile
              label="Unproven"
              sub="share of reported calls with no proof"
              tone={riskTone(totals.unprovenPct)}
              value={pct(totals.unprovenPct)}
            />
            <Tile
              label={`Days over ${board.campaignLimit}`}
              sub={`${count(totals.repsWithFlaggedDays)} reps · ${count(totals.campaignOnlyDays)} days with no proof at all`}
              tone={totals.flaggedDays > 0 ? "rose" : "emerald"}
              value={count(totals.flaggedDays)}
            />
          </div>

          {/* Why a campaign call cannot be proved, stated once rather than implied by a colour. */}
          <p className="text-phx-xs leading-relaxed text-slate-500">
            A campaign call is made to a doctor who is not a registered customer, so it carries no customer, no location
            and no check-in — there is nothing in the system to attach it to. That is by design, not a fault, and it is
            why campaign calls sit beside both rates and never inside either. More than {board.campaignLimit} of them in
            one day is flagged.
          </p>
        </div>
      </Section>

      <Section
        description="Proved is the rate that counts. Reported is the same rep's number if nobody checks — the gap between the two columns is the point of this page."
        title={board.appliedRepKey ? "Selected rep" : "By rep"}
      >
        <RepsPlansRepTable
          appliedLine={board.appliedLine}
          appliedRegion={board.appliedRegion}
          basePath={basePath}
          campaignLimit={board.campaignLimit}
          geographyAvailable={board.geographyAvailable}
          month={board.month}
          monthLabel={board.isWholeMonth ? board.monthLabel : `${board.monthLabel} · ${board.periodLabel}`}
          periodKey={board.periodKey}
          rows={board.reps}
          scoredThrough={scoredThrough}
        />
      </Section>
    </div>
  );
}
