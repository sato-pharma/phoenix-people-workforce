/**
 * Unrecognized visit-type detection — the pure decision core behind the "iReports360 sent a code
 * nobody has classified" alert (see notifyUnrecognizedCrmVisitTypes in
 * notifications/ireports360-sync-digest.ts).
 *
 * WHY THIS EXISTS. Phoenix mirrors the AV/CP meaning of every iReports360 visit type in three
 * places, and two of them read through `?? "CP"` — an unlisted code silently counts as a working
 * day, which is the safe direction. The third, CRM_CAMPAIGN_VISIT_TYPES / CRM_LEAVE_VISIT_TYPES in
 * attendance/crm-day-maps.ts, is a strict whitelist with no default: an unlisted code sets no flag,
 * so `reconcileDay` never sees a cancel and the day is judged on device-punch timing alone. That is
 * the exact failure the deductions module was built to prevent — a post-settlement audit once found
 * employees deducted on days they had logged real visits.
 *
 * The whitelist being strict is deliberate (silently cancelling a deduction for a code nobody has
 * ruled on is the riskier default), so this module does not change that behaviour. It removes the
 * SILENCE. Until now a brand-new code would surface only as the word "Unknown" on a report nobody
 * was told to open — the same shape of invisible failure that let one agent's fieldwork go
 * unattributed from April to August 2026 (see crm/unmapped-alert.ts, a different tripwire covering
 * unmapped AGENTS rather than visit types).
 *
 * Production has produced exactly 16 distinct codes to date (0 plus fifteen negatives, verified
 * 2026-08-21) and all 16 are classified, so this selector is expected to return nothing. It is
 * insurance against the 17th, not a fix for a live defect.
 *
 * Pure — no imports, no I/O, unit-tested directly. The recognized set is passed IN rather than
 * imported so this module can never become a fourth hand-maintained copy of the visit-type ruling;
 * the caller passes CRM_DAY_CLASSIFIED_VISIT_TYPES, which is itself derived from the two Sets.
 */

export type UnrecognizedVisitTypeAlert = {
  /** How many distinct CRM accounts logged this code — one rep's odd row is a different story
   * from a code appearing across the whole field force. */
  agentCount: number;
  firstDay: string;
  lastDay: string;
  /** A representative rep comment, verbatim. The previous seven undocumented codes were all
   * identified by reading this field on sample rows, so it is the single most useful thing to put
   * in front of whoever has to classify the new one. Null when no row carried a comment. */
  sampleComment: string | null;
  /** Whatever the vendor called it. Expected to be the literal "Unknown" — that is what
   * iReports360 sends for every code it has not documented — but a real description would be a
   * strong hint, so it is reported rather than assumed. */
  sampleDescription: string | null;
  visitCount: number;
  visitType: number;
};

type UnrecognizedDetectionRow = {
  agentCrmId: number | null;
  comment: string | null;
  visitDate: string | null;
  visitType: number | null;
  visitTypeDescription: string | null;
};

/**
 * Rolls a run's visit rows up to one alert per unrecognized visit-type code.
 *
 * `recentSinceIso` matches the unmapped-agent selector's guard and exists for the same reason: the
 * weekly wide reconcile re-scans windows up to 120 days old, and a code that appeared once months
 * ago must not alert every week forever. Only codes whose LATEST row is on/after this date alert.
 *
 * A null `visitType` is NOT an alert. The classification loop in crm-day-maps.ts reads
 * `Number(row.visit_type ?? 0)`, so a null is already treated as a regular visit (type 0) and is
 * classified — flagging it here would report a phantom. Non-finite values are skipped for the same
 * reason: they cannot be a real code, and there is nothing for an admin to classify.
 */
export function selectUnrecognizedVisitTypeAlerts(input: {
  recentSinceIso: string;
  recognizedTypes: ReadonlySet<number>;
  rows: readonly UnrecognizedDetectionRow[];
}): UnrecognizedVisitTypeAlert[] {
  type Group = {
    agents: Set<number>;
    firstDay: string;
    lastDay: string;
    sampleComment: string | null;
    sampleDescription: string | null;
    visitCount: number;
  };
  const groups = new Map<number, Group>();

  for (const row of input.rows) {
    if (row.visitType == null || !Number.isFinite(row.visitType)) continue;
    if (input.recognizedTypes.has(row.visitType)) continue;
    const day = (row.visitDate ?? "").slice(0, 10);
    if (!day) continue;

    const comment = row.comment?.trim() ? row.comment : null;
    const description = row.visitTypeDescription?.trim() ? row.visitTypeDescription : null;
    const existing = groups.get(row.visitType);
    if (!existing) {
      groups.set(row.visitType, {
        agents: new Set(row.agentCrmId == null ? [] : [row.agentCrmId]),
        firstDay: day,
        lastDay: day,
        sampleComment: comment,
        sampleDescription: description,
        visitCount: 1,
      });
      continue;
    }

    existing.visitCount += 1;
    if (row.agentCrmId != null) existing.agents.add(row.agentCrmId);
    if (day < existing.firstDay) existing.firstDay = day;
    if (day > existing.lastDay) existing.lastDay = day;
    // Keep the FIRST non-empty sample of each. Any row's comment is equally representative, and
    // holding the first one steady keeps the alert's wording stable across a re-run of the same
    // window — which matters because the notification is deduped per code per ISO week.
    existing.sampleComment ??= comment;
    existing.sampleDescription ??= description;
  }

  const alerts: UnrecognizedVisitTypeAlert[] = [];
  for (const [visitType, group] of groups) {
    if (group.lastDay < input.recentSinceIso) continue;
    alerts.push({
      agentCount: group.agents.size,
      firstDay: group.firstDay,
      lastDay: group.lastDay,
      sampleComment: group.sampleComment,
      sampleDescription: group.sampleDescription,
      visitCount: group.visitCount,
      visitType,
    });
  }

  return alerts.sort((a, b) => b.visitCount - a.visitCount || a.visitType - b.visitType);
}
