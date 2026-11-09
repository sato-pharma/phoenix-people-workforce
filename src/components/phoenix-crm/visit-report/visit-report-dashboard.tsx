"use client";

/**
 * Phoenix CRM — the Visit report's dashboard: the tiles and one panel per chosen category's figures.
 *
 * Drawn by hand with square bars rather than a chart library: every panel is a handful of numbers, the
 * module's square-edge rule applies to a chart as much as a card, and nothing here may scroll sideways.
 * The figures are worked out in `visit-report-dashboard.ts`; this only draws them.
 */

import { countText, dayLabel } from "@/components/phoenix-crm/format";
import { CrmBlock, CrmPanel, CrmStat, CrmStatGrid } from "@/components/phoenix-crm/ui";
import { visitReportCategoryOf, type VisitReportDashboard, type VisitReportDashboardPanel } from "@/lib/phoenix-crm/visit-report-fields";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function labelOf(label: string): string {
  return ISO_DAY.test(label) ? dayLabel(label) : label;
}

function Bars({ panel }: { panel: VisitReportDashboardPanel }) {
  const max = Math.max(1, ...panel.items.map((item) => item.value));
  return (
    <ul className="grid gap-1.5">
      {panel.items.map((item) => (
        <li className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2 text-xs font-semibold text-slate-700" key={item.label}>
          <span className="min-w-0 break-words">{labelOf(item.label)}</span>
          <span className="h-3 min-w-0 border border-slate-200 bg-slate-50">
            <span className="block h-full bg-orange-500" style={{ width: `${Math.max(2, Math.round((item.value / max) * 100))}%` }} />
          </span>
          <span className="w-10 text-right font-black text-slate-950">{countText(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Columns({ panel }: { panel: VisitReportDashboardPanel }) {
  const max = Math.max(1, ...panel.items.map((item) => item.value));
  const showValues = panel.items.length <= 16;
  // Few labels on a long run, so a month of days never needs a scroll bar to be read.
  const step = Math.max(1, Math.ceil(panel.items.length / 8));
  return (
    <div>
      <div className="flex h-36 items-end gap-px border-b border-slate-200">
        {panel.items.map((item) => (
          <div
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            key={item.label}
            title={`${labelOf(item.label)}: ${countText(item.value)}`}
          >
            {showValues ? <span className="mb-0.5 text-center text-phx-sm font-black text-slate-700">{countText(item.value)}</span> : null}
            <span className="block w-full bg-orange-500" style={{ height: `${Math.max(2, Math.round((item.value / max) * 100))}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-px">
        {panel.items.map((item, index) => (
          <span className="min-w-0 flex-1 break-words text-center text-phx-sm font-semibold leading-3 text-slate-500" key={item.label}>
            {index % step === 0 ? labelOf(item.label) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export function VisitReportDashboardView({ dashboard }: { dashboard: VisitReportDashboard }) {
  return (
    <CrmPanel description="Worked out from exactly the visits and fields you chose." eyebrow="Dashboard" title="The figures">
      <CrmBlock>
        <CrmStatGrid className="md:grid-cols-5">
          {dashboard.tiles.map((tile) => (
            <CrmStat key={tile.label} label={tile.label} note={tile.hint} value={tile.value} />
          ))}
        </CrmStatGrid>
      </CrmBlock>
      {dashboard.panels.length > 0 ? (
        <CrmBlock>
          <div className="grid gap-3 lg:grid-cols-2">
            {dashboard.panels.map((panel) => (
              <section className="min-w-0 border border-t-2 border-slate-200 border-t-orange-500 bg-white px-4 py-3.5" key={panel.id}>
                <p className="text-phx-sm font-black uppercase tracking-[0.14em] text-orange-600">{visitReportCategoryOf(panel.category).label}</p>
                <h3 className="mb-3 mt-0.5 break-words text-sm font-black text-slate-950">{panel.title}</h3>
                {panel.kind === "columns" ? <Columns panel={panel} /> : <Bars panel={panel} />}
                {panel.note ? <p className="mt-2 break-words text-xs font-medium leading-5 text-slate-500">{panel.note}</p> : null}
              </section>
            ))}
          </div>
        </CrmBlock>
      ) : null}
    </CrmPanel>
  );
}
