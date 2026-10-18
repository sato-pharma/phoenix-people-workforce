"use client";

// Recruitment / ATS — the folder tree a recruiter builds by hand, as a screen.
//
// Owner, 2026-09-12: "in /recruitment i want 2 be able to do a folder and subfolder and push cvs
// their and move them copy or paste to another folder".
//
// ── WHY THIS SITS BESIDE THE FOUR SHELVES AND NOT INSTEAD OF THEM ───────────────────────────────
//
// The shelves above it (candidate-folders-tab.tsx) are DERIVED: one folder per area, per region, per
// job title, so they cannot drift from the Organogram and nobody has to maintain them. Nothing there
// nests and nothing there can be created. This is the opposite — every folder is somebody's own
// decision — and the two answer different questions, so they share the tab and not the mechanism.
//
// ── THE LAYOUT, AND WHY IT IS TWO PANES AND NOT A TREE WITH INLINE BUTTONS ──────────────────────
//
// A row carrying a name, a count, and five action buttons cannot fit a 375px phone, and the
// fits-the-screen golden rule forbids solving that with a sideways scroll. So a row in the tree does
// ONE thing — it opens — and every action lives in the open folder's own header, where there is a
// full line to put it on. On desktop the two panes sit side by side; on a phone they stack, tree
// first, which is the order somebody navigates in.
//
// ── SELECTION IS PER FOLDER, AND CLEARED WHEN THE FOLDER CHANGES ────────────────────────────────
//
// A tick that survives navigating to another folder is how "move the 3 I picked" moves 3 people the
// recruiter is no longer looking at. Cleared on every open, deliberately.

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Pencil,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";

import { deleteJson, deleteRequest, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { personLabel, UNNAMED_FILER_LABEL } from "@/lib/recruitment/person-labels";
import {
  buildCvFolderTree,
  flattenCvFolderTree,
  MAX_CV_FOLDER_DEPTH,
  type CvFolderNode,
  type CvFolderRow,
} from "@/lib/recruitment/cv-folder-tree";
import type { Candidate } from "@/lib/recruitment/types";
import { cn } from "@/lib/utils";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminPanelDepthClassName,
  adminPanelHeaderClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentPill,
  recruitmentToolbarClassName,
} from "@/components/recruitment/recruitment-premium";

/**
 * The rows and memberships, exactly as the page loaded them.
 *
 * The TREE is rebuilt here from the rows rather than passed in already built, so an optimistic local
 * change (a folder just created, a CV just moved) re-derives depth, ordering and the distinct counts
 * from one source instead of patching a nested structure in three places.
 */
export type CvFolderCabinetData = {
  rows: CvFolderRow[];
  /** folder id -> the candidate ids filed in it. */
  members: Record<string, string[]>;
};

export function CvFolderCabinet({
  candidates,
  cabinet,
  canManage,
  onOpenCandidate,
}: {
  /** The WHOLE pool, filed and unfiled — a folder's contents are resolved out of it by id. */
  candidates: readonly Candidate[];
  cabinet: CvFolderCabinetData;
  /** `candidates: update`. Without it the tree is readable and every button is absent. */
  canManage: boolean;
  onOpenCandidate: (candidateId: string) => void;
}) {
  const router = useRouter();
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [destination, setDestination] = useState("");

  const membersMap = useMemo(
    () => new Map<string, string[]>(Object.entries(cabinet.members)),
    [cabinet.members],
  );
  const tree = useMemo(() => buildCvFolderTree(cabinet.rows, membersMap), [cabinet.rows, membersMap]);
  const flat = useMemo(() => flattenCvFolderTree(tree), [tree]);
  const byId = useMemo(() => new Map(flat.map((node) => [node.id, node])), [flat]);
  const candidatesById = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.id, candidate])),
    [candidates],
  );

  /**
   * The open folder, DERIVED rather than held.
   *
   * A folder deleted here — or by somebody else in the shared tree — simply stops resolving, and the
   * right pane falls back to "pick a folder". Clearing the id in an effect would be the same outcome
   * one render later, plus a `setState` inside `useEffect`, which is a lint error in this repo.
   */
  const openFolder = openFolderId ? byId.get(openFolderId) ?? null : null;

  /** Every CV filed in this folder itself — NOT its subfolders, which have their own screens. */
  const folderCandidates = useMemo(() => {
    if (!openFolder) return [];
    const ids = membersMap.get(openFolder.id) ?? [];
    return ids
      .map((id) => candidatesById.get(id))
      .filter((candidate): candidate is Candidate => Boolean(candidate));
  }, [candidatesById, membersMap, openFolder]);

  /**
   * The CVs a recruiter can push in from here — everyone not already in THIS folder.
   *
   * Deliberately not "everyone in the pool": a CV filed in another folder is exactly what "move it
   * to another folder" is about, and hiding those would make the one action he asked for by name
   * unreachable from the screen that performs it. The list says where each one currently sits so the
   * choice is informed rather than blind.
   */
  const addable = useMemo(() => {
    if (!openFolder) return [];
    const here = new Set(membersMap.get(openFolder.id) ?? []);
    const needle = search.trim().toLowerCase();
    return candidates
      .filter((candidate) => !here.has(candidate.id))
      .filter((candidate) => {
        if (!needle) return true;
        const hay = `${candidate.fullName} ${candidate.phone ?? ""} ${candidate.email ?? ""}`.toLowerCase();
        return hay.includes(needle);
      })
      .slice(0, 40);
  }, [candidates, membersMap, openFolder, search]);

  function openFolderById(id: string | null) {
    setOpenFolderId(id);
    setSelected(new Set());
    setAdding(false);
    setSearch("");
    setError(null);
    setNotice(null);
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Run one write, then reload from the server.
   *
   * `router.refresh()` rather than patching local state, for the reason the header gives about
   * rebuilding the tree: a move changes a folder's count, its ancestors' distinct counts, the source
   * folder's contents and the pool's size at once, and four optimistic patches that each get one of
   * those right is how two numbers on one screen stop agreeing.
   */
  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  function createFolder(parentId: string | null) {
    const name = window.prompt(parentId ? "Name for the new subfolder" : "Name for the new folder");
    if (!name) return;
    void run(
      () => postJson("/api/recruitment/cv-folders", { name, parentId }),
      `Created "${name.trim()}".`,
    );
  }

  function renameFolder(node: CvFolderNode) {
    const name = window.prompt("New name for this folder", node.name);
    if (!name || name === node.name) return;
    void run(() => patchJson(`/api/recruitment/cv-folders/${node.id}`, { name }), `Renamed to "${name.trim()}".`);
  }

  function moveFolder(node: CvFolderNode, parentId: string | null) {
    void run(
      () => patchJson(`/api/recruitment/cv-folders/${node.id}`, { parentId }),
      parentId ? `Moved "${node.name}".` : `Moved "${node.name}" to the top level.`,
    );
  }

  function deleteFolder(node: CvFolderNode) {
    // The server refuses while any CV is inside, anywhere beneath — this only asks about the folder
    // itself, which is the part the recruiter is about to lose.
    if (!window.confirm(`Delete "${node.name}"? Its empty subfolders go with it.`)) return;
    void run(() => deleteRequest(`/api/recruitment/cv-folders/${node.id}`), `Deleted "${node.name}".`);
  }

  function fileCandidates(folderId: string, candidateIds: string[], mode: "move" | "copy") {
    if (candidateIds.length === 0) return;
    const target = byId.get(folderId);
    void run(
      () => postJson(`/api/recruitment/cv-folders/${folderId}/items`, { candidateIds, mode }),
      `${mode === "copy" ? "Copied" : "Moved"} ${candidateIds.length} CV${candidateIds.length === 1 ? "" : "s"} to "${target?.name ?? "the folder"}".`,
    );
    setSelected(new Set());
  }

  function takeOut(folderId: string, candidateIds: string[]) {
    if (candidateIds.length === 0) return;
    void run(
      () => deleteJson(`/api/recruitment/cv-folders/${folderId}/items`, { candidateIds }),
      `Taken out of this folder. Any copy in another folder is untouched.`,
    );
    setSelected(new Set());
  }

  function returnToPool(candidateIds: string[]) {
    if (candidateIds.length === 0) return;
    void run(
      () => postJson("/api/recruitment/cv-folders/return-to-pool", { candidateIds }),
      `Back in the pool — out of every folder.`,
    );
    setSelected(new Set());
  }

  const selectedIds = [...selected];
  const filedTotal = useMemo(
    () => new Set(Object.values(cabinet.members).flat()).size,
    [cabinet.members],
  );

  return (
    <section className={`min-w-0 border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
      {/* The cabinet's own band — the module's dark panel header, so this reads as the same kind of
          surface as every other Recruitment panel. The title, the count and the sentence wrap
          independently: the sentence is prose and must never sit at `whitespace-nowrap`. */}
      <header
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-white",
          adminPanelHeaderClassName,
        )}
      >
        <h3 className="flex items-center gap-1.5 whitespace-nowrap text-sm font-black uppercase tracking-[0.12em] text-white">
          <FolderTree className="h-4 w-4 text-orange-300" aria-hidden="true" />
          Your folders
        </h3>
        <span className="whitespace-nowrap border border-orange-400/40 bg-orange-500/15 px-1.5 py-0.5 text-phx-2xs font-black tabular-nums text-orange-100">
          {cabinet.rows.length} folder{cabinet.rows.length === 1 ? "" : "s"} · {filedTotal} CV
          {filedTotal === 1 ? "" : "s"}
        </span>
        {/* Wraps rather than sitting on one line — measured at 375px this sentence is wider than the
            phone, and the page does not scroll sideways, so a nowrap here paints the tail off the
            edge where nothing can reach it. */}
        <p className="basis-full text-xs font-medium leading-5 text-slate-300">
          Folders you make yourself, nested as deep as {MAX_CV_FOLDER_DEPTH} levels. A CV pushed here
          leaves the main pool; copying puts the same CV in a second folder.
        </p>
      </header>

      {error ? (
        <p className="border-b border-rose-200 border-l-4 border-l-rose-500 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="border-b border-emerald-200 border-l-4 border-l-emerald-500 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-700">
          {notice}
        </p>
      ) : null}

      {/* Stacked on a phone, two panes from `lg`. `minmax(0,…)` on both tracks so a long folder name
          makes the column wrap rather than forcing the grid wider than the screen. */}
      <div className="grid gap-0 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        {/* ── THE TREE ──────────────────────────────────────────────────────────────────────── */}
        <div className={`min-w-0 border-b border-slate-200 bg-slate-50/70 lg:border-b-0 lg:border-r ${adminRecessedDepthClassName}`}>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2.5">
            <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Folders</span>
            {canManage ? (
              <button
                className={`ml-auto flex items-center gap-1 border border-orange-600 bg-orange-600 px-2.5 py-1 text-[12px] font-bold text-white transition hover:bg-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                disabled={busy}
                onClick={() => createFolder(null)}
                type="button"
              >
                <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                New folder
              </button>
            ) : null}
          </div>

          {tree.length === 0 ? (
            <RecruitmentEmptyState
              icon={<FolderTree aria-hidden="true" className="h-5 w-5" />}
              message={`No folders yet. ${canManage ? "Make one and push the CVs you want to keep for later." : ""}`}
              title="An empty cabinet"
            />
          ) : (
            <ul className="space-y-0.5 p-1.5">
              {tree.map((node) => (
                <CvFolderBranch
                  expanded={expanded}
                  key={node.id}
                  node={node}
                  onOpen={openFolderById}
                  onToggle={toggleExpanded}
                  openFolderId={openFolderId}
                />
              ))}
            </ul>
          )}
        </div>

        {/* ── THE OPEN FOLDER ───────────────────────────────────────────────────────────────── */}
        <div className="min-w-0">
          {!openFolder ? (
            <RecruitmentEmptyState
              icon={<FolderOpen aria-hidden="true" className="h-5 w-5" />}
              message="Pick a folder on the left to see what is in it."
              title="No folder open"
            />
          ) : (
            <div className="min-w-0">
              <div className="border-b border-slate-200 px-4 py-3">
                {/* The full path, wrapping. A breadcrumb that truncates breaks the owner's no-ellipsis
                    rule and is also the one line that says WHICH "Cairo" this is. */}
                <p className="break-words text-[12px] font-medium text-slate-500">{openFolder.path.join(" › ")}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <h4 className="flex min-w-0 items-center gap-2 break-words text-base font-black tracking-tight text-slate-950">
                    <FolderOpen aria-hidden="true" className="h-5 w-5 flex-none text-orange-500" />
                    {openFolder.name}
                  </h4>
                  <span
                    className={`whitespace-nowrap border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-xs font-bold tabular-nums text-orange-800 ${adminChipDepthClassName}`}
                  >
                    {openFolder.directCount} here
                    {openFolder.totalCount !== openFolder.directCount
                      ? ` · ${openFolder.totalCount} with subfolders`
                      : ""}
                  </span>
                  <span className="text-[12px] text-slate-500">
                    Made by {personLabel(openFolder.createdByName, UNNAMED_FILER_LABEL)}
                  </span>
                </div>

                {canManage ? (
                  <div className={cn("mt-3", recruitmentToolbarClassName, "items-center gap-2 px-2.5 py-2 sm:px-3")}>
                    <FolderAction
                      busy={busy}
                      icon={<FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />}
                      label="New subfolder"
                      onClick={() => createFolder(openFolder.id)}
                    />
                    <FolderAction
                      busy={busy}
                      icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                      label="Rename"
                      onClick={() => renameFolder(openFolder)}
                    />
                    <FolderAction
                      busy={busy}
                      danger
                      icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                      label="Delete"
                      onClick={() => deleteFolder(openFolder)}
                    />
                    <label className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                      Move this folder into
                      {/* A native select, never shrunk — the owner's rule. `w-full sm:w-auto` lets it
                          take its own line on a phone instead of squeezing the label off screen. */}
                      <select
                        className={cn(phxSelectClassName, "sm:w-auto")}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.target.value;
                          moveFolder(openFolder, value === "__root__" ? null : value);
                        }}
                        value={openFolder.parentId ?? "__root__"}
                      >
                        <option value="__root__">Top level</option>
                        {flat
                          .filter((node) => node.id !== openFolder.id)
                          .map((node) => (
                            <option key={node.id} value={node.id}>
                              {`${"— ".repeat(node.depth - 1)}${node.name}`}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>

              {/* ── PUSH CVs IN ─────────────────────────────────────────────────────────────── */}
              {canManage ? (
                <div className="border-b border-slate-200 px-4 py-2.5">
                  <button
                    aria-expanded={adding}
                    className={cn(
                      `flex items-center gap-1 border px-2.5 py-1 text-[12px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${adminControlDepthClassName}`,
                      adding
                        ? "border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
                        : "border-orange-300 bg-white text-orange-700 hover:bg-orange-50",
                    )}
                    onClick={() => setAdding((current) => !current)}
                    type="button"
                  >
                    <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />
                    {adding ? "Done adding" : "Push CVs in here"}
                  </button>

                  {adding ? (
                    <div className="mt-2.5 space-y-2">
                      <div className="relative">
                        <Search
                          aria-hidden="true"
                          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                        />
                        <input
                          className={cn(phxFieldClassName, "pl-9")}
                          onChange={(event) => setSearch(event.target.value)}
                          placeholder="Search by name, phone or email"
                          type="search"
                          value={search}
                        />
                      </div>
                      {addable.length === 0 ? (
                        <p className="text-xs font-medium text-slate-500">
                          Nobody matches that, or everyone found is already in this folder.
                        </p>
                      ) : (
                        <ul className={`divide-y divide-slate-100 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
                          {addable.map((candidate) => {
                            const inFolders = (candidate.cvFolderIds ?? [])
                              .map((id) => byId.get(id)?.name)
                              .filter(Boolean);
                            return (
                              <li
                                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 transition-colors hover:bg-orange-50/40"
                                key={candidate.id}
                              >
                                <span className="break-words text-[13px] font-bold text-slate-900">
                                  {candidateDisplayName(candidate.fullName)}
                                </span>
                                <span className="break-words text-[12px] text-slate-500">
                                  {candidate.phone ?? candidate.email ?? ""}
                                </span>
                                {/* Where it is now, in WORDS, so a move is never blind. */}
                                {inFolders.length > 0 ? (
                                  <RecruitmentPill tone="amber">now in {inFolders.join(", ")}</RecruitmentPill>
                                ) : null}
                                <span className="ml-auto flex flex-wrap gap-1">
                                  <button
                                    className={`border border-slate-300 bg-white px-2 py-0.5 text-[12px] font-semibold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                                    disabled={busy}
                                    onClick={() => fileCandidates(openFolder.id, [candidate.id], "move")}
                                    type="button"
                                  >
                                    Move here
                                  </button>
                                  {inFolders.length > 0 ? (
                                    <button
                                      className={`flex items-center gap-1 border border-slate-300 bg-white px-2 py-0.5 text-[12px] font-semibold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                                      disabled={busy}
                                      onClick={() => fileCandidates(openFolder.id, [candidate.id], "copy")}
                                      type="button"
                                    >
                                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                      Copy here
                                    </button>
                                  ) : null}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {/* Said plainly rather than left to be discovered: the list is capped so a pool
                          of 900 does not render 900 rows into a panel. */}
                      <p className="text-[12px] text-slate-500">
                        Showing the first {addable.length} match{addable.length === 1 ? "" : "es"} — search to
                        narrow it.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* ── WHAT IS IN THE FOLDER ───────────────────────────────────────────────────── */}
              {folderCandidates.length === 0 ? (
                <RecruitmentEmptyState
                  icon={<FolderOpen aria-hidden="true" className="h-5 w-5" />}
                  message={
                    <>
                      This folder is empty.
                      {openFolder.totalCount > 0 ? " Its subfolders are not — open one on the left." : ""}
                    </>
                  }
                  title="Nothing filed here"
                />
              ) : (
                <>
                  {canManage && selectedIds.length > 0 ? (
                    <div className={`flex flex-wrap items-center gap-1.5 border-b border-orange-200 border-l-4 border-l-orange-500 bg-orange-50/70 px-3 py-2 ${adminRecessedDepthClassName}`}>
                      <span className="whitespace-nowrap text-[12px] font-black text-orange-900">
                        {selectedIds.length} picked
                      </span>
                      <label className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                        Send to
                        <select
                          className={cn(phxSelectClassName, "sm:w-auto")}
                          disabled={busy}
                          onChange={(event) => setDestination(event.target.value)}
                          value={destination}
                        >
                          <option value="">Pick a folder…</option>
                          {flat
                            .filter((node) => node.id !== openFolder.id)
                            .map((node) => (
                              <option key={node.id} value={node.id}>
                                {`${"— ".repeat(node.depth - 1)}${node.name}`}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button
                        className={`border border-slate-300 bg-white px-2 py-0.5 text-[12px] font-semibold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                        disabled={busy || !destination}
                        onClick={() => fileCandidates(destination, selectedIds, "move")}
                        type="button"
                      >
                        Move
                      </button>
                      <button
                        className={`flex items-center gap-1 border border-slate-300 bg-white px-2 py-0.5 text-[12px] font-semibold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                        disabled={busy || !destination}
                        onClick={() => fileCandidates(destination, selectedIds, "copy")}
                        type="button"
                      >
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        Copy
                      </button>
                      <button
                        className={`border border-slate-300 bg-white px-2 py-0.5 text-[12px] font-semibold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                        disabled={busy}
                        onClick={() => takeOut(openFolder.id, selectedIds)}
                        type="button"
                      >
                        Take out of this folder
                      </button>
                      <button
                        className={`flex items-center gap-1 border border-slate-300 bg-white px-2 py-0.5 text-[12px] font-semibold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                        disabled={busy}
                        onClick={() => returnToPool(selectedIds)}
                        type="button"
                      >
                        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Back to the pool
                      </button>
                    </div>
                  ) : null}

                  <ul className="divide-y divide-slate-100">
                    {folderCandidates.map((candidate) => {
                      const alsoIn = (candidate.cvFolderIds ?? [])
                        .filter((id) => id !== openFolder.id)
                        .map((id) => byId.get(id)?.name)
                        .filter(Boolean);
                      const picked = selected.has(candidate.id);
                      return (
                        <li
                          className={cn(
                            "flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 transition-colors",
                            picked ? "bg-orange-50/70" : "hover:bg-slate-50",
                          )}
                          key={candidate.id}
                        >
                          {canManage ? (
                            <input
                              aria-label={`Pick ${candidateDisplayName(candidate.fullName)}`}
                              checked={picked}
                              className="h-4 w-4 accent-orange-600"
                              onChange={() => toggleSelected(candidate.id)}
                              type="checkbox"
                            />
                          ) : null}
                          <FileText aria-hidden="true" className="h-4 w-4 flex-none text-slate-400" />
                          <button
                            className="break-words text-left text-[13px] font-bold text-slate-900 underline-offset-2 hover:text-orange-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
                            onClick={() => onOpenCandidate(candidate.id)}
                            type="button"
                          >
                            {candidateDisplayName(candidate.fullName)}
                          </button>
                          <span className="break-words text-[12px] text-slate-500">
                            {candidate.phone ?? candidate.email ?? ""}
                          </span>
                          {/* A copy says so on BOTH rows. Without this a recruiter taking somebody out
                              of one folder has no way to know they are still filed elsewhere, and the
                              pool would go on hiding them with nothing on screen explaining why. */}
                          {alsoIn.length > 0 ? (
                            <RecruitmentPill tone="amber">also in {alsoIn.join(", ")}</RecruitmentPill>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * One action button in the open folder's header — square, bordered, and the same on every row. The
 * destructive one (Delete) carries the rose line so it never reads as a neighbour of Rename.
 */
function FolderAction({
  busy,
  danger = false,
  icon,
  label,
  onClick,
}: {
  busy: boolean;
  danger?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        `flex items-center gap-1 border bg-white px-2.5 py-1 text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`,
        danger
          ? "border-rose-300 text-rose-700 hover:border-rose-400 hover:bg-rose-50"
          : "border-slate-300 text-slate-700 hover:border-orange-400 hover:text-orange-700",
      )}
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * One folder in the tree, and its children — a folder TILE: the folder mark, the name, and what it
 * really holds as a count chip. The open folder carries the orange rail and a lifted white ground,
 * so the reader always knows which folder the right-hand pane is showing.
 *
 * INDENTED WITH PADDING, NOT NESTED MARGINS, and capped: `paddingLeft` grows 12px a level to a
 * maximum, so a folder five deep still starts on screen at 375px. The fits-the-screen rule is the
 * one that decides this — a nested-margin tree grows its own width and takes the page sideways with
 * it, which is precisely the shape the rule forbids.
 */
function CvFolderBranch({
  expanded,
  node,
  onOpen,
  onToggle,
  openFolderId,
}: {
  expanded: Set<string>;
  node: CvFolderNode;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  openFolderId: string | null;
}) {
  const isOpen = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const isCurrent = openFolderId === node.id;

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1.5 border-l-[3px] py-1.5 pr-2 transition-colors",
          isCurrent
            ? `border-l-orange-500 bg-white ${adminChipDepthClassName}`
            : "border-l-transparent hover:bg-white/80",
        )}
        style={{ paddingLeft: `${Math.min(node.depth - 1, MAX_CV_FOLDER_DEPTH - 1) * 12 + 6}px` }}
      >
        {hasChildren ? (
          <button
            aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className="flex-none text-slate-400 transition hover:text-slate-700"
            onClick={() => onToggle(node.id)}
            type="button"
          >
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        ) : (
          // A spacer the width of the chevron, so names line up whether or not a folder has children.
          <span aria-hidden="true" className="h-3.5 w-3.5 flex-none" />
        )}
        <button
          aria-current={isCurrent ? "true" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400",
            isCurrent ? "font-black text-slate-950" : "font-semibold text-slate-700 hover:text-slate-950",
          )}
          onClick={() => onOpen(node.id)}
          type="button"
        >
          {isCurrent ? (
            <FolderOpen aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-orange-500" />
          ) : (
            <Folder aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-amber-500" />
          )}
          {/* Wraps. A folder somebody named "Medical Reps — Alexandria, second interview" is the one
              name a recruiter most needs to read in full, and truncating it is the owner's ellipsis
              ban as well as the thing that makes two folders look identical. */}
          <span className="min-w-0 break-words">{node.name}</span>
        </button>
        {/* The number is what the folder REALLY holds, subfolders included and counted once. A
            collapsed parent showing only its own CVs is how a folder looks empty while holding 40. */}
        <span
          className={cn(
            "whitespace-nowrap border px-1.5 py-px text-[11px] font-black tabular-nums",
            isCurrent ? "border-orange-200 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-500",
          )}
        >
          {node.totalCount}
        </span>
      </div>
      {hasChildren && isOpen ? (
        <ul className="space-y-0.5">
          {node.children.map((child) => (
            <CvFolderBranch
              expanded={expanded}
              key={child.id}
              node={child}
              onOpen={onOpen}
              onToggle={onToggle}
              openFolderId={openFolderId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
