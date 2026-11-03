import { AlertTriangle } from "lucide-react";

import { adminPanelDepthClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { JobPostCloseCardButton } from "@/components/recruitment/job-post-close-card-button";
import type { AccessContext } from "@/lib/auth/permissions";
import { listRequisitions } from "@/lib/recruitment/requisitions";
import { readOpenCareersCards } from "@/lib/recruitment/job-posts/website";
import { careersGuard, type CareersGuardReport, type OpenCareersCard } from "@/lib/recruitment/job-posts/website-cards";

const panelClassName = `border border-slate-200 bg-white ${adminPanelDepthClassName}`;
const HIRING_STATUSES = new Set(["req_open", "req_published"]);

function Panel({ aside, children }: { aside?: string; children: React.ReactNode }) {
  return (
    <section className={panelClassName}>
      <header className={`${adminPanelHeaderClassName} flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5`}>
        <h2 className="text-sm font-bold">The careers page against open requisitions</h2>
        {aside ? <span className="text-xs font-semibold">{aside}</span> : null}
      </header>
      <div className="space-y-3 p-4 text-sm">{children}</div>
    </section>
  );
}

/** The page's own loading state, so a slow website never holds up the builder below it. */
export function JobPostCareersGuardLoading() {
  return (
    <Panel>
      <p className="text-slate-600">Reading the careers page…</p>
    </Panel>
  );
}

/**
 * Warnings and quiet notes from the live careers page. A FAILED READ SAYS IT COULD NOT CHECK, never that
 * all is clear. Rendered inside a Suspense boundary, so it reads on its own time.
 */
export async function JobPostCareersGuard({ access, canClose, titles }: { access: AccessContext; canClose: boolean; titles: readonly string[] }) {
  let cards: OpenCareersCard[];
  let report: CareersGuardReport;
  try {
    const [openCards, requisitions] = await Promise.all([readOpenCareersCards(), listRequisitions(access)]);
    cards = openCards;
    report = careersGuard({
      cards,
      requisitionTitles: requisitions.filter((row) => HIRING_STATUSES.has(row.status)).map((row) => row.jobTitle),
      titles,
    });
  } catch {
    return (
      <Panel>
        <p className="font-semibold text-amber-700">Could not check the careers page against the requisitions right now. This says nothing about whether they match.</p>
      </Panel>
    );
  }

  return (
    <Panel aside={`${report.requisitions} active requisitions · ${report.openCards} open cards`}>
      {report.warnings.length ? (
        <ul className="space-y-1.5">
          {report.warnings.map((warning) => (
            <li className="flex items-start gap-2 font-semibold text-amber-700" key={warning}>
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0">{warning}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-semibold text-slate-700">No warnings from this reading.</p>
      )}
      {report.notes.length || cards.length ? (
        <details>
          <summary className="cursor-pointer text-xs font-bold text-slate-600">
            {cards.length} open {cards.length === 1 ? "card" : "cards"} and {report.notes.length} {report.notes.length === 1 ? "note" : "notes"}
          </summary>
          <div className="space-y-3 pt-3">
            {report.notes.length ? (
              <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
                {report.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {cards.map((card) => (
                <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2" key={card.id}>
                  <span className="min-w-0">
                    <span className="block font-semibold text-slate-800">{card.title}</span>
                    {card.location ? <span className="block text-xs text-slate-600">{card.location}</span> : null}
                  </span>
                  {canClose ? <JobPostCloseCardButton cardId={card.id} title={card.title} /> : null}
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </Panel>
  );
}
