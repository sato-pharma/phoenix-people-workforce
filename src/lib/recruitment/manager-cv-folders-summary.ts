// Recruitment / ATS — the overview row's numbers for one manager.
//
// The owner, 2026-10-16: "make for every manager a small row in their overview holding folders of
// the cvs". The row is a prompt, not a list of CVs: it names the folders that hold something, says
// how many of those CVs are still unopened, and counts the empty ones. The pure counting is
// `summarizeManagerFolders`; this file is only the two reads it needs.

import { listCandidateViews } from "@/lib/recruitment/candidate-views";
import { listDistrictBoardsForManager } from "@/lib/recruitment/district-manager-folders-db";
import {
  isSendUnseen,
  summarizeManagerFolders,
  type ManagerFolderSummary,
} from "@/lib/recruitment/manager-cv-folders";

/**
 * The folders this manager holds, summarised for the overview. Null when the manager holds no shelf
 * at all (a head-office manager), so the row is hidden rather than reading "0 folders".
 */
export async function loadManagerCvFolderSummary(
  managerHrId: string | null | undefined,
): Promise<ManagerFolderSummary | null> {
  if (!String(managerHrId ?? "").trim()) return null;
  const boards = await listDistrictBoardsForManager(managerHrId);
  if (boards.length === 0) return null;

  const sentAtById = new Map<string, string | null | undefined>();
  for (const board of boards) {
    for (const folder of board.folders) {
      for (const candidate of folder.candidates) {
        sentAtById.set(candidate.id, candidate.managerNotified?.sentAt);
      }
    }
  }
  if (sentAtById.size === 0) return summarizeManagerFolders(boards, () => false);

  const views = await listCandidateViews(managerHrId);
  return summarizeManagerFolders(boards, (candidateId) =>
    isSendUnseen(sentAtById.get(candidateId), views[candidateId]?.lastSeenAt),
  );
}
