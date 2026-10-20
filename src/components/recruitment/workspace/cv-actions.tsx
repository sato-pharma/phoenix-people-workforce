"use client";

// Recruitment workspace — the actions on every CV (owner, 20 Oct 2026): send an offer, send to a
// manager, mark as hired, back-up, shortlist, reject, move to a folder, delete, complete the missing
// data, book the interview — plus archive, ask again on WhatsApp, and placing a person in a tab.
//
// THE RULES HE SET, AND WHERE EACH IS KEPT:
//   • send to manager is ALWAYS picked from a list — the house `ManagerPicker`, never a typed name;
//   • a rejection takes a reason from the fixed list, and the sorry message is a separate, optional
//     press that is never automatic (it opens here only after the rejection went through);
//   • delete is confirmed INSIDE the page, never in a browser dialog;
//   • the interview is booked right here — the calendar's own dialog, day, time and interviewer;
//   • "Mark as hired" asks which vacant AU seat, and shows greyed to a seat with no Employee Master
//     grant: "Only Employee Master can complete a hire".
// Every press goes through `use-workspace-actions.ts`, so each carries its 10-second Undo.
//
// Each choice opens IN the card, under the buttons — a floating menu near the edge of a narrow
// screen is how a page grows a sideways scroll. In the half-page CV (owner, 20 Oct 2026: "add the
// action buttons", in view, with page 1 of the CV whole beside the list) a choice opens as a drawer
// OVER the document instead (`panelTarget`), so the page under it never moves and the bar stays put.

import {
  Archive,
  ArchiveRestore,
  BadgeCheck,
  CalendarPlus,
  Check,
  FileSignature,
  FolderInput,
  Loader2,
  MessageCircleQuestion,
  PenLine,
  Send,
  ShieldAlert,
  Star,
  Tags,
  Trash2,
  UserCheck,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { adminControlDepthClassName, adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { FolderChoice } from "@/components/recruitment/folder-choice";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import { ManagerPicker, type ManagerPickerOption } from "@/components/recruitment/manager-picker";
import { getJson, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import type { WorkspaceActions } from "@/components/recruitment/workspace/use-workspace-actions";
import { PlacingForm } from "@/components/recruitment/workspace/placing-form";
import {
  cairoStamp,
  errorText,
  missingAnswerCount,
  placementLabel,
  placedByLabel,
} from "@/components/recruitment/workspace/workspace-format";
import {
  phxButtonApproveDenseClassName,
  phxButtonDangerDenseClassName,
  phxCheckInputClassName,
  phxCheckTileClassName,
  phxLabelTextClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { flattenCvFolderTree, type CvFolderNode } from "@/lib/recruitment/cv-folder-tree";
import { AUTOMATIC_FOLDER, foldersToOffer } from "@/lib/recruitment/folder-choice";
import { offerComposerHref } from "@/lib/recruitment/workspace/links";
import { NEEDS_PLACING, workspaceRoleTabLabels, type WorkspaceRoleTab, type WorkspaceTabKey } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspaceRow } from "@/lib/recruitment/workspace/types";
import {
  callResultLabels,
  callResults,
  rejectionReasonLabels,
  rejectionReasons,
  rejectionRefusal,
  type CallResult,
  type RejectionReason,
} from "@/lib/recruitment/workspace/vocabulary";
import { cn } from "@/lib/utils";

export type CvPanel = "reject" | "sorry" | "manager" | "hire" | "folder" | "delete" | "place";

// Lifted like every house control, and flat again when greyed — a disabled button that still floats
// reads as pressable.
const button = `inline-flex h-8 items-center justify-center gap-1.5 border px-2.5 text-xs font-bold transition disabled:pointer-events-none disabled:opacity-45 ${adminControlDepthClassName} disabled:shadow-none`;
export const cvGhostButton = cn(button, "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50");
export const cvApproveButton = cn(button, phxButtonApproveDenseClassName);
export const cvDangerButton = cn(button, phxButtonDangerDenseClassName);
export const cvDarkButton = cn(button, "border-slate-900 bg-slate-900 text-white hover:bg-slate-800");
const accentButton = cn(button, "border-orange-600 bg-orange-600 text-white hover:bg-orange-700");

function PanelBox({ children, onClose, title }: { children: ReactNode; onClose: () => void; title: string }) {
  return (
    <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex items-center justify-between gap-3 border-b border-orange-200 bg-orange-50/70 px-3 py-2">
        <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-800">{title}</p>
        <button aria-label="Close" className="p-0.5 text-slate-500 transition hover:text-slate-900" onClick={onClose} type="button">
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-3 p-3">{children}</div>
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="break-words border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-bold text-rose-800" dir="auto" role="alert">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Reject, and the sorry message after it
// ---------------------------------------------------------------------------------------------

function RejectPanel({ onClose, onRejected, rows, actions }: { actions: WorkspaceActions; onClose: () => void; onRejected: () => void; rows: readonly WorkspaceRow[] }) {
  const [reason, setReason] = useState<RejectionReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    const refusal = rejectionRefusal(reason, note);
    if (refusal || !reason) {
      setProblem(refusal ?? "Choose why this CV is rejected.");
      return;
    }
    setBusy(true);
    setProblem(null);
    const done = await actions.reject(
      rows.map((row) => row.id),
      reason,
      note.trim() || null,
    );
    setBusy(false);
    if (done) onRejected();
  };
  return (
    <PanelBox onClose={onClose} title={rows.length === 1 ? "Why is this CV rejected?" : `Why are these ${rows.length} CVs rejected?`}>
      <div className="flex flex-wrap gap-1.5" role="radiogroup">
        {rejectionReasons.map((value) => (
          <label className={cn(phxCheckTileClassName(reason === value), "gap-1.5 px-2.5 py-1.5 text-xs")} key={value}>
            <input checked={reason === value} className={phxCheckInputClassName} name="ws-reject-reason" onChange={() => setReason(value)} type="radio" />
            {rejectionReasonLabels[value]}
          </label>
        ))}
      </div>
      <label className="block">
        <span className={cn(phxLabelTextClassName, "mb-1 block")}>{reason === "other" ? "Note (needed for Other)" : "Note (optional)"}</span>
        <textarea
          className={cn(phxTextareaClassName, "min-h-[3.5rem] text-sm")}
          dir="auto"
          maxLength={300}
          onChange={(event) => setNote(event.target.value)}
          value={note}
        />
      </label>
      {problem ? <Problem>{problem}</Problem> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button className={cvDangerButton} disabled={busy || !reason} onClick={() => void submit()} type="button">
          {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <X aria-hidden className="h-3.5 w-3.5" />}
          {rows.length === 1 ? "Reject" : `Reject ${rows.length}`}
        </button>
        <span className="text-xs font-medium text-slate-500">Nothing is sent to the applicant. You can send a sorry message next.</span>
      </div>
    </PanelBox>
  );
}

function SorryPanel({ actions, onClose, row }: { actions: WorkspaceActions; onClose: () => void; row: WorkspaceRow }) {
  const [state, setState] = useState<{ loading: boolean; canSend: boolean; reason: string | null; text: string | null } | null>(null);
  const load = async () => {
    setState({ canSend: false, loading: true, reason: null, text: null });
    try {
      const data = await getJson(`/api/recruitment/candidates/${row.id}/rejection-message`);
      setState({
        canSend: data.canSend === true,
        loading: false,
        reason: typeof data.reason === "string" ? data.reason : null,
        text: typeof data.text === "string" ? data.text : null,
      });
    } catch (error) {
      setState({ canSend: false, loading: false, reason: errorText(error, "The message could not be checked."), text: null });
    }
  };
  return (
    <PanelBox onClose={onClose} title="Rejected — send a sorry message?">
      {state === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <button className={cvGhostButton} onClick={() => void load()} type="button">
            <MessageCircleQuestion aria-hidden className="h-3.5 w-3.5" />
            Check the sorry message
          </button>
          <span className="text-xs font-medium text-slate-500">Optional, and never sent on its own.</span>
        </div>
      ) : state.loading ? (
        <p className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> Checking the WhatsApp window…
        </p>
      ) : (
        <>
          {state.text ? (
            <p className={`whitespace-pre-wrap break-words border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 ${adminRecessedDepthClassName}`} dir="auto">
              {state.text}
            </p>
          ) : null}
          {state.canSend ? (
            <button
              className={accentButton}
              onClick={() => {
                actions.sendSorry(row.id);
                onClose();
              }}
              type="button"
            >
              <Send aria-hidden className="h-3.5 w-3.5" />
              Send the sorry message
            </button>
          ) : (
            <Problem>{state.reason ?? "It cannot be sent now."}</Problem>
          )}
        </>
      )}
    </PanelBox>
  );
}

// ---------------------------------------------------------------------------------------------
// Send to a manager
// ---------------------------------------------------------------------------------------------

export function ManagerPanel({
  actions,
  managers,
  onClose,
  onDone,
  panelId,
  rows,
}: {
  actions: WorkspaceActions;
  managers: readonly ManagerPickerOption[];
  onClose: () => void;
  /** After the send is queued (defaults to closing). */
  onDone?: () => void;
  panelId: string;
  rows: readonly WorkspaceRow[];
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [folder, setFolder] = useState(AUTOMATIC_FOLDER);
  const manager = managers.find((option) => option.hrId === chosen[0]) ?? null;
  const shelf = foldersToOffer(managers, chosen);
  return (
    <PanelBox onClose={onClose} title={rows.length === 1 ? "Send to a manager" : `Send ${rows.length} CVs to a manager`}>
      {managers.length === 0 ? (
        <Problem>The managers list could not be loaded. Reload the page and try again.</Problem>
      ) : (
        <>
          <ManagerPicker
            onChange={(ids) => {
              setChosen(ids.slice(0, 1));
              setFolder(AUTOMATIC_FOLDER);
            }}
            options={[...managers]}
            panelId={panelId}
            placeholder="Choose the manager…"
            value={chosen}
          />
          <FolderChoice folders={shelf} onChange={setFolder} value={folder} />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={accentButton}
              disabled={!manager}
              onClick={() => {
                if (!manager) return;
                actions.sendToManager(
                  rows.map((row) => row.id),
                  { hrId: manager.hrId, name: manager.name },
                  folder || null,
                );
                (onDone ?? onClose)();
              }}
              type="button"
            >
              <Send aria-hidden className="h-3.5 w-3.5" />
              {manager ? `Send to ${manager.name}` : "Send"}
            </button>
            <span className="text-xs font-medium text-slate-500">The manager is told 10 seconds after you press, so Undo can still stop it.</span>
          </div>
        </>
      )}
    </PanelBox>
  );
}

// ---------------------------------------------------------------------------------------------
// Move to a folder
// ---------------------------------------------------------------------------------------------

export function FolderPanel({
  actions,
  folders,
  onClose,
  onDone,
  rows,
}: {
  actions: WorkspaceActions;
  folders: readonly CvFolderNode[];
  onClose: () => void;
  /** After the filing (defaults to closing). */
  onDone?: () => void;
  rows: readonly WorkspaceRow[];
}) {
  const flat = flattenCvFolderTree(folders);
  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const target = flat.find((folder) => folder.id === folderId) ?? null;
  const file = async (mode: "move" | "copy") => {
    if (!target) return;
    setBusy(true);
    await actions.fileInFolder(
      rows.map((row) => row.id),
      { id: target.id, name: target.path.join(" / ") },
      mode,
    );
    setBusy(false);
    (onDone ?? onClose)();
  };
  return (
    <PanelBox onClose={onClose} title={rows.length === 1 ? "Move to a folder" : `File ${rows.length} CVs in a folder`}>
      {flat.length === 0 ? (
        <p className="text-sm font-medium text-slate-600">There are no folders yet. Make one in the Folders tab.</p>
      ) : (
        <>
          <select
            aria-label="Folder"
            className={cn(phxSelectClassName, "h-9 text-sm")}
            onChange={(event) => setFolderId(event.target.value)}
            value={folderId}
          >
            <option value="">Choose a folder…</option>
            {flat.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {`${"— ".repeat(folder.depth - 1)}${folder.name} (${folder.totalCount})`}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap items-center gap-2">
            <button className={cvDarkButton} disabled={!target || busy} onClick={() => void file("move")} type="button">
              <FolderInput aria-hidden className="h-3.5 w-3.5" />
              Move here
            </button>
            <button className={cvGhostButton} disabled={!target || busy} onClick={() => void file("copy")} type="button">
              Copy here too
            </button>
            <span className="text-xs font-medium text-slate-500">Move takes it out of its other folders; copy keeps them.</span>
          </div>
        </>
      )}
    </PanelBox>
  );
}

// ---------------------------------------------------------------------------------------------
// Mark as hired — which vacant AU seat
// ---------------------------------------------------------------------------------------------

function HirePanel({ onClose, row }: { onClose: () => void; row: WorkspaceRow }) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "ready"; canHire: boolean; reason: string | null; seats: { vacancyId: string; label: string }[]; offerHref: string | null }
    | { phase: "failed"; message: string }
  >({ phase: "idle" });
  const [seat, setSeat] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = async () => {
    setState({ phase: "loading" });
    try {
      const data = await getJson(`/api/recruitment/candidates/${row.id}/hire`);
      setState({
        canHire: data.canHire === true,
        offerHref: typeof data.offerHref === "string" ? data.offerHref : null,
        phase: "ready",
        reason: typeof data.reason === "string" ? data.reason : null,
        seats: Array.isArray(data.seats) ? (data.seats as { vacancyId: string; label: string }[]) : [],
      });
    } catch (error) {
      setState({ message: errorText(error, "The vacant seats could not be loaded."), phase: "failed" });
    }
  };

  const open = async () => {
    if (!seat) return;
    setOpening(true);
    setProblem(null);
    try {
      const data = await postJson(`/api/recruitment/candidates/${row.id}/hire`, { vacancyId: seat });
      if (typeof data.href !== "string") throw new Error("The hire could not be started.");
      window.location.assign(data.href);
    } catch (error) {
      setProblem(errorText(error, "The hire could not be started."));
      setOpening(false);
    }
  };

  return (
    <PanelBox onClose={onClose} title="Mark as hired — which seat?">
      {state.phase === "idle" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button className={cvDarkButton} onClick={() => void load()} type="button">
            <UserCheck aria-hidden className="h-3.5 w-3.5" />
            Show the vacant seats
          </button>
          <span className="text-xs font-medium text-slate-500">You finish the hire in Employee Master; the seat and its requisition close when you save.</span>
        </div>
      ) : state.phase === "loading" ? (
        <p className="flex items-center gap-2 text-xs font-semibold text-slate-600">
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> Reading the vacant AU seats…
        </p>
      ) : state.phase === "failed" ? (
        <Problem>{state.message}</Problem>
      ) : !state.canHire ? (
        <Problem>{state.reason ?? "This CV cannot be hired from here."}</Problem>
      ) : (
        <>
          {state.offerHref ? (
            <a className={cvGhostButton} href={state.offerHref}>
              <FileSignature aria-hidden className="h-3.5 w-3.5" />
              Hire from the accepted offer
            </a>
          ) : null}
          {state.seats.length === 0 ? (
            <p className="text-sm font-medium text-slate-600">{state.reason ?? "No vacant seat fits this CV right now."}</p>
          ) : (
            <div className="flex flex-col gap-1.5" role="radiogroup">
              {state.seats.map((option) => (
                <label className={cn(phxCheckTileClassName(seat === option.vacancyId), "px-2.5 py-2 text-sm")} key={option.vacancyId}>
                  <input
                    checked={seat === option.vacancyId}
                    className={phxCheckInputClassName}
                    name="ws-hire-seat"
                    onChange={() => setSeat(option.vacancyId)}
                    type="radio"
                  />
                  <span className="break-words" dir="auto">
                    {option.label}
                  </span>
                </label>
              ))}
            </div>
          )}
          {problem ? <Problem>{problem}</Problem> : null}
          {state.seats.length > 0 ? (
            <button className={cvApproveButton} disabled={!seat || opening} onClick={() => void open()} type="button">
              {opening ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck aria-hidden className="h-3.5 w-3.5" />}
              Open Add Employee for this seat
            </button>
          ) : null}
        </>
      )}
    </PanelBox>
  );
}

// ---------------------------------------------------------------------------------------------
// Place in a tab (by hand — marked "added by HR")
// ---------------------------------------------------------------------------------------------

function PlacePanel({
  actions,
  onClose,
  roleTabs,
  row,
  viewerName,
  viewingTab,
}: {
  actions: WorkspaceActions;
  onClose: () => void;
  roleTabs: readonly WorkspaceRoleTab[];
  row: WorkspaceRow;
  viewerName: string | null;
  viewingTab: WorkspaceTabKey | null;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const takeOut = async (roleTab: WorkspaceRoleTab) => {
    setBusy(true);
    setProblem(null);
    try {
      await actions.place(row, { remove: true, roleTab });
    } catch (error) {
      setProblem(errorText(error, "The CV was not taken out of that tab."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelBox onClose={onClose} title={row.placements.length ? "Tabs — and place it again" : "Place this candidate"}>
      {row.placements.length > 0 ? (
        <ul className="space-y-1">
          {row.placements.map((placement) => (
            <li className="flex flex-wrap items-center gap-2 text-sm" key={placement.tab}>
              <span className="font-bold text-slate-900" dir="auto">
                {placementLabel(placement)}
              </span>
              <span className="text-xs font-medium text-slate-500">{placedByLabel(placement)}</span>
              <button
                className="text-xs font-bold text-rose-700 underline-offset-2 hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={() => void takeOut(placement.tab)}
                type="button"
              >
                Take out
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm font-medium text-slate-600">Not in any tab yet — the applicant&apos;s reply did not say which role.</p>
      )}
      {problem ? <Problem>{problem}</Problem> : null}
      <PlacingForm
        actions={actions}
        editorName={viewerName}
        framed={false}
        key={row.id}
        leaves={viewingTab === NEEDS_PLACING && row.placements.length === 0}
        onPlaced={onClose}
        roleTabs={roleTabs}
        row={row}
      />
    </PanelBox>
  );
}

// ---------------------------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------------------------

export function CvActions({
  actions,
  canDelete,
  canHire,
  canWork,
  folders,
  managers,
  onCompleteMissing,
  onPanel,
  panel,
  panelTarget = null,
  roleTabs,
  row,
  showCallResult = false,
  today = "",
  viewerName = null,
  viewingTab,
}: {
  actions: WorkspaceActions;
  canDelete: boolean;
  canHire: boolean;
  canWork: boolean;
  folders: readonly CvFolderNode[];
  managers: readonly ManagerPickerOption[];
  onCompleteMissing: () => void;
  onPanel: (panel: CvPanel | null) => void;
  panel: CvPanel | null;
  /** Open each choice as a drawer in this element (over the CV) instead of under the bar. */
  panelTarget?: HTMLElement | null;
  roleTabs: readonly WorkspaceRoleTab[];
  row: WorkspaceRow;
  /** The one-tap call results as a "Call result" drop-down in the bar (the half-page CV). */
  showCallResult?: boolean;
  /** Today in Cairo, for "Last call · 19 Oct". */
  today?: string;
  /** The reader's own name, for a call or an answer they record. */
  viewerName?: string | null;
  viewingTab: WorkspaceTabKey | null;
}) {
  if (!canWork) {
    return (
      <p className={`flex items-start gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 ${adminRecessedDepthClassName}`}>
        <ShieldAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
        You read the workspace. Decisions, sends and filing are made by Talent Acquisition and the Super Admin.
      </p>
    );
  }
  const toggle = (next: CvPanel) => onPanel(panel === next ? null : next);
  const missing = missingAnswerCount(row);
  const tabPlacement = row.placements.find((placement) => placement.tab === viewingTab) ?? row.placements[0] ?? null;
  const offerHref = offerComposerHref(row.id, null, tabPlacement?.tab ?? null, tabPlacement?.botRoleFamily ?? null);
  const hired = row.status === "hired";
  const panelBody = (
    <>
      {panel === "reject" ? (
        <RejectPanel actions={actions} onClose={() => onPanel(null)} onRejected={() => onPanel("sorry")} rows={[row]} />
      ) : null}
      {panel === "sorry" ? <SorryPanel actions={actions} onClose={() => onPanel(null)} row={row} /> : null}
      {panel === "manager" ? (
        <ManagerPanel actions={actions} managers={managers} onClose={() => onPanel(null)} panelId={`ws-manager-${row.id}`} rows={[row]} />
      ) : null}
      {panel === "folder" ? <FolderPanel actions={actions} folders={folders} onClose={() => onPanel(null)} rows={[row]} /> : null}
      {panel === "hire" ? <HirePanel onClose={() => onPanel(null)} row={row} /> : null}
      {panel === "place" ? (
        <PlacePanel actions={actions} onClose={() => onPanel(null)} roleTabs={roleTabs} row={row} viewerName={viewerName} viewingTab={viewingTab} />
      ) : null}
      {panel === "delete" ? (
        <PanelBox onClose={() => onPanel(null)} title="Delete this CV for good?">
          <p className="text-sm font-medium text-slate-700" dir="auto">
            {`${row.name} — the record, its files and its history are removed. It is deleted 10 seconds after you press, so Undo can still stop it.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={cvDangerButton}
              onClick={() => {
                actions.remove(row.id);
                onPanel(null);
              }}
              type="button"
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
              Delete for good
            </button>
            <button className={cvGhostButton} onClick={() => onPanel(null)} type="button">
              Keep it
            </button>
          </div>
        </PanelBox>
      ) : null}
    </>
  );
  const lastCall = row.latestCall ? `Last call: ${callResultLabels[row.latestCall.result]} · ${cairoStamp(row.latestCall.at, today)}` : null;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {showCallResult ? (
          <select
            aria-label="Call result"
            className={cn(phxSelectClassName, "h-8 w-auto max-w-full px-2 text-xs font-bold")}
            onChange={(event) => {
              const result = event.target.value as CallResult | "";
              if (result) actions.callResult(row.id, result, null, viewerName);
              // Let go of the drop-down: left focused, its own arrow keys would log another call on this
              // CV when ↓ is pressed for the next one.
              event.currentTarget.blur();
            }}
            title={lastCall ?? "Record how the call went"}
            value=""
          >
            <option value="">{row.latestCall ? `Call · ${callResultLabels[row.latestCall.result]}` : "Call result…"}</option>
            {callResults.map((result) => (
              <option key={result} value={result}>
                {callResultLabels[result]}
              </option>
            ))}
          </select>
        ) : null}
        <button
          className={cvApproveButton}
          disabled={hired || row.status === "shortlisted"}
          onClick={() => void actions.decide([row.id], "shortlisted")}
          title="Shortlist (S)"
          type="button"
        >
          <Check aria-hidden className="h-3.5 w-3.5" />
          Shortlist
        </button>
        <button
          className={cvGhostButton}
          disabled={hired || row.status === "backup"}
          onClick={() => void actions.decide([row.id], "backup")}
          title="Back-up (B)"
          type="button"
        >
          <Star aria-hidden className="h-3.5 w-3.5" />
          Back-up
        </button>
        <button
          aria-expanded={panel === "reject"}
          className={cvDangerButton}
          disabled={hired || row.status === "rejected"}
          onClick={() => toggle("reject")}
          title="Reject (R)"
          type="button"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
          Reject
        </button>
        <span aria-hidden className="mx-0.5 h-6 w-px bg-slate-200" />
        <button aria-expanded={panel === "manager"} className={cvGhostButton} disabled={hired} onClick={() => toggle("manager")} title="Send to a manager (M)" type="button">
          <Send aria-hidden className="h-3.5 w-3.5" />
          Send to manager
        </button>
        <ScheduleInterviewButton
          candidate={{ id: row.id, jobTitle: tabPlacement ? workspaceRoleTabLabels[tabPlacement.tab] : null, name: row.name }}
          onSaved={(booking) => actions.booked(row.id, booking)}
          renderTrigger={({ open, title }) => (
            <button className={cvGhostButton} disabled={hired} onClick={open} title={title} type="button">
              <CalendarPlus aria-hidden className="h-3.5 w-3.5" />
              Book interview
            </button>
          )}
        />
        <a className={cvGhostButton} href={offerHref} rel="noopener" target="_blank">
          <FileSignature aria-hidden className="h-3.5 w-3.5" />
          Send an offer
        </a>
        <button
          aria-expanded={panel === "hire"}
          className={cvGhostButton}
          disabled={!canHire || hired}
          onClick={() => toggle("hire")}
          title={canHire ? "Mark as hired" : "Only Employee Master can complete a hire"}
          type="button"
        >
          <UserCheck aria-hidden className="h-3.5 w-3.5" />
          {hired ? "Hired" : "Mark as hired"}
        </button>
        <span aria-hidden className="mx-0.5 h-6 w-px bg-slate-200" />
        <button aria-expanded={panel === "folder"} className={cvGhostButton} onClick={() => toggle("folder")} type="button">
          <FolderInput aria-hidden className="h-3.5 w-3.5" />
          Move to folder
        </button>
        <button aria-expanded={panel === "place"} className={cvGhostButton} onClick={() => toggle("place")} type="button">
          <Tags aria-hidden className="h-3.5 w-3.5" />
          {row.placements.length ? "Tabs" : "Place in a tab"}
        </button>
        {missing > 0 ? (
          <>
            <button className={cvGhostButton} onClick={onCompleteMissing} type="button">
              <PenLine aria-hidden className="h-3.5 w-3.5" />
              {`Complete missing (${missing})`}
            </button>
            {row.phone ? (
              <button
                className={cvGhostButton}
                disabled={actions.askAgainHold !== null}
                onClick={() => actions.askAgain([row.id])}
                title={actions.askAgainHold?.why ?? "Sends the approved WhatsApp template; the bot asks only what is missing"}
                type="button"
              >
                <MessageCircleQuestion aria-hidden className="h-3.5 w-3.5" />
                {actions.askAgainHold ? `Ask again · ${actions.askAgainHold.short}` : "Ask again on WhatsApp"}
              </button>
            ) : null}
          </>
        ) : null}
        <button className={cvGhostButton} onClick={() => void actions.archive([row.id], !row.archivedAt)} type="button">
          {row.archivedAt ? <ArchiveRestore aria-hidden className="h-3.5 w-3.5" /> : <Archive aria-hidden className="h-3.5 w-3.5" />}
          {row.archivedAt ? "Bring back" : "Archive"}
        </button>
        {canDelete ? (
          <button
            aria-expanded={panel === "delete"}
            className={cn(cvGhostButton, "border-rose-200 text-rose-700 hover:border-rose-400 hover:bg-rose-50")}
            onClick={() => toggle("delete")}
            type="button"
          >
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
            Delete
          </button>
        ) : null}
      </div>

      {panel && panelTarget ? createPortal(<div className="p-2">{panelBody}</div>, panelTarget) : panelBody}
    </div>
  );
}

export { RejectPanel };

/** Writes the star (no undo — a star is a working opinion, not a decision). */
export async function saveRating(candidateId: string, rating: number | null): Promise<void> {
  await patchJson(`/api/recruitment/candidates/${candidateId}/rating`, { rating });
}
