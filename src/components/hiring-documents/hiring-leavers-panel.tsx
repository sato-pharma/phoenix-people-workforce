"use client";

import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { usePathname } from "next/navigation";
import * as React from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { formatLeftDay } from "@/lib/employees/left-flag";
import {
  leaverDaysLabel,
  leaverExitPapers,
  leaverHrFormsHref,
  leaverNamedPapers,
  type LeaverExitPapers,
} from "@/lib/hiring-documents/leavers-logic";
import type { HiringDocumentSignal } from "@/lib/hiring-documents/readiness-signal";
import type {
  HiringDocumentDefinition,
  HiringLeaver,
  HiringLeaverMailbox,
  HiringLeaversData,
} from "@/lib/hiring-documents/types";
import { cn } from "@/lib/utils";

export type HiringLeaversRead = {
  data: HiringLeaversData | null;
  error: string | null;
  isLoading: boolean;
};

/** Read here and held above the tabs, because Scan & Upload picks from the same list. */
export function useHiringLeavers(): HiringLeaversRead & { reload: () => Promise<void> } {
  const [read, setRead] = React.useState<HiringLeaversRead>({ data: null, error: null, isLoading: true });

  const reload = React.useCallback(async () => {
    const fallback = "The leavers list could not be read.";
    try {
      const response = await fetch("/api/hiring-documents/leavers", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as (HiringLeaversData & { message?: string }) | null;
      if (!response.ok || !body?.leavers) {
        setRead((current) => ({ data: current.data, error: body?.message ?? fallback, isLoading: false }));
        return;
      }
      setRead({ data: body, error: null, isLoading: false });
    } catch (error) {
      setRead((current) => ({
        data: current.data,
        error: error instanceof Error ? error.message : fallback,
        isLoading: false,
      }));
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return { ...read, reload };
}

type Props = {
  canManage: boolean;
  documents: HiringDocumentDefinition[];
  onReceivePapers: (employeeHrId: string, documentId: string) => void;
  onRetry: () => void;
  read: HiringLeaversRead;
};

const STATUS_WORD: Record<string, string> = {
  not_renewed: "Not renewed",
  resigned: "Resigned",
  terminated: "Terminated",
};

const SIGNAL_LINE: Record<HiringDocumentSignal, { tone: string; word: string }> = {
  complete: { tone: "text-phx-ok", word: "Received, scan on file" },
  missing: { tone: "text-phx-danger", word: "Marked missing" },
  overdue: { tone: "text-phx-danger", word: "Overdue" },
  pending: { tone: "text-phx-ink-soft", word: "Not received" },
  unevidenced: { tone: "text-phx-warn", word: "Received, no scan" },
};

const MAILBOX_LINE: Record<HiringLeaverMailbox, { tone: string; word: string }> = {
  in_progress: { tone: "text-phx-warn", word: "In progress" },
  none: { tone: "text-phx-ink-soft", word: "No task" },
  not_needed: { tone: "text-phx-ink-soft", word: "Not needed" },
  pending: { tone: "text-phx-warn", word: "Pending" },
  revoked: { tone: "text-phx-ok", word: "Revoked" },
};

const headerClassName =
  "bg-phx-accent-soft px-3 py-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft";
const cellClassName = "border-b border-phx-line px-3 py-3 align-top";

/**
 * WHO HAS LEFT, AND WHAT IS STILL OWED ON EACH (owner, 2026-11-03: "build 1"). Their last working day,
 * how far their exit papers have come with Form 6 and the two clearances named, and what the mailbox
 * register and the device list say. One line each; the papers open beneath their own row, one at a time.
 *
 * It decides nothing and sends nothing. A paper is received through Scan & Upload, as any other is, and
 * a failed read says so, never "nobody has left".
 */
export function HiringLeaversPanel({ canManage, documents, onReceivePapers, onRetry, read }: Props) {
  const pathname = usePathname();
  const [openHrId, setOpenHrId] = React.useState<string | null>(null);

  const leavers = read.data?.leavers ?? [];
  const todayKey = read.data?.todayKey ?? "";
  const standings = React.useMemo(
    () => new Map(leavers.map((leaver) => [leaver.hrId, leaverExitPapers(documents, leaver)])),
    [documents, leavers],
  );
  const noForm6 = leavers.filter((leaver) => {
    const exit = standings.get(leaver.hrId);
    return exit ? leaverNamedPapers(exit, leaver).some((paper) => paper.label === "Form 6" && !paper.received) : false;
  }).length;

  function renderPerson(leaver: HiringLeaver) {
    return (
      <>
        <p className="break-words text-sm font-black text-phx-ink" dir="auto">{leaver.fullName}</p>
        {leaver.jobTitle ? <p className="mt-0.5 break-words text-phx-xs font-semibold text-phx-ink-soft">{leaver.jobTitle}</p> : null}
        <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">
          {STATUS_WORD[String(leaver.employmentStatus ?? "").trim().toLowerCase()] ?? "Left"}
        </p>
      </>
    );
  }

  function renderLastDay(leaver: HiringLeaver) {
    if (!leaver.lastWorkingDate) return <p className="break-words text-sm font-black text-phx-warn">Not recorded</p>;
    return (
      <>
        <p className="text-sm font-black text-phx-ink">{formatLeftDay(leaver.lastWorkingDate)}</p>
        <p className="text-phx-xs font-semibold text-phx-ink-soft">{leaverDaysLabel(todayKey, leaver.lastWorkingDate)}</p>
      </>
    );
  }

  function renderPapers(leaver: HiringLeaver, exit: LeaverExitPapers) {
    const percent = exit.total > 0 ? Math.round((exit.received / exit.total) * 100) : 0;
    return (
      <div className="space-y-1.5">
        <div>
          <p className="text-sm font-black tabular-nums text-phx-ink">
            {exit.received} of {exit.total}
            <span className="ml-1 text-phx-xs font-semibold text-phx-ink-soft">received</span>
          </p>
          <div
            aria-label={`Exit papers received from ${leaver.fullName}`}
            aria-valuemax={exit.total}
            aria-valuemin={0}
            aria-valuenow={exit.received}
            className="mt-1 h-1 w-full bg-phx-line"
            role="progressbar"
          >
            <div className="h-full bg-phx-accent" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <ul className="space-y-0.5 text-phx-xs font-semibold">
          {leaverNamedPapers(exit, leaver).map((paper) => (
            <li className="break-words" key={paper.label}>
              <span className="text-phx-ink-soft">{paper.label}: </span>
              <span className={paper.received ? "text-phx-ok" : "text-phx-warn"}>
                {paper.received ? "Received" : "Not received"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function renderOpen(leaver: HiringLeaver) {
    const mailbox = leaver.mailbox ? MAILBOX_LINE[leaver.mailbox] : { tone: "text-phx-ink-faint", word: "Not read" };
    const devices = leaver.devicesOutstanding;
    return (
      <ul aria-label="What else is open" className="space-y-0.5 text-phx-xs font-semibold">
        <li className="break-words">
          <span className="text-phx-ink-soft">Mailbox: </span>
          <span className={mailbox.tone}>{mailbox.word}</span>
        </li>
        <li className="break-words">
          <span className="text-phx-ink-soft">Devices: </span>
          {devices === null ? (
            <span className="text-phx-ink-faint">Not read</span>
          ) : (
            <span className={devices > 0 ? "font-black text-phx-danger" : "text-phx-ok"}>
              {devices > 0 ? `${devices} still out` : "None out"}
            </span>
          )}
        </li>
      </ul>
    );
  }

  function renderToggle(leaver: HiringLeaver, panelId: string) {
    const open = openHrId === leaver.hrId;
    const Chevron = open ? ChevronUp : ChevronDown;
    return (
      <Button
        {...rowDetailToggleProps(panelId, open)}
        aria-label={`${open ? "Close" : "Open"} the exit papers of ${leaver.fullName}`}
        className="h-9 w-full gap-1.5"
        onClick={() => setOpenHrId(open ? null : leaver.hrId)}
        variant="secondary"
      >
        {open ? "Close" : "Papers"}
        <Chevron className="h-4 w-4" />
      </Button>
    );
  }

  function renderDetail(leaver: HiringLeaver, exit: LeaverExitPapers) {
    return (
      <div className="space-y-3">
        <ul className="divide-y divide-phx-line border border-phx-line bg-white shadow-none">
          {exit.papers.map(({ document, signal, standing }) => (
            <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2" key={document.id}>
              <div className="min-w-0 flex-1 basis-48">
                <p className={cn("break-words text-sm font-bold", standing === "greyed" ? "text-phx-ink-faint" : "text-phx-ink")}>{document.name}</p>
                {standing === "greyed" ? (
                  <p className="text-phx-xs font-semibold text-phx-ink-faint">Not needed, the other paper was chosen</p>
                ) : (
                  <p className={cn("text-phx-xs font-semibold", SIGNAL_LINE[signal].tone)}>
                    {SIGNAL_LINE[signal].word}
                    {standing === "either" ? ", only one of the two is signed" : ""}
                  </p>
                )}
              </div>
              {canManage && standing !== "greyed" && signal !== "complete" ? (
                <Button
                  className="h-auto min-h-9 whitespace-normal px-2 py-1.5 leading-tight"
                  onClick={() => onReceivePapers(leaver.hrId, document.id)}
                  variant="secondary"
                >
                  {signal === "unevidenced" ? "Scan" : "Receive"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <a className="inline-block text-phx-xs font-bold text-phx-accent hover:underline" href={leaverHrFormsHref(pathname, leaver.hrId)}>
          Print their papers in HR Forms
        </a>
      </div>
    );
  }

  return (
    <AdminTableShell
      action={
        !read.isLoading && !read.error && leavers.length > 0 ? (
          <p className="text-phx-xs font-bold tabular-nums text-phx-ink-soft">
            {leavers.length} left
            {noForm6 > 0 ? <span className="text-phx-warn"> · {noForm6} without Form 6</span> : null}
          </p>
        ) : undefined
      }
      description="Everyone who has resigned, been terminated or not been renewed, most recent first, with what is still owed on each."
      title="Leavers"
    >
      {read.isLoading ? (
        <div aria-busy="true" className="space-y-2 p-4">
          <span className="sr-only">Loading the leavers.</span>
          <div className="h-12 animate-pulse bg-phx-line/40" />
          <div className="h-12 animate-pulse bg-phx-line/40" />
          <div className="h-12 animate-pulse bg-phx-line/40" />
        </div>
      ) : null}

      {!read.isLoading && read.error ? (
        <div className="p-4">
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
            <div>
              <h3 className="text-sm font-bold text-[#B91C1C]">The leavers list could not be read</h3>
              <p className="mt-1 text-sm text-[#991B1B]">{read.error}</p>
              <Button className="mt-3 h-9 gap-2" onClick={onRetry} variant="secondary">
                <RefreshCw className="h-4 w-4" />
                Try again
              </Button>
            </div>
          </AdminCallout>
        </div>
      ) : null}

      {!read.isLoading && !read.error && leavers.length === 0 ? (
        <p className="p-4 text-sm font-semibold text-phx-ink-soft">Nobody is recorded as having left.</p>
      ) : null}

      {!read.isLoading && !read.error && leavers.length > 0 ? (
        <>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[16%]" />
                <col className="w-[26%]" />
                <col className="w-[18%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className={headerClassName}>Leaver</th>
                  <th className={headerClassName}>Last day</th>
                  <th className={headerClassName}>Exit papers</th>
                  <th className={headerClassName}>Also open</th>
                  <th className={headerClassName}><span className="sr-only">Their papers</span></th>
                </tr>
              </thead>
              <tbody>
                {leavers.map((leaver) => {
                  const exit = standings.get(leaver.hrId);
                  if (!exit) return null;
                  const panelId = `leaver-row-panel-${leaver.hrId}`;
                  return (
                    <React.Fragment key={leaver.hrId}>
                      <tr>
                        <td className={cellClassName}>{renderPerson(leaver)}</td>
                        <td className={cellClassName}>{renderLastDay(leaver)}</td>
                        <td className={cellClassName}>{renderPapers(leaver, exit)}</td>
                        <td className={cellClassName}>{renderOpen(leaver)}</td>
                        <td className={cellClassName}>{renderToggle(leaver, panelId)}</td>
                      </tr>
                      {openHrId === leaver.hrId ? (
                        <TableRowDetail className="px-3 pb-4" colSpan={5} id={panelId}>
                          {renderDetail(leaver, exit)}
                        </TableRowDetail>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-4 md:hidden">
            {leavers.map((leaver) => {
              const exit = standings.get(leaver.hrId);
              if (!exit) return null;
              const panelId = `leaver-card-panel-${leaver.hrId}`;
              return (
                <div className="space-y-3 border border-phx-line bg-white p-4 shadow-none" key={leaver.hrId}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">{renderPerson(leaver)}</div>
                    <div className="text-right">{renderLastDay(leaver)}</div>
                  </div>
                  {renderPapers(leaver, exit)}
                  {renderOpen(leaver)}
                  {renderToggle(leaver, panelId)}
                  {openHrId === leaver.hrId ? (
                    <div className="border-t border-phx-line pt-3" id={panelId}>
                      {renderDetail(leaver, exit)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </AdminTableShell>
  );
}
