"use client";

// Recruitment workspace — every decision a CV can take, written once for the opened CV, the bulk bar
// and the keyboard alike.
//
// EACH ONE IS OPTIMISTIC AND EACH ONE CARRIES ITS UNDO (owner, 20 Oct 2026: "every decision has a
// 10-second Undo … everything is optimistic: no reloads"). The row changes at the press; the server
// is told behind it; the undo entry knows how to put both back. Which KIND of undo each action gets
// is the rule in `undo-toast.tsx`: what touches only our record is written at once and reverted on
// Undo; what tells a person, or removes something for good, waits the ten seconds and is simply
// never sent when Undo is pressed.
//
// No business rule lives here. Who may do what, and what a decision changes, is the routes' and
// `src/lib/recruitment/`'s — a refusal comes back as the route's own sentence and is shown as it is.

import { useCallback, useEffect, useState } from "react";

import { deleteJson, deleteRequest, getJson, patchJson, postJson } from "@/components/recruitment/recruitment-fetch";
import type { UndoAction, UndoBeacon } from "@/components/recruitment/workspace/undo-toast";
import type { RemovedRow } from "@/components/recruitment/workspace/use-workspace-rows";
import { answerEditKey, errorText } from "@/components/recruitment/workspace/workspace-format";
import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import type { InterviewBooking } from "@/lib/recruitment/interview-calendar-types";
import type { ArchivedMode } from "@/lib/recruitment/workspace/filters";
import type { WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspaceAnswerChip, WorkspacePlacement, WorkspaceRow } from "@/lib/recruitment/workspace/types";
import { callResultLabels, rejectionReasonLabels, type CallResult, type RejectionReason } from "@/lib/recruitment/workspace/vocabulary";

const CANDIDATES = "/api/recruitment/candidates";
/** Where the "Ask again" template stands with Meta: `{ status, label }`. */
const FOLLOWUP_TEMPLATE = "/api/recruitment/whatsapp/followup-template";

/** Why "Ask again" cannot send yet, or null once Meta has approved the template. */
export type AskAgainHold = { short: string; why: string };

type RowsApi = {
  patchRows: (ids: readonly string[], patch: Partial<WorkspaceRow> | ((row: WorkspaceRow) => WorkspaceRow)) => WorkspaceRow[];
  restoreRows: (previous: readonly WorkspaceRow[]) => void;
  removeRows: (ids: readonly string[]) => RemovedRow[];
  reinsertRows: (removed: readonly RemovedRow[]) => void;
  rowById: (id: string) => WorkspaceRow | null;
};

function who(rows: readonly WorkspaceRow[], count = rows.length): string {
  if (count === 1 && rows[0]) return rows[0].name;
  return `${count} CVs`;
}

type RevertMove = { id: string; note: string | null; status: string };

/**
 * What `revert-status` puts back: each CV's earlier status AND its earlier note. The route restores
 * both; a note it is not handed comes back empty, so a CV whose status carried a note ("returned by
 * the manager: no car") would lose it to an Undo. `notes` holds what the server or a read said the
 * note was; a CV missing from it is restored with none, as before.
 */
function revertMoves(before: readonly WorkspaceRow[], notes?: ReadonlyMap<string, { note: string | null; status: string | null }>) {
  const moves: RevertMove[] = before.map((row) => {
    const earlier = notes?.get(row.id);
    return { id: row.id, note: earlier?.note ?? null, status: earlier?.status ?? row.status };
  });
  return { moves };
}

/**
 * The note one CV carries now, read before a Shortlist or Back-up clears it. The status routes do not
 * answer with the note they replaced (the reject routes do), so a single press reads it first; a read
 * that fails costs only the note on Undo, never the decision.
 */
async function readStatusNote(id: string): Promise<{ note: string | null; status: string | null } | null> {
  try {
    const data = await getJson(`${CANDIDATES}/${encodeURIComponent(id)}`);
    const candidate = ((data.profile ?? {}) as { candidate?: { status?: unknown; statusNote?: unknown } }).candidate;
    if (!candidate) return null;
    return {
      note: typeof candidate.statusNote === "string" ? candidate.statusNote : null,
      status: typeof candidate.status === "string" ? candidate.status : null,
    };
  } catch {
    return null;
  }
}

function beacon(url: string, method: UndoBeacon["method"], body?: unknown): UndoBeacon {
  return { body, method, url };
}

export function useWorkspaceActions({
  archivedMode,
  canWork,
  countsSoon,
  foldersChanged,
  problem,
  push,
  rows,
}: {
  archivedMode: () => ArchivedMode;
  /** Can this viewer work the pool? The CEO reads only, and never asks Meta anything. */
  canWork: boolean;
  countsSoon: () => void;
  foldersChanged: () => void;
  problem: (message: string) => void;
  push: (action: UndoAction) => void;
  rows: RowsApi;
}) {
  // Until Meta approves the template, both "Ask again" buttons say so and send nothing (the server
  // refuses as well). Read once per visit; the route itself asks Meta at most every ten minutes.
  const [askAgainHold, setAskAgainHold] = useState<AskAgainHold | null>({ short: "Checking the WhatsApp template", why: "Reading the template's status from Meta" });
  useEffect(() => {
    if (!canWork) return;
    let live = true;
    getJson(FOLLOWUP_TEMPLATE)
      .then((data) => {
        if (!live) return;
        const why = typeof data.label === "string" && data.label ? data.label : "Waiting for Meta approval";
        if (data.status === "approved") setAskAgainHold(null);
        else setAskAgainHold({ short: data.status === "rejected" ? "Meta rejected the message" : "Waiting for Meta approval", why });
      })
      .catch(() => {
        if (live) setAskAgainHold({ short: "Template status unreadable", why: "The WhatsApp template's status could not be read from Meta" });
      });
    return () => {
      live = false;
    };
  }, [canWork]);

  /** Shortlist or Back-up — written at once, reverted on Undo through `revert-status`. */
  const decide = useCallback(
    async (ids: readonly string[], status: Extract<CandidateStatus, "shortlisted" | "backup">) => {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      const before = rows.patchRows(ids, { status, statusChangedAt: now });
      const notes = new Map<string, { note: string | null; status: string | null }>();
      try {
        if (ids.length === 1) {
          const earlier = await readStatusNote(ids[0]);
          if (earlier) notes.set(ids[0], earlier);
          await patchJson(`${CANDIDATES}/${ids[0]}/status`, { status });
        } else if (status === "shortlisted") {
          // bulk-status answers with what each CV was before — status and note — as bulk-reject does.
          const data = await postJson(`${CANDIDATES}/bulk-status`, { ids, status });
          const moved = Array.isArray(data.moved) ? (data.moved as Array<{ id?: unknown; fromNote?: unknown; fromStatus?: unknown }>) : [];
          for (const move of moved) {
            if (typeof move.id !== "string") continue;
            notes.set(move.id, {
              note: typeof move.fromNote === "string" ? move.fromNote : null,
              status: typeof move.fromStatus === "string" ? move.fromStatus : null,
            });
          }
        } else {
          // Back-up is a per-CV decision on the server (bulk-status takes shortlist and reject only).
          for (const id of ids) {
            const earlier = await readStatusNote(id);
            if (earlier) notes.set(id, earlier);
            await patchJson(`${CANDIDATES}/${id}/status`, { status });
          }
        }
      } catch (error) {
        rows.restoreRows(before);
        problem(errorText(error, "The decision was not saved."));
        return;
      }
      countsSoon();
      push({
        kind: "applied",
        message: `${status === "shortlisted" ? "Shortlisted" : "Moved to Back-up"} ${who(before, ids.length)}`,
        restore: () => {
          rows.restoreRows(before);
          countsSoon();
        },
        revert: async () => {
          await postJson(`${CANDIDATES}/revert-status`, revertMoves(before, notes));
        },
      });
    },
    [countsSoon, problem, push, rows],
  );

  /** Reject with a reason from the fixed list. The sorry message is a separate, later press. */
  const reject = useCallback(
    async (ids: readonly string[], reason: RejectionReason, note: string | null): Promise<boolean> => {
      if (ids.length === 0) return false;
      const now = new Date().toISOString();
      const before = rows.patchRows(ids, { rejection: { note, reason }, status: "rejected", statusChangedAt: now });
      // Both reject routes answer with what each CV was before — status and note — so the Undo puts
      // the earlier note back rather than an empty one.
      const notes = new Map<string, { note: string | null; status: string | null }>();
      try {
        if (ids.length === 1) {
          const data = await postJson(`${CANDIDATES}/${ids[0]}/reject`, { note, reason });
          const previous = (data.previous ?? null) as { note?: unknown; status?: unknown } | null;
          if (previous) {
            notes.set(ids[0], {
              note: typeof previous.note === "string" ? previous.note : null,
              status: typeof previous.status === "string" ? previous.status : null,
            });
          }
        } else {
          const data = await postJson(`${CANDIDATES}/bulk-reject`, { candidateIds: ids, note, reason });
          const moved = Array.isArray(data.moved) ? (data.moved as Array<{ id?: unknown; fromNote?: unknown; fromStatus?: unknown }>) : [];
          for (const move of moved) {
            if (typeof move.id !== "string") continue;
            notes.set(move.id, {
              note: typeof move.fromNote === "string" ? move.fromNote : null,
              status: typeof move.fromStatus === "string" ? move.fromStatus : null,
            });
          }
        }
      } catch (error) {
        rows.restoreRows(before);
        problem(errorText(error, "The rejection was not saved."));
        return false;
      }
      countsSoon();
      push({
        kind: "applied",
        message: `Rejected ${who(before, ids.length)} · ${rejectionReasonLabels[reason]}`,
        restore: () => {
          rows.restoreRows(before);
          countsSoon();
        },
        revert: async () => {
          await postJson(`${CANDIDATES}/revert-status`, revertMoves(before, notes));
        },
      });
      return true;
    },
    [countsSoon, problem, push, rows],
  );

  /** Send to a manager — tells him, so it WAITS the ten seconds. */
  const sendToManager = useCallback(
    (ids: readonly string[], manager: { hrId: string; name: string }, folderArea: string | null) => {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      const before = rows.patchRows(ids, {
        latestSend: { managerHrId: manager.hrId, managerName: manager.name, sentAt: now },
        status: "sent_to_manager",
        statusChangedAt: now,
      });
      const single = ids.length === 1;
      const url = single ? `${CANDIDATES}/${ids[0]}/notify-manager` : `${CANDIDATES}/notify-manager`;
      const body = single
        ? { folderArea: folderArea || null, managerHrId: manager.hrId }
        : { candidateIds: ids, folderArea: folderArea || null, managerHrId: manager.hrId };
      push({
        beacons: [beacon(url, "POST", body)],
        commit: async () => {
          await postJson(url, body);
          countsSoon();
        },
        kind: "pending",
        message: `Sending ${who(before, ids.length)} to ${manager.name}`,
        restore: () => rows.restoreRows(before),
      });
    },
    [countsSoon, push, rows],
  );

  /** File in a folder. Undo takes the filing out and, for a move, puts the old filings back. */
  const fileInFolder = useCallback(
    async (ids: readonly string[], folder: { id: string; name: string }, mode: "move" | "copy") => {
      if (ids.length === 0) return;
      const before = rows.patchRows(ids, (row) => ({
        ...row,
        folders: mode === "move" ? [folder] : row.folders.some((item) => item.id === folder.id) ? row.folders : [...row.folders, folder],
      }));
      try {
        await postJson(`/api/recruitment/cv-folders/${folder.id}/items`, { candidateIds: ids, mode });
      } catch (error) {
        rows.restoreRows(before);
        problem(errorText(error, "The CV was not filed."));
        return;
      }
      foldersChanged();
      const newlyFiled = before.filter((row) => !row.folders.some((item) => item.id === folder.id)).map((row) => row.id);
      push({
        kind: "applied",
        message: `${mode === "move" ? "Moved" : "Copied"} ${who(before, ids.length)} to ${folder.name}`,
        restore: () => {
          rows.restoreRows(before);
          foldersChanged();
        },
        revert: async () => {
          if (newlyFiled.length) await deleteJson(`/api/recruitment/cv-folders/${folder.id}/items`, { candidateIds: newlyFiled });
          if (mode !== "move") return;
          const previous = new Map<string, string[]>();
          for (const row of before) {
            for (const item of row.folders) {
              if (item.id === folder.id) continue;
              previous.set(item.id, [...(previous.get(item.id) ?? []), row.id]);
            }
          }
          for (const [folderId, candidateIds] of previous) {
            await postJson(`/api/recruitment/cv-folders/${folderId}/items`, { candidateIds, mode: "copy" });
          }
        },
      });
    },
    [foldersChanged, problem, push, rows],
  );

  /** Archive or bring back. Leaves the list when the list is not showing that side. */
  const archive = useCallback(
    async (ids: readonly string[], archived: boolean) => {
      if (ids.length === 0) return;
      const mode = archivedMode();
      const leaves = (archived && mode === "exclude") || (!archived && mode === "only");
      const now = new Date().toISOString();
      const removed = leaves ? rows.removeRows(ids) : [];
      const before = leaves ? [] : rows.patchRows(ids, { archivedAt: archived ? now : null });
      const restore = () => {
        rows.reinsertRows(removed);
        rows.restoreRows(before);
        countsSoon();
      };
      try {
        for (const id of ids) {
          if (archived) await postJson(`${CANDIDATES}/${id}/archive`, {});
          else await deleteRequest(`${CANDIDATES}/${id}/archive`);
        }
      } catch (error) {
        restore();
        problem(errorText(error, archived ? "The CV was not archived." : "The CV was not brought back."));
        return;
      }
      countsSoon();
      const names = removed.length ? removed.map((item) => item.row) : before;
      push({
        kind: "applied",
        message: `${archived ? "Archived" : "Brought back"} ${who(names, ids.length)}`,
        restore,
        revert: async () => {
          for (const id of ids) {
            if (archived) await deleteRequest(`${CANDIDATES}/${id}/archive`);
            else await postJson(`${CANDIDATES}/${id}/archive`, {});
          }
        },
      });
    },
    [archivedMode, countsSoon, problem, push, rows],
  );

  /** Delete for good — waits the ten seconds; Undo never sends it. */
  const remove = useCallback(
    (id: string) => {
      const removed = rows.removeRows([id]);
      const name = removed[0]?.row.name ?? "the CV";
      const url = `${CANDIDATES}/${id}`;
      push({
        beacons: [beacon(url, "DELETE")],
        commit: async () => {
          await deleteRequest(url);
          countsSoon();
        },
        kind: "pending",
        message: `Deleting ${name}`,
        restore: () => rows.reinsertRows(removed),
      });
    },
    [countsSoon, push, rows],
  );

  /** Merge a flagged duplicate into this record — waits the ten seconds. */
  const merge = useCallback(
    (survivorId: string, duplicateId: string) => {
      const removed = rows.removeRows([duplicateId]);
      const before = rows.patchRows([survivorId], { duplicate: null });
      const url = `${CANDIDATES}/${survivorId}/merge`;
      const body = { duplicateId };
      push({
        beacons: [beacon(url, "POST", body)],
        commit: async () => {
          await postJson(url, body);
          countsSoon();
        },
        kind: "pending",
        message: `Merging the duplicate into ${before[0]?.name ?? "this CV"}`,
        restore: () => {
          rows.reinsertRows(removed);
          rows.restoreRows(before);
        },
      });
    },
    [countsSoon, push, rows],
  );

  /** One-tap call result — a record of a call, kept only once the ten seconds pass. */
  const callResult = useCallback(
    (id: string, result: CallResult, note: string | null, byName: string | null) => {
      const now = new Date().toISOString();
      const before = rows.patchRows([id], { latestCall: { at: now, byName, note, result } });
      const url = `${CANDIDATES}/${id}/call-result`;
      const body = { note, result };
      push({
        beacons: [beacon(url, "POST", body)],
        commit: async () => {
          await postJson(url, body);
        },
        kind: "pending",
        message: `${callResultLabels[result]} · ${before[0]?.name ?? "call logged"}`,
        restore: () => rows.restoreRows(before),
      });
    },
    [push, rows],
  );

  /** "Ask again on WhatsApp" — sends a template, so it waits the ten seconds. */
  const askAgain = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const names = ids.map((id) => rows.rowById(id)).filter((row): row is WorkspaceRow => row !== null);
      const single = ids.length === 1;
      const url = single ? `${CANDIDATES}/${ids[0]}/ask-again` : `${CANDIDATES}/ask-again`;
      const body = single ? {} : { candidateIds: ids };
      push({
        beacons: [beacon(url, "POST", body)],
        commit: async () => {
          const data = await postJson(url, body);
          if (single && data.sent === false) {
            throw new Error(typeof data.reason === "string" && data.reason ? data.reason : "WhatsApp did not send it.");
          }
          const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
          if (!single && skipped > 0) {
            problem(`${typeof data.sent === "number" ? data.sent : 0} asked again; ${skipped} could not be (outside WhatsApp's rules or no number).`);
          }
        },
        kind: "pending",
        message: `Asking ${who(names, ids.length)} again on WhatsApp`,
      });
    },
    [problem, push, rows],
  );

  /** The one-click sorry message after a rejection — never automatic, and it waits the ten seconds. */
  const sendSorry = useCallback(
    (id: string) => {
      const row = rows.rowById(id);
      const url = `${CANDIDATES}/${id}/rejection-message`;
      push({
        beacons: [beacon(url, "POST", {})],
        commit: async () => {
          const data = await postJson(url, {});
          if (data.sent === false) {
            throw new Error(typeof data.reason === "string" && data.reason ? data.reason : "The message was not sent.");
          }
        },
        kind: "pending",
        message: `Sending the sorry message to ${row?.name ?? "the applicant"}`,
      });
    },
    [push, rows],
  );

  /** A booking the calendar dialog just saved. Undo cancels it. */
  const booked = useCallback(
    (id: string, booking: InterviewBooking) => {
      const before = rows.patchRows([id], { interview: { bookingId: booking.id, outcome: null, startsAt: booking.startsAt } });
      push({
        kind: "applied",
        message: `Interview booked for ${before[0]?.name ?? booking.candidateName}`,
        restore: () => rows.restoreRows(before),
        revert: async () => {
          await deleteRequest(`/api/recruitment/interview-calendar/bookings/${booking.id}`);
        },
      });
    },
    [push, rows],
  );

  /** Write one answer (null clears it). Rejects with the route's sentence, for the chip to show. */
  const saveAnswer = useCallback(
    async (row: WorkspaceRow, chip: WorkspaceAnswerChip, value: string | null, editorName: string | null) => {
      const key = answerEditKey(chip.key);
      await patchJson(`${CANDIDATES}/${row.id}/whatsapp-answer`, { key, value });
      const now = new Date().toISOString();
      const before = rows.patchRows([row.id], (current) => ({
        ...current,
        answers: current.answers.map((item) =>
          item.key === chip.key
            ? { ...item, addedByHr: value === null ? null : { at: now, hrId: "", name: editorName }, rawValue: value, value }
            : item,
        ),
      }));
      countsSoon();
      push({
        kind: "applied",
        message: value === null ? `Cleared “${chip.label}” for ${row.name}` : `Saved “${chip.label}” for ${row.name}`,
        restore: () => rows.restoreRows(before),
        revert: async () => {
          await patchJson(`${CANDIDATES}/${row.id}/whatsapp-answer`, { key, value: chip.rawValue });
        },
      });
    },
    [countsSoon, push, rows],
  );

  /** File this person in a role tab (and region/area), or take them out of one. */
  const place = useCallback(
    async (
      row: WorkspaceRow,
      input: { roleTab: WorkspaceRoleTab; regionCode?: string | null; areaCode?: string | null; remove?: boolean },
    ) => {
      const previous = row.placements.find((placement) => placement.tab === input.roleTab) ?? null;
      const data = await patchJson(`${CANDIDATES}/${row.id}/placement`, input);
      const placements = Array.isArray(data.placements) ? (data.placements as WorkspacePlacement[]) : row.placements;
      const before = rows.patchRows([row.id], { placements });
      countsSoon();
      push({
        kind: "applied",
        message: input.remove ? `Taken out of the tab · ${row.name}` : `Placed ${row.name}`,
        restore: () => {
          rows.restoreRows(before);
          countsSoon();
        },
        revert: async () => {
          if (previous) {
            await patchJson(`${CANDIDATES}/${row.id}/placement`, {
              areaCode: previous.areaCode,
              regionCode: previous.regionCode,
              roleTab: previous.tab,
            });
          } else {
            await patchJson(`${CANDIDATES}/${row.id}/placement`, { remove: true, roleTab: input.roleTab });
          }
        },
      });
    },
    [countsSoon, push, rows],
  );

  return { archive, askAgain, askAgainHold, booked, callResult, decide, fileInFolder, merge, place, reject, remove, saveAnswer, sendSorry, sendToManager };
}

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;
