// Recruitment workspace — the shapes that cross the wire between the server (rows-db.ts, the
// /api/recruitment/workspace/* routes) and the screen (src/components/recruitment/workspace/*).
// Types only.

import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import type { WorkspaceRoleTab, WorkspaceTabKey } from "@/lib/recruitment/workspace/role-tabs";
import type { CallResult, CandidateSourceKey, RejectionReason } from "@/lib/recruitment/workspace/vocabulary";

/** One answer as a labelled chip. `value` null = the applicant never answered it (the amber "Missing · add" chip). */
export type WorkspaceAnswerChip = {
  /** The screening key: a built-in ("role", "background", "region", "area", "experience", "salary") or an extra question key. */
  key: string;
  /** The question's short label, e.g. "Graduated in". */
  label: string;
  /** What the applicant (or HR) answered, as the option's display label. Null = missing. */
  value: string | null;
  /** The stored value behind the label (an option value), for the filters and the editor. */
  rawValue: string | null;
  /** Set when HR typed this answer — the chip says "added by HR" with who and when. */
  addedByHr: { hrId: string; name: string | null; at: string } | null;
  /** One of the Medical Rep six the owner listed first (larger type, leading the row). */
  lead: boolean;
};

export type WorkspacePlacement = {
  tab: WorkspaceRoleTab;
  /** The bot family tapped — tells the shared RM/AM + NSM tab which of the two it was. */
  botRoleFamily: string | null;
  regionCode: string | null;
  regionName: string | null;
  areaCode: string | null;
  areaName: string | null;
  placedBy: "whatsapp" | "website" | "hr" | "migration";
  placedByName: string | null;
  placedAt: string;
};

export type WorkspaceRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: CandidateSourceKey;
  /** When the CV arrived (ats_candidates.created_at), ISO. */
  receivedAt: string;
  status: CandidateStatus;
  statusChangedAt: string | null;
  /** Every tab this person is filed in. Empty = Needs placing. */
  placements: WorkspacePlacement[];
  /** The answer chips for the tab being viewed — the Medical Rep six first when that tab is open. */
  answers: WorkspaceAnswerChip[];
  /** Stored completeness. Null = not yet computed for this candidate. */
  completeness: { expected: number; given: number; missingKeys: string[] } | null;
  overdue: { kind: "shortlisted" | "sent_to_manager"; days: number } | null;
  /** Another record that looks like the same person (`findDuplicateFlags`: the phone's last digits, or the name). */
  duplicate: { otherCandidateIds: string[]; reason: string } | null;
  latestCall: { result: CallResult; at: string; byName: string | null; note: string | null } | null;
  /** A manager handed this CV back (ats_v_candidate_returns). */
  returned: { source: string; byName: string | null; reasonCode: string | null; note: string | null; at: string } | null;
  /** The latest Interview Calendar booking and its outcome. */
  interview: { bookingId: string; startsAt: string; outcome: string | null } | null;
  latestSend: { managerHrId: string | null; managerName: string | null; sentAt: string } | null;
  rejection: { reason: RejectionReason | null; note: string | null } | null;
  archivedAt: string | null;
  folders: { id: string; name: string }[];
  offerId: string | null;
  hasCvFile: boolean;
};

export type WorkspaceCursor = { createdAt: string; id: string };

export type WorkspacePage = {
  rows: WorkspaceRow[];
  nextCursor: WorkspaceCursor | null;
};

export type WorkspaceFunnel = {
  received: number;
  shortlisted: number;
  sent_to_manager: number;
  interviewed: number;
  offered: number;
  hired: number;
};

export type WorkspaceCounts = {
  /** Rows the current filters return. */
  total: number;
  /** Per tab key (role tabs + needs_placing), ignoring tab/region/area. */
  byTab: Partial<Record<WorkspaceTabKey, number>>;
  /** Per region ("unspecified" included) and, for Medical Rep, per area — ignoring region/area. */
  byPlace: { region: string; area: string | null; n: number }[];
  /** Per status in the current tab and place, ignoring the status filter. */
  byStatus: Partial<Record<string, number>>;
  funnel: WorkspaceFunnel;
};

/** The AU places a tab can be split by, with the vacant seats the owner asked to see beside them. */
export type WorkspaceArea = { code: string; name: string; vacantSeats: number };
export type WorkspaceRegion = { code: string; name: string; vacantSeats: number; areas: WorkspaceArea[] };
export type WorkspacePlaces = { regions: WorkspaceRegion[] };

/** One option of one answer filter: the stored value, its label, and how many in the current tab hold it. */
export type WorkspaceAnswerFilter = {
  key: string;
  label: string;
  options: { value: string; label: string }[];
};
