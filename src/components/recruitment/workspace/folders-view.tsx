"use client";

// Recruitment workspace — the new Folders tab (owner, 20 Oct 2026: "retire them all but make a tab
// called Folders … a better one").
//
//   • HIS FOLDER TREE: create, rename, nest, move and delete, all inside the page, with counts. Every
//     change is a confirm IN the tree, never a browser dialog, and goes through the existing
//     /api/recruitment/cv-folders routes, so the rules (depth, unique names, no deleting a folder that
//     still holds CVs) are the ones the server already keeps. A refusal is shown in its own words.
//   • A READ-ONLY "MANAGERS' FOLDERS": what sits on each manager's shelf, area by area. Nothing here
//     changes a manager's shelf — that is the send itself.
//   • The CVs inside a chosen folder are the workspace's own rows and opened CV, drawn by the caller.
//
// Counts are DISTINCT people under a folder (`totalCount`): copy is a first-class action, so the same
// person can sit in a parent and its child, and a sum would claim 12 CVs where there are 11 people.

import { ChevronRight, FolderClosed, FolderOpen, FolderPlus, Loader2, MoveRight, PenLine, Trash2, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import { adminChipDepthClassName, adminPanelDepthClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { deleteRequest, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { cvDangerButton, cvDarkButton, cvGhostButton } from "@/components/recruitment/workspace/cv-actions";
import { errorText } from "@/components/recruitment/workspace/workspace-format";
import { phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { MAX_CV_FOLDER_DEPTH, collectCvFolderSubtreeIds, flattenCvFolderTree, type CvFolderNode } from "@/lib/recruitment/cv-folder-tree";
import { cn } from "@/lib/utils";

/** One manager's shelf as the Folders tab reads it — names only, fenced on the server. */
export type ManagerShelfView = {
  seatId: string;
  managerName: string | null;
  seatLabel: string;
  lineName: string | null;
  regionName: string | null;
  candidateCount: number;
  folders: { areaName: string; candidates: { id: string; name: string }[] }[];
};

type Editing =
  | { kind: "create"; parentId: string | null }
  | { kind: "rename"; folderId: string }
  | { kind: "move"; folderId: string }
  | { kind: "delete"; folderId: string };

function InlineForm({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5 py-1.5 pl-6">{children}</div>;
}

function FolderRow({
  canManage,
  editing,
  node,
  onEdit,
  onSelect,
  selectedId,
  children,
}: {
  canManage: boolean;
  editing: Editing | null;
  node: CvFolderNode;
  onEdit: (editing: Editing | null) => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
  children?: ReactNode;
}) {
  const selected = node.id === selectedId;
  const busyHere = editing && "folderId" in editing && editing.folderId === node.id;
  return (
    <li>
      <div
        className={cn(
          "group flex flex-wrap items-center gap-1 border-l-2 py-1 pr-1 transition-colors",
          selected ? "border-orange-500 bg-orange-50" : "border-transparent hover:bg-slate-50",
        )}
        style={{ paddingLeft: `${(node.depth - 1) * 14 + 6}px` }}
      >
        <button
          aria-current={selected ? "true" : undefined}
          className="inline-flex min-w-0 grow items-center gap-1.5 py-1 text-left text-sm font-bold text-slate-800"
          onClick={() => onSelect(node.id)}
          type="button"
        >
          {selected ? <FolderOpen aria-hidden className="h-4 w-4 shrink-0 text-orange-600" /> : <FolderClosed aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />}
          <span className="break-words" dir="auto">
            {node.name}
          </span>
          <span className="shrink-0 text-xs font-bold tabular-nums text-slate-500">{node.totalCount}</span>
        </button>
        {canManage ? (
          <span className={cn("flex shrink-0 items-center", busyHere ? "opacity-100" : "opacity-60 group-hover:opacity-100")}>
            {node.depth < MAX_CV_FOLDER_DEPTH ? (
              <button aria-label={`New folder inside ${node.name}`} className="p-1 text-slate-500 hover:text-orange-700" onClick={() => onEdit({ kind: "create", parentId: node.id })} title="New folder inside" type="button">
                <FolderPlus aria-hidden className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <button aria-label={`Rename ${node.name}`} className="p-1 text-slate-500 hover:text-orange-700" onClick={() => onEdit({ folderId: node.id, kind: "rename" })} title="Rename" type="button">
              <PenLine aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button aria-label={`Move ${node.name}`} className="p-1 text-slate-500 hover:text-orange-700" onClick={() => onEdit({ folderId: node.id, kind: "move" })} title="Move" type="button">
              <MoveRight aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button aria-label={`Delete ${node.name}`} className="p-1 text-slate-500 hover:text-rose-700" onClick={() => onEdit({ folderId: node.id, kind: "delete" })} title="Delete" type="button">
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : null}
      </div>
      {children}
    </li>
  );
}

export function FoldersTree({
  canManage,
  onChanged,
  onSelect,
  selectedId,
  tree,
}: {
  canManage: boolean;
  /** Re-read the tree after a change (the server's distinct counts are the truth). */
  onChanged: () => Promise<void>;
  onSelect: (id: string | null) => void;
  selectedId: string | null;
  tree: readonly CvFolderNode[];
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const [parent, setParent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const flat = flattenCvFolderTree(tree);
  const total = new Set(flat.flatMap((node) => node.candidateIds)).size;

  const edit = (next: Editing | null) => {
    setProblem(null);
    setEditing(next);
    if (next?.kind === "rename") setDraft(flat.find((node) => node.id === next.folderId)?.name ?? "");
    else setDraft("");
    if (next?.kind === "move") setParent(flat.find((node) => node.id === next.folderId)?.parentId ?? "");
  };

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await onChanged();
      setEditing(null);
      setDraft("");
    } catch (error) {
      setProblem(errorText(error, "The folder change was not saved."));
    } finally {
      setBusy(false);
    }
  };

  const formFor = (node: CvFolderNode | null): ReactNode => {
    if (!editing) return null;
    const here = node ? ("folderId" in editing ? editing.folderId === node.id : editing.parentId === node.id) : editing.kind === "create" && editing.parentId === null;
    if (!here) return null;
    if (editing.kind === "create" || editing.kind === "rename") {
      const submit = () =>
        editing.kind === "create"
          ? run(() => postJson("/api/recruitment/cv-folders", { name: draft, parentId: editing.parentId }))
          : run(() => patchJson(`/api/recruitment/cv-folders/${editing.folderId}`, { name: draft }));
      return (
        <InlineForm>
          <input
            aria-label={editing.kind === "create" ? "New folder name" : "New name"}
            autoFocus
            className={cn(phxFieldClassName, "h-8 w-56 max-w-full px-2 text-sm")}
            dir="auto"
            disabled={busy}
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim()) void submit();
              if (event.key === "Escape") edit(null);
            }}
            placeholder={editing.kind === "create" ? "Folder name" : undefined}
            value={draft}
          />
          <button className={cvDarkButton} disabled={busy || !draft.trim()} onClick={() => void submit()} type="button">
            {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}
            {editing.kind === "create" ? "Create" : "Rename"}
          </button>
          <button className={cvGhostButton} disabled={busy} onClick={() => edit(null)} type="button">
            Cancel
          </button>
        </InlineForm>
      );
    }
    if (editing.kind === "move" && node) {
      const blocked = new Set(collectCvFolderSubtreeIds(flat, node.id));
      return (
        <InlineForm>
          <select aria-label="Move into" className={cn(phxSelectClassName, "h-8 w-56 max-w-full px-2 text-sm")} disabled={busy} onChange={(event) => setParent(event.target.value)} value={parent}>
            <option value="">The top level</option>
            {flat
              .filter((option) => !blocked.has(option.id))
              .map((option) => (
                <option key={option.id} value={option.id}>
                  {option.path.join(" / ")}
                </option>
              ))}
          </select>
          <button
            className={cvDarkButton}
            disabled={busy}
            onClick={() => void run(() => patchJson(`/api/recruitment/cv-folders/${node.id}`, { parentId: parent || null }))}
            type="button"
          >
            Move
          </button>
          <button className={cvGhostButton} disabled={busy} onClick={() => edit(null)} type="button">
            Cancel
          </button>
        </InlineForm>
      );
    }
    if (editing.kind === "delete" && node) {
      return (
        <InlineForm>
          <span className="text-xs font-semibold text-slate-700" dir="auto">
            {node.totalCount > 0
              ? `“${node.name}” holds ${node.totalCount} CV${node.totalCount === 1 ? "" : "s"}. Move them out first — nothing is deleted with a folder.`
              : `Delete “${node.name}”${node.children.length ? " and its empty subfolders" : ""}?`}
          </span>
          {node.totalCount === 0 ? (
            <button
              className={cvDangerButton}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await deleteRequest(`/api/recruitment/cv-folders/${node.id}`);
                  if (selectedId && collectCvFolderSubtreeIds(flat, node.id).includes(selectedId)) onSelect(null);
                })
              }
              type="button"
            >
              Delete
            </button>
          ) : null}
          <button className={cvGhostButton} disabled={busy} onClick={() => edit(null)} type="button">
            {node.totalCount > 0 ? "Close" : "Keep it"}
          </button>
        </InlineForm>
      );
    }
    return null;
  };

  const renderNodes = (nodes: readonly CvFolderNode[]): ReactNode => (
    <ul>
      {nodes.map((node) => (
        <FolderRow canManage={canManage} editing={editing} key={node.id} node={node} onEdit={edit} onSelect={(id) => onSelect(id)} selectedId={selectedId}>
          {formFor(node)}
          {node.children.length ? renderNodes(node.children) : null}
        </FolderRow>
      ))}
    </ul>
  );

  return (
    <section className={`min-w-0 border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
      <div className={cn("flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-white", adminPanelHeaderClassName)}>
        <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em]">
          <FolderOpen aria-hidden className="h-4 w-4 text-orange-300" />
          Your folders
          <span className="border border-orange-400/40 bg-orange-500/15 px-1.5 text-phx-xs font-black tabular-nums text-orange-100">{total}</span>
        </h2>
        {canManage ? (
          <button
            className="inline-flex items-center gap-1 border border-white/25 bg-white/10 px-2 py-1 text-xs font-bold text-white transition hover:bg-white/20"
            onClick={() => edit({ kind: "create", parentId: null })}
            type="button"
          >
            <FolderPlus aria-hidden className="h-3.5 w-3.5" />
            New folder
          </button>
        ) : null}
      </div>
      <div className="p-2">
        {problem ? (
          <p className="mb-2 break-words border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-bold text-rose-800" dir="auto" role="alert">
            {problem}
          </p>
        ) : null}
        {formFor(null)}
        {tree.length === 0 ? (
          <p className="px-2 py-4 text-sm font-medium text-slate-600">
            {canManage ? "No folders yet. Make one with “New folder”, then file CVs into it from any tab." : "No folders yet."}
          </p>
        ) : (
          renderNodes(tree)
        )}
        {selectedId ? (
          <button className="mt-2 px-2 text-xs font-bold text-orange-700 underline-offset-2 hover:underline" onClick={() => onSelect(null)} type="button">
            Show every folder&apos;s CVs
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function ManagersFolders({
  onLoad,
  onOpenCandidate,
  shelves,
}: {
  /** The shelves are read with the page; a visit that started on another tab loads them on request. */
  onLoad: () => void;
  onOpenCandidate: (id: string) => void;
  shelves: readonly ManagerShelfView[] | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className={`min-w-0 border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
      <div className={cn("flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-white", adminPanelHeaderClassName)}>
        <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em]">
          <Users aria-hidden className="h-4 w-4 text-orange-300" />
          Managers&apos; folders
        </h2>
        <span className="text-xs font-semibold text-slate-300">Read only — what each manager has on their shelf</span>
      </div>
      {shelves === null ? (
        <div className="p-3">
          <button className={cvGhostButton} onClick={onLoad} type="button">
            Show the managers&apos; folders
          </button>
        </div>
      ) : shelves.length === 0 ? (
        <p className="p-3 text-sm font-medium text-slate-600">No manager holds a folder with CVs in it yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {shelves.map((shelf) => {
            const expanded = open === shelf.seatId;
            return (
              <li key={shelf.seatId}>
                <button
                  aria-expanded={expanded}
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left transition hover:bg-slate-50"
                  onClick={() => setOpen(expanded ? null : shelf.seatId)}
                  type="button"
                >
                  <ChevronRight aria-hidden className={cn("h-4 w-4 shrink-0 text-slate-400 transition", expanded ? "rotate-90 text-orange-600" : null)} />
                  <span className="break-words text-sm font-black text-slate-900" dir="auto">
                    {shelf.managerName ?? "Vacant seat"}
                  </span>
                  <span className="break-words text-xs font-semibold text-slate-500" dir="auto">
                    {[shelf.seatLabel, shelf.regionName].filter(Boolean).join(" · ")}
                  </span>
                  <span className="ml-auto text-xs font-black tabular-nums text-slate-700">{`${shelf.candidateCount} CV${shelf.candidateCount === 1 ? "" : "s"}`}</span>
                </button>
                {expanded ? (
                  <div className="space-y-2 px-3 pb-3 pl-9">
                    {shelf.folders.map((folder) => (
                      <div key={folder.areaName}>
                        <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">
                          {`${folder.areaName} · ${folder.candidates.length}`}
                        </p>
                        {folder.candidates.length ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {folder.candidates.map((candidate) => (
                              <button
                                className={`border border-slate-200 bg-white px-2 py-0.5 text-xs font-bold text-slate-800 transition hover:border-orange-300 hover:text-orange-800 ${adminChipDepthClassName}`}
                                key={candidate.id}
                                onClick={() => onOpenCandidate(candidate.id)}
                                type="button"
                              >
                                <span dir="auto">{candidate.name}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-0.5 text-xs font-medium text-slate-500">Empty.</p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
