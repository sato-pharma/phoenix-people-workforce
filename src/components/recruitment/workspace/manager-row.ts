// Recruitment workspace — a CV on a MANAGER's screen, in the workspace's own row shape.
//
// The manager portal (/employee-portals/recruitment-candidates) lists the CVs sent to a manager, the
// candidates on his open positions and the folders of the areas he holds. Since the rebuild it draws
// each of them with the workspace's own `CandidateRow` and `OpenedCv` in `mode="manager"` (the plan's
// Phase 4, "the manager portal"), so what HR reads and what a manager reads are one design.
//
// The manager's lists arrive as the pool's `Candidate`, already REDACTED on the server — the phone of
// a CV that was not sent to him is gone until he says "I will call". This adapter copies only what the
// row draws, and it copies the phone exactly as it was handed over: it never re-reads, widens or
// guesses a contact. Every HR-only fact (placements, completeness, duplicates, call results, HR
// folders) is left empty, because the row hides those in manager mode and a manager is not shown them.
//
// Pure and client-safe: no database, no process.env.

import type { Candidate } from "@/lib/recruitment/types";
import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import type { WorkspaceAnswerChip, WorkspaceRow } from "@/lib/recruitment/workspace/types";
import { candidateSourceKey } from "@/lib/recruitment/workspace/vocabulary";

export function managerWorkspaceRow(
  candidate: Candidate,
  options: { answers?: readonly WorkspaceAnswerChip[] | null; hasCvFile: boolean },
): WorkspaceRow {
  const notified = candidate.managerNotified;
  return {
    answers: [...(options.answers ?? [])],
    archivedAt: null,
    completeness: null,
    duplicate: null,
    email: candidate.email,
    folders: [],
    hasCvFile: options.hasCvFile,
    id: candidate.id,
    interview: null,
    latestCall: null,
    latestSend: notified ? { managerHrId: notified.hrId, managerName: notified.name, sentAt: notified.sentAt } : null,
    name: candidate.fullName,
    offerId: candidate.offerId,
    overdue: null,
    phone: candidate.phone,
    placements: [],
    receivedAt: candidate.createdAt,
    rejection: null,
    returned: null,
    source: candidateSourceKey(candidate.source),
    status: normalizeCandidateStatus(candidate.status) ?? "new",
    statusChangedAt: candidate.statusChangedAt,
  };
}
