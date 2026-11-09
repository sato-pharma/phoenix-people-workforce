import {
  BrickCoverageBlindSpotTable,
  BrickCoverageRepTable,
  BrickCoverageUnmeasuredTable,
  BrickCoverageVacancyTable,
} from "@/components/crm/brick-coverage-tables";
import { CoverageFilterBar } from "@/components/crm/coverage-filter-bar";
import type { BrickCoverageBoard as BrickCoverageBoardData } from "@/lib/crm/brick-coverage";
import {
  describeCoverageSelection,
  vacanciesMatching,
  type CoverageFilterSelection,
  type CoverageFilterTree,
} from "@/lib/crm/coverage-filters";

// Server half of the Brick Coverage board — the admin page and any future portal twin share it
// verbatim; only `monthBasePath` differs. Section shells, KPI tiles and the slate-900 header bar
// are copied from doctor-coverage-board.tsx so the CRM coverage boards read as one module. That
// file was deleted on 2026-09-02 as unreachable code — the owner retired its route on 2026-08-28 —
// so this file is now the reference copy of that vocabulary rather than a copy of one.

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
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-sm text-slate-400">{description}</p> : null}
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
      <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-phx-sm text-slate-400">{sub}</p> : null}
    </div>
  );
}

function toneFor(value: number): "amber" | "emerald" | "rose" {
  if (value >= 80) return "emerald";
  if (value >= 50) return "amber";
  return "rose";
}

export function BrickCoverageBoard({
  board,
  monthBasePath,
  scope,
  tree,
}: {
  board: BrickCoverageBoardData;
  monthBasePath: string;
  scope: CoverageFilterSelection;
  tree: CoverageFilterTree;
}) {
  const { totals } = board;
  // Territories the picker deliberately does NOT offer, because nobody is in the seat. They are
  // stated here rather than silently omitted: a patch of the country carrying a sales target with
  // no rep on it is a business fact, and a coverage board that quietly leaves it out is the reason
  // nobody notices. Scoped to the current filter, so the count always describes what is on screen.
  const vacancies = vacanciesMatching(tree, scope);
  const vacantLines = [...new Set(vacancies.map((vacancy) => vacancy.lineName))].sort();
  // Whose numbers these are, always on screen — the owner's standing rule. The territory filter
  // leads: when someone has narrowed to one area, that is the most important fact about every
  // number below it.
  const description = [
    describeCoverageSelection(tree, scope),
    board.scopeLabel,
    "GPS check-ins snapped to the nearest brick centre · sales-carrying bricks only",
    board.isCurrentMonth ? "month to date" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-5">
      {/* The provenance banner is not decoration. This board infers presence from GPS check-ins,
          which is a partial feed, and the number it produces is about people's work — anyone
          reading it has to know what it is before they read a percentage. */}
      <div className="border border-amber-200 bg-amber-50 px-5 py-3">
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-amber-900">Interim board — built on GPS check-ins</p>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          Rep visits carry the CRM vendor&apos;s locality id, not a Phoenix brick, and the CRM region → brick mapping is still empty, so
          coverage here is inferred from where each rep physically checked in. Check-ins are a partial feed:{" "}
          <span className="font-bold">
            {totals.unmeasuredReps === 1
              ? "1 rep had none this month and is listed below unscored, never as zero."
              : `${totals.unmeasuredReps} reps had none this month and are listed below unscored, never as zero.`}
          </span>{" "}
          Treat every row as a lead to check, not a verdict.
        </p>
      </div>

      <div className="border border-slate-200">
        <Section
          action={
            <CoverageFilterBar basePath={monthBasePath} month={board.month} selection={scope} tree={tree} />
          }
          description={description}
          title={`Brick Coverage — ${board.monthLabel}`}
        >
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Tile
                label="Sales covered"
                sub="units in bricks they stood in"
                tone={toneFor(totals.salesCoveragePct)}
                value={`${totals.salesCoveragePct}%`}
              />
              <Tile
                label="Bricks covered"
                sub={`${totals.bricksCovered} of ${totals.bricksWithSales} selling`}
                tone={toneFor(totals.brickCoveragePct)}
                value={`${totals.brickCoveragePct}%`}
              />
              <Tile label="Units in territory" sub="sales-carrying bricks" value={totals.unitsInTerritory.toLocaleString()} />
              <Tile
                label="Units unvisited"
                sub="sold where nobody went"
                tone="rose"
                value={(totals.unitsInTerritory - totals.unitsCovered).toLocaleString()}
              />
              <Tile label="Reps scored" sub="had a GPS feed" value={String(totals.measuredReps)} />
              <Tile label="Reps not scored" sub="no check-in this month" tone={totals.unmeasuredReps > 0 ? "amber" : undefined} value={String(totals.unmeasuredReps)} />
            </div>
            <p className="text-phx-xs leading-relaxed text-slate-500">
              Coverage is weighted by <span className="font-bold text-slate-700">selling units, not brick count</span>. A territory holds many
              bricks that sell nothing, and counting those makes a diligent rep look negligent — so the denominator here is only the bricks that
              actually produced sales this month.
            </p>
          </div>
        </Section>

        <Section
          description="Lowest sales coverage first — the reps whose selling bricks they are least present in · click a name for their contact list"
          title="By rep"
        >
          <BrickCoverageRepTable month={board.month} monthLabel={board.monthLabel} rows={board.repRows} />
        </Section>

        <Section
          description="Bricks that sold for a rep who never checked into them this month — biggest first"
          title="Blind spots — sales with nobody there"
        >
          <BrickCoverageBlindSpotTable monthLabel={board.monthLabel} rows={board.blindSpots} />
        </Section>

        {board.unmeasured.length > 0 ? (
          <Section
            description="Deliberately excluded from every number above — a missing GPS feed is not evidence of a missing rep"
            title="Not scored this month"
          >
            <BrickCoverageUnmeasuredTable month={board.month} rows={board.unmeasured} />
          </Section>
        ) : null}

        {vacancies.length > 0 ? (
          <Section
            description={`Carry a sales target with an empty seat — nobody can cover them, so they are in no total above and in no filter${vacantLines.length > 0 ? ` · ${vacantLines.join(", ")}` : ""}`}
            title={vacancies.length === 1 ? "1 territory has no rep" : `${vacancies.length} territories have no rep`}
          >
            <BrickCoverageVacancyTable rows={vacancies} />
          </Section>
        ) : null}
      </div>
    </div>
  );
}
