"use client";

// Recruitment workspace — the actions on ticked rows (owner, 20 Oct 2026: "bulk actions work on
// ticked rows"). The same actions, the same panels and the same 10-second Undo as one opened CV —
// the bulk routes do the work in one request where one exists (bulk-status, bulk-reject, the bulk
// send to a manager, the folder filing, ask again).
//
// It sits pinned to the bottom of the list while anything is ticked, casting its shadow UPWARD
// (`adminThumbBarDepthClassName`), so it reads as floating over the rows it acts on.

import { Archive, Check, FolderInput, MessageCircleQuestion, Send, Star, X } from "lucide-react";
import { useState } from "react";

import { adminThumbBarDepthClassName } from "@/components/admin/admin-design-tokens";
import type { ManagerPickerOption } from "@/components/recruitment/manager-picker";
import {
  FolderPanel,
  ManagerPanel,
  RejectPanel,
  cvApproveButton,
  cvDangerButton,
  cvGhostButton,
} from "@/components/recruitment/workspace/cv-actions";
import type { WorkspaceActions } from "@/components/recruitment/workspace/use-workspace-actions";
import { missingAnswerCount } from "@/components/recruitment/workspace/workspace-format";
import type { CvFolderNode } from "@/lib/recruitment/cv-folder-tree";
import type { WorkspaceRow } from "@/lib/recruitment/workspace/types";
import { cn } from "@/lib/utils";

type BulkPanel = "reject" | "manager" | "folder";

export function BulkBar({
  actions,
  allOnPageTicked,
  folders,
  managers,
  onClear,
  onTickPage,
  rows,
}: {
  actions: WorkspaceActions;
  allOnPageTicked: boolean;
  folders: readonly CvFolderNode[];
  managers: readonly ManagerPickerOption[];
  onClear: () => void;
  onTickPage: () => void;
  rows: readonly WorkspaceRow[];
}) {
  const [panel, setPanel] = useState<BulkPanel | null>(null);
  if (rows.length === 0) return null;
  const ids = rows.map((row) => row.id);
  const decidable = rows.filter((row) => row.status !== "hired");
  const askable = rows.filter((row) => row.phone && missingAnswerCount(row) > 0);
  const toggle = (next: BulkPanel) => setPanel((current) => (current === next ? null : next));
  const done = () => {
    setPanel(null);
    onClear();
  };

  return (
    <div className={cn("sticky bottom-0 z-20 space-y-2 border-t-2 border-orange-500 bg-white px-3 py-2.5 sm:px-4", adminThumbBarDepthClassName)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm font-black tabular-nums text-slate-950">{rows.length === 1 ? "1 ticked" : `${rows.length} ticked`}</span>
        <button className="mr-1 text-xs font-bold text-orange-700 underline-offset-2 hover:underline" onClick={allOnPageTicked ? onClear : onTickPage} type="button">
          {allOnPageTicked ? "Untick all" : "Tick every row shown"}
        </button>
        <button
          className={cvApproveButton}
          disabled={decidable.length === 0}
          onClick={() => {
            void actions.decide(
              decidable.map((row) => row.id),
              "shortlisted",
            );
            done();
          }}
          type="button"
        >
          <Check aria-hidden className="h-3.5 w-3.5" />
          Shortlist
        </button>
        <button
          className={cvGhostButton}
          disabled={decidable.length === 0}
          onClick={() => {
            void actions.decide(
              decidable.map((row) => row.id),
              "backup",
            );
            done();
          }}
          type="button"
        >
          <Star aria-hidden className="h-3.5 w-3.5" />
          Back-up
        </button>
        <button aria-expanded={panel === "reject"} className={cvDangerButton} disabled={decidable.length === 0} onClick={() => toggle("reject")} type="button">
          <X aria-hidden className="h-3.5 w-3.5" />
          Reject
        </button>
        <button aria-expanded={panel === "manager"} className={cvGhostButton} disabled={decidable.length === 0} onClick={() => toggle("manager")} type="button">
          <Send aria-hidden className="h-3.5 w-3.5" />
          Send to manager
        </button>
        <button aria-expanded={panel === "folder"} className={cvGhostButton} onClick={() => toggle("folder")} type="button">
          <FolderInput aria-hidden className="h-3.5 w-3.5" />
          Move to folder
        </button>
        {askable.length > 0 ? (
          <button
            className={cvGhostButton}
            disabled={actions.askAgainHold !== null}
            onClick={() => {
              actions.askAgain(askable.map((row) => row.id));
              done();
            }}
            title={actions.askAgainHold?.why ?? "Sends the approved WhatsApp template to the ticked CVs with missing answers"}
            type="button"
          >
            <MessageCircleQuestion aria-hidden className="h-3.5 w-3.5" />
            {actions.askAgainHold ? `Ask again · ${actions.askAgainHold.short}` : `Ask again (${askable.length})`}
          </button>
        ) : null}
        <button
          className={cvGhostButton}
          onClick={() => {
            void actions.archive(ids, true);
            done();
          }}
          type="button"
        >
          <Archive aria-hidden className="h-3.5 w-3.5" />
          Archive
        </button>
        <button aria-label="Untick every row" className="ml-auto p-1 text-slate-500 transition hover:text-slate-900" onClick={onClear} type="button">
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
      {panel === "reject" ? <RejectPanel actions={actions} onClose={() => setPanel(null)} onRejected={done} rows={decidable} /> : null}
      {panel === "manager" ? <ManagerPanel actions={actions} managers={managers} onClose={() => setPanel(null)} onDone={done} panelId="ws-bulk-manager" rows={decidable} /> : null}
      {panel === "folder" ? <FolderPanel actions={actions} folders={folders} onClose={() => setPanel(null)} onDone={done} rows={rows} /> : null}
    </div>
  );
}
