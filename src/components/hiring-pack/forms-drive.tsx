"use client";

// The HR Forms drive — folders, the papers in them, and the three ways to fill one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The owner, 2026-09-13: "i want it to look like a drive with folders every folder contain documents
// i press on whatever document i need i have 2 options either to choose employee and data auto
// populates or to be abl to manually write variable data".
//
// CHOOSE AN EMPLOYEE opens the same paper editor the page has always opened — same route, same
// renderer, same free typing on the page — so a paper reached through a folder cannot print
// differently from one reached through the package tabs below. TYPE IT IN draws the same paper from
// typed values instead (manual-paper-workspace.tsx).
//
// PRINT FOR MANY is the owner's later ask (2026-10-04): the same paper for 15, 20, 30 employees in one
// go. It is a third way to fill the same paper, not a separate screen — see bulk-print-panel.tsx.
//
// THE EMPLOYEE LIST FOLLOWS THE PAPER. A leaving paper lists leavers only — the bug the owner
// reported — and the rule lives in `candidatesForDocument`, not here, so it is tested once.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Hash,
  Keyboard,
  Loader2,
  Printer,
  Lock,
  UserRound,
  UserX,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { PAPER_ISSUED_EVENT } from "@/components/hiring-pack/issue-paper-reference";
import { BulkPrintPanel } from "@/components/hiring-pack/bulk-print-panel";
import { ManualPaperWorkspace } from "@/components/hiring-pack/manual-paper-workspace";
import type { StoredTemplate } from "@/components/hiring-pack/use-company-templates";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  buildFormsDrive,
  candidateOptionLabel,
  candidatesForDocument,
  type FormsDriveEntry,
  type FormsDriveFolderId,
} from "@/lib/hiring-pack/forms-drive";
import type { HiringPackCandidate } from "@/lib/hiring-pack/types";

type FillMode = "employee" | "bulk" | "manual";

const FILL_MODES: ReadonlyArray<{ label: string; value: FillMode }> = [
  { label: "Choose an employee", value: "employee" },
  { label: "Print for many", value: "bulk" },
  { label: "Type it in", value: "manual" },
];

/** One register row as the register route returns it. Mirrors `PaperIssue` without importing a server module. */
type RegisterRow = {
  reference: string;
  documentLabel: string;
  subjectName: string | null;
  mode: "employee" | "manual";
  copies: number;
  issuedByName: string | null;
  issuedAt: string;
};

type Props = {
  candidates: HiringPackCandidate[];
  templates: StoredTemplate[];
  /** The employee whose pack is loaded on the page, if any. */
  selectedHrId: string;
  loadingEmployee: boolean;
  onOpenForEmployee: (entry: FormsDriveEntry, hrId: string) => void;
  /**
   * The papers this viewer is limited to, or null/absent for every paper — see `buildFormsDrive`.
   * The register at the foot is filtered the same way by its own route.
   */
  paperScope?: readonly string[] | null;
};

function formatIssuedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return formatStableEnGb(parsed, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

function AudienceBadges({ entry }: { entry: FormsDriveEntry }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {entry.audience === "departed" ? (
        <span className="inline-flex items-center gap-1 border border-amber-200 bg-amber-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.1em] text-amber-800">
          <UserX className="h-3 w-3" /> Leavers only
        </span>
      ) : null}
      {entry.numberOnFace ? null : (
        <span className="inline-flex items-center gap-1 border border-phx-line bg-slate-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-600">
          <Lock className="h-3 w-3" /> Official form · number kept in the register
        </span>
      )}
    </span>
  );
}

export function FormsDrive({
  candidates,
  templates,
  selectedHrId,
  loadingEmployee,
  onOpenForEmployee,
  paperScope = null,
}: Props) {
  const folders = useMemo(() => buildFormsDrive(templates, paperScope), [templates, paperScope]);
  const groups = useMemo(() => {
    const byDocument: Record<string, string> = {};
    for (const template of templates) byDocument[template.document] = template.group;
    return byDocument;
  }, [templates]);

  const [folderId, setFolderId] = useState<FormsDriveFolderId | null>(null);
  const [openDocument, setOpenDocument] = useState<string | null>(null);
  const [mode, setMode] = useState<FillMode>("employee");

  const folder = folders.find((candidate) => candidate.id === folderId) ?? null;
  const entry = folder?.entries.find((candidate) => candidate.document === openDocument) ?? null;

  // NO `keepHrId` HERE, on purpose: on the drive the list is the fix itself. A current employee
  // still loaded from an earlier paper must not ride along into a resignation's list.
  const offered = entry ? candidatesForDocument(candidates, entry.document, groups) : [];
  const pickedHrId = offered.some((candidate) => candidate.hrId === selectedHrId) ? selectedHrId : "";
  const pickedName = offered.find((candidate) => candidate.hrId === pickedHrId)?.fullName ?? null;

  return (
    <AdminTableShell
      description="Open a folder, press the paper you need, then fill it from an employee's record, print it for many employees at once, or type the details in. Every print is numbered."
      title="HR Forms drive"
    >
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        <nav aria-label="Where you are in the drive" className="flex flex-wrap items-center gap-1 text-sm font-semibold">
          <button
            className={folder ? "text-phx-accent-press hover:underline" : "text-phx-ink"}
            onClick={() => {
              setFolderId(null);
              setOpenDocument(null);
            }}
            type="button"
          >
            All folders
          </button>
          {folder ? (
            <>
              <ChevronRight className="h-4 w-4 text-phx-ink-faint" />
              <button
                className={entry ? "text-phx-accent-press hover:underline" : "text-phx-ink"}
                onClick={() => setOpenDocument(null)}
                type="button"
              >
                {folder.labelEn}
              </button>
            </>
          ) : null}
          {entry ? (
            <>
              <ChevronRight className="h-4 w-4 text-phx-ink-faint" />
              <span className="text-phx-ink">{entry.label}</span>
            </>
          ) : null}
        </nav>

        {!folder ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {folders.map((candidate) => (
              <button
                className="flex min-w-0 items-start gap-3 border border-phx-line bg-white px-4 py-4 text-left transition hover:border-orange-300 hover:bg-orange-50/40 focus:outline-none focus:ring-2 focus:ring-orange-200"
                key={candidate.id}
                onClick={() => {
                  setFolderId(candidate.id);
                  setOpenDocument(null);
                }}
                type="button"
              >
                <Folder className="mt-0.5 h-6 w-6 shrink-0 text-phx-accent-press" />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-black text-phx-ink">{candidate.labelEn}</span>
                    <span className="text-sm font-semibold text-phx-ink-soft" dir="rtl">
                      {candidate.labelAr}
                    </span>
                  </span>
                  <span className="text-phx-xs text-phx-ink-soft">{candidate.description}</span>
                  <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                    {candidate.entries.length === 1 ? "1 paper" : `${candidate.entries.length} papers`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {folder && !entry ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
              <FolderOpen className="h-4 w-4 text-phx-accent-press" />
              {folder.labelEn}
            </div>
            {folder.entries.length === 0 ? (
              <p className="border border-phx-line bg-slate-50 px-4 py-3 text-sm text-phx-ink-soft">
                No papers here yet. A paper uploaded in the Template Studio at the foot of this page, and
                filed under no package, appears in this folder.
              </p>
            ) : (
              <ul className="flex flex-col border border-phx-line">
                {folder.entries.map((item) => (
                  <li className="border-b border-phx-line last:border-b-0" key={item.document}>
                    <button
                      className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left transition hover:bg-orange-50/40 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-orange-200"
                      onClick={() => {
                        setOpenDocument(item.document);
                        setMode("employee");
                      }}
                      type="button"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-phx-ink-soft" />
                      <span className="min-w-0 flex-1 text-sm font-semibold text-phx-ink">{item.label}</span>
                      <AudienceBadges entry={item} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {entry ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <FileText className="h-5 w-5 text-phx-accent-press" />
              <h3 className="text-base font-black text-phx-ink">{entry.label}</h3>
              <AudienceBadges entry={entry} />
            </div>

            <ChoiceGroup
              aria-label="How to fill this paper"
              className="grid-cols-3"
              onChange={setMode}
              options={FILL_MODES}
              value={mode}
            />

            {mode === "employee" ? (
              <div className="flex flex-col gap-3">
                {entry.audience === "departed" ? (
                  <p className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <UserX className="mt-0.5 h-4 w-4 shrink-0" />
                    This is a leaving paper, so only people who have left are listed.
                  </p>
                ) : null}
                <label
                  className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft"
                  htmlFor="forms-drive-employee"
                >
                  <UserRound className="h-4 w-4 text-phx-accent-press" />
                  Employee
                </label>
                <SearchableSelect
                  className="h-10 w-full text-sm"
                  disabled={loadingEmployee}
                  id="forms-drive-employee"
                  key={entry.document}
                  onValueChange={(value) => {
                    if (value) onOpenForEmployee(entry, value);
                  }}
                  placeholder={
                    entry.audience === "departed"
                      ? "Search leavers by HR ID, name, job title or the date they left"
                      : "Search by HR ID, name or job title"
                  }
                  value={pickedHrId}
                >
                  <option value="">Select an employee</option>
                  {offered.map((candidate) => (
                    <option key={candidate.hrId} value={candidate.hrId}>
                      {candidateOptionLabel(candidate)}
                    </option>
                  ))}
                </SearchableSelect>
                <div className="flex flex-wrap items-center gap-3">
                  {pickedHrId ? (
                    <Button
                      className="gap-2"
                      disabled={loadingEmployee}
                      onClick={() => onOpenForEmployee(entry, pickedHrId)}
                      type="button"
                    >
                      <FileText className="h-4 w-4" />
                      Open {pickedName ? `${pickedName}'s` : "the"} paper
                    </Button>
                  ) : null}
                  {loadingEmployee ? (
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-phx-ink-soft">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading their details
                    </span>
                  ) : (
                    <span className="text-sm text-phx-ink-soft">
                      The paper opens below with their details filled in. You can still type over anything on it.
                    </span>
                  )}
                </div>
              </div>
            ) : mode === "bulk" ? (
              <div className="flex flex-col gap-3">
                <p className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
                  <Printer className="h-4 w-4 text-phx-accent-press" />
                  One paper, many employees
                </p>
                {entry.audience === "departed" ? (
                  <p className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <UserX className="mt-0.5 h-4 w-4 shrink-0" />
                    This is a leaving paper, so only people who have left are listed.
                  </p>
                ) : null}
                <BulkPrintPanel
                  candidates={offered}
                  defaultCopies={templates.find((template) => template.id === entry.versionId)?.defaultCopies}
                  entry={entry}
                  key={entry.document}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
                  <Keyboard className="h-4 w-4 text-phx-accent-press" />
                  Typed in by hand
                </p>
                <ManualPaperWorkspace entry={entry} group={groups[entry.document]} key={entry.document} />
              </div>
            )}
          </div>
        ) : null}

        <PaperRegister />
      </div>
    </AdminTableShell>
  );
}

async function fetchRegister(): Promise<{ ready: boolean; rows: RegisterRow[] } | null> {
  try {
    const response = await fetch("/api/hiring-pack/paper-register", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { issues?: RegisterRow[]; ready?: boolean };
    return { ready: body.ready === true, rows: body.issues ?? [] };
  } catch {
    return null;
  }
}

/** The latest numbers issued — which paper, for whom, by whom, when (Cairo time). */
function PaperRegister() {
  const [state, setState] = useState<{ ready: boolean; rows: RegisterRow[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      void fetchRegister().then((result) => {
        if (!live) return;
        if (result) {
          setState(result);
          setFailed(false);
        } else {
          setFailed(true);
        }
      });
    load();
    window.addEventListener(PAPER_ISSUED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(PAPER_ISSUED_EVENT, load);
    };
  }, []);

  return (
    <div className="flex flex-col gap-2 border-t border-phx-line pt-4">
      <p className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
        <Hash className="h-4 w-4 text-phx-accent-press" />
        Paper register · latest numbers
      </p>
      {failed ? (
        <p className="text-sm text-rose-700">The register could not be read just now.</p>
      ) : state === null ? (
        <p className="inline-flex items-center gap-2 text-sm text-phx-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the register
        </p>
      ) : !state.ready ? (
        <p className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The paper register is not set up in the database yet. Papers still print, but without a number,
          until it is.
        </p>
      ) : state.rows.length === 0 ? (
        <p className="text-sm text-phx-ink-soft">No paper has been numbered yet. The first print takes HR-{new Date().getFullYear()}-000001.</p>
      ) : (
        <>
          <table className="hidden w-full table-fixed text-sm md:table">
            <colgroup>
              <col className="w-[17%]" />
              <col className="w-[27%]" />
              <col className="w-[22%]" />
              <col className="w-[16%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-phx-line text-left text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                <th className="px-2 py-2">Number</th>
                <th className="px-2 py-2">Paper</th>
                <th className="px-2 py-2">Issued to</th>
                <th className="px-2 py-2">Printed by</th>
                <th className="px-2 py-2">When (Cairo)</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr className="border-b border-phx-line align-top" key={row.reference}>
                  <td className="break-words px-2 py-2 font-mono text-phx-xs font-bold text-phx-ink">{row.reference}</td>
                  <td className="break-words px-2 py-2 text-phx-ink">
                    {row.documentLabel}
                    <span className="block text-phx-2xs text-phx-ink-faint">
                      {row.copies === 1 ? "1 copy" : `${row.copies} copies`}
                    </span>
                  </td>
                  <td className="break-words px-2 py-2 text-phx-ink">
                    {row.subjectName ?? "No name given"}
                    <span className="block text-phx-2xs text-phx-ink-faint">
                      {row.mode === "manual" ? "Typed in by hand" : "From the employee record"}
                    </span>
                  </td>
                  <td className="break-words px-2 py-2 text-phx-ink-soft">{row.issuedByName ?? "Not recorded"}</td>
                  <td className="break-words px-2 py-2 text-phx-ink-soft">{formatIssuedAt(row.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="flex flex-col gap-2 md:hidden">
            {state.rows.map((row) => (
              <li className="border border-phx-line bg-white px-3 py-2 text-sm" key={row.reference}>
                <p className="font-mono text-phx-xs font-bold text-phx-ink">{row.reference}</p>
                <p className="break-words text-phx-ink">{row.documentLabel}</p>
                <p className="break-words text-phx-ink-soft">
                  {row.subjectName ?? "No name given"} ·{" "}
                  {row.mode === "manual" ? "typed in by hand" : "from the employee record"}
                </p>
                <p className="break-words text-phx-2xs text-phx-ink-faint">
                  {row.issuedByName ?? "Printer not recorded"} · {formatIssuedAt(row.issuedAt)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
