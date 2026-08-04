/**
 * Unmapped-agent activity detection — the pure decision core behind the "someone's fieldwork is
 * invisible" alert (see notifyUnmappedCrmAgentActivity in notifications/ireports360-sync-digest.ts).
 *
 * WHY THIS EXISTS: the failure it closes ran silently for months. A CRM account whose visits
 * resolve to no employee (a brand-new agent, or a resigned person's account handed to their
 * replacement) syncs perfectly — the rows land in the mirror — but with agent_hr_id null every
 * board, compliance report, and deduction connector treats that person as absent. Gannatallah.Amer
 * (CRM account 1102) was invisible from April to August 2026 because the only surface that showed
 * the gap was a tab nobody was told to open. The sync engine now runs this selector after every
 * successful run and pushes a high-priority notification the moment fresh unmapped activity
 * appears, instead of waiting for an audit to find it.
 */

import { normalizeCrmName } from "@/lib/crm/identity";
import type { CrmResolutionRow } from "@/lib/crm/types";

export type UnmappedAgentAlertKind =
  /** No resolution decision exists for this CRM account at all — a brand-new unmapped agent. */
  | "new_unmapped"
  /** An admin explicitly reset this account to "pending" and it still has fresh activity. */
  | "pending_reminder"
  /** The account is marked "resigned" but is logging new visits under a DIFFERENT display label —
   * the reused-slot pattern (a replacement working invisibly under a leaver's account). */
  | "reused_resigned_slot"
  /** The account is "mapped" but current visits carry a different label than the mapping was made
   * against, so the label-scoped override no longer applies — the slot changed hands again. */
  | "mapped_label_drift";

export type UnmappedAgentAlert = {
  agentCrmId: number;
  agentName: string | null;
  firstDay: string;
  kind: UnmappedAgentAlertKind;
  lastDay: string;
  visitCount: number;
};

type UnmappedDetectionRow = {
  agentCrmId: number | null;
  agentHrId: string | null;
  agentName: string | null;
  visitDate: string | null;
};

/**
 * Rolls the run's UNRESOLVED visit rows (agent_hr_id null) up to one alert per CRM account and
 * classifies each against the stored resolution decisions. Pure — unit-tested without I/O.
 *
 * `recentSinceIso` keeps the weekly wide reconcile honest: it re-scans windows up to 120 days
 * old, and a resigned agent's own historical unmapped rows must not alert forever. Only accounts
 * whose LATEST unmapped visit is on/after this date alert at all.
 *
 * A "resigned" account with unchanged label stays silent on purpose — that is the admin's
 * standing decision working exactly as recorded. It alerts only when the label CHANGED, because
 * per production evidence a changed label means a different human is now using the account.
 */
export function selectUnmappedAgentAlerts(input: {
  recentSinceIso: string;
  resolutions: readonly CrmResolutionRow[];
  rows: readonly UnmappedDetectionRow[];
}): UnmappedAgentAlert[] {
  type Group = { firstDay: string; lastDay: string; latestName: string | null; visitCount: number };
  const groups = new Map<number, Group>();
  for (const row of input.rows) {
    if (row.agentCrmId == null || row.agentHrId !== null) continue;
    const day = (row.visitDate ?? "").slice(0, 10);
    if (!day) continue;
    const existing = groups.get(row.agentCrmId);
    if (!existing) {
      groups.set(row.agentCrmId, { firstDay: day, lastDay: day, latestName: row.agentName ?? null, visitCount: 1 });
      continue;
    }
    existing.visitCount += 1;
    if (day < existing.firstDay) existing.firstDay = day;
    if (day >= existing.lastDay) {
      existing.lastDay = day;
      // Prefer the newest row's label: for a handed-over account it is the CURRENT occupant's name.
      if (row.agentName) existing.latestName = row.agentName;
    }
  }

  const resolutionByCrmId = new Map<number, CrmResolutionRow>();
  for (const resolution of input.resolutions) resolutionByCrmId.set(resolution.crmId, resolution);

  const alerts: UnmappedAgentAlert[] = [];
  for (const [agentCrmId, group] of groups) {
    if (group.lastDay < input.recentSinceIso) continue;
    const resolution = resolutionByCrmId.get(agentCrmId);
    let kind: UnmappedAgentAlertKind | null = null;
    if (!resolution) {
      kind = "new_unmapped";
    } else if (resolution.status === "pending") {
      kind = "pending_reminder";
    } else {
      const recordLabel = normalizeCrmName(group.latestName);
      const storedLabel = normalizeCrmName(resolution.crmName);
      const labelChanged = recordLabel !== null && storedLabel !== null && recordLabel !== storedLabel;
      if (resolution.status === "resigned" && labelChanged) kind = "reused_resigned_slot";
      if (resolution.status === "mapped" && labelChanged) kind = "mapped_label_drift";
    }
    if (!kind) continue;
    alerts.push({
      agentCrmId,
      agentName: group.latestName,
      firstDay: group.firstDay,
      kind,
      lastDay: group.lastDay,
      visitCount: group.visitCount,
    });
  }

  return alerts.sort((a, b) => b.visitCount - a.visitCount || a.agentCrmId - b.agentCrmId);
}
