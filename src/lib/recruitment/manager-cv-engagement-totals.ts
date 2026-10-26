// Recruitment / ATS — the Manager CV Engagement report's headline numbers.
//
// Pure, and kept apart from manager-cv-engagement.ts (which reads the database) so the Talent
// Acquisition fence and the XLSX export can count exactly as the screen does without pulling the
// report's loader in with it.

export type ManagerCvEngagementTotals = {
  managers: number;
  received: number;
  opened: number;
  notOpened: number;
  answered: number;
};

/**
 * The headline numbers over a set of manager rows, each CV counted ONCE.
 *
 * One CV can sit in two managers' folders — Tarek Ali Sabry El-morsy, one candidate, was sent to both
 * Dakahlia 1 managers on 25 Oct 2026 — and adding the rows up counted him twice (the line's tile said
 * 15 CVs received; there were 14). So the tiles count CANDIDATES, never rows: received is the distinct
 * CVs, opened the distinct CVs at least one of their managers has opened, not opened the rest, and
 * answered the distinct CVs with a recorded decision. Each manager's own card keeps his own counts,
 * so the cards can add up to more than the tiles — that difference is the shared CVs.
 *
 * The screen, the Talent Acquisition fence and the XLSX cover all take their totals from here, so an
 * export can never quote a number the screen does not show. PURE.
 */
export function distinctEngagementTotals(
  rows: readonly { candidates: readonly { candidateId: string; opened: boolean; answered: boolean }[] }[],
): ManagerCvEngagementTotals {
  const received = new Set<string>();
  const opened = new Set<string>();
  const answered = new Set<string>();
  for (const row of rows) {
    for (const candidate of row.candidates) {
      received.add(candidate.candidateId);
      if (candidate.opened) opened.add(candidate.candidateId);
      if (candidate.answered) answered.add(candidate.candidateId);
    }
  }
  return {
    managers: rows.length,
    received: received.size,
    opened: opened.size,
    notOpened: received.size - opened.size,
    answered: answered.size,
  };
}
