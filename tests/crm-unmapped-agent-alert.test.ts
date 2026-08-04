import assert from "node:assert/strict";

import { selectUnmappedAgentAlerts } from "../src/lib/crm/unmapped-alert.ts";
import { isoWeekKeyOf } from "../src/lib/notifications/ireports360-sync-digest.ts";
import type { CrmResolutionRow } from "../src/lib/crm/types.ts";

type Row = { agentCrmId: number | null; agentHrId: string | null; agentName: string | null; visitDate: string | null };

function row(overrides: Partial<Row>): Row {
  return { agentCrmId: 1399, agentHrId: null, agentName: "Mohamed.Yasser ( Tanta / A )", visitDate: "2026-08-03", ...overrides };
}

export function runCrmUnmappedAgentAlertTests() {
  const recentSinceIso = "2026-07-21";

  // ── A brand-new unmapped agent (no resolution row) must alert ────────────────────────────────
  const fresh = selectUnmappedAgentAlerts({
    recentSinceIso,
    resolutions: [],
    rows: [row({}), row({ visitDate: "2026-08-02" }), row({ agentHrId: "B-1", agentCrmId: 500 })],
  });
  assert.equal(fresh.length, 1, "resolved rows never alert; the unresolved agent must — this is the invisible-work tripwire");
  assert.equal(fresh[0].kind, "new_unmapped");
  assert.equal(fresh[0].agentCrmId, 1399);
  assert.equal(fresh[0].visitCount, 2);
  assert.equal(fresh[0].firstDay, "2026-08-02");
  assert.equal(fresh[0].lastDay, "2026-08-03");

  // ── Historical-only activity stays silent (the weekly reconcile re-scans 120-day windows) ────
  const historical = selectUnmappedAgentAlerts({
    recentSinceIso,
    resolutions: [],
    rows: [row({ agentCrmId: 1396, agentName: "( Cairo East 1 / F )", visitDate: "2026-05-12" })],
  });
  assert.equal(historical.length, 0, "a long-gone identity re-seen by a wide reconcile must not alert forever");

  // ── "resigned" with the SAME label stays silent; a DIFFERENT label is the reused-slot alarm ──
  const resignedResolutions: CrmResolutionRow[] = [
    { crmId: 1395, crmName: "( Helwan-Maadi / P  ) ", mappedHrId: null, status: "resigned" },
  ];
  const sameLabel = selectUnmappedAgentAlerts({
    recentSinceIso,
    resolutions: resignedResolutions,
    rows: [row({ agentCrmId: 1395, agentName: "( Helwan-Maadi / P )" })],
  });
  assert.equal(sameLabel.length, 0, "an admin's standing 'resigned' decision must hold while the label is unchanged (whitespace-insensitively)");

  const reused = selectUnmappedAgentAlerts({
    recentSinceIso,
    resolutions: resignedResolutions,
    rows: [row({ agentCrmId: 1395, agentName: "Mohamed.Raafat ( Helwan-Maadi / P ) " })],
  });
  assert.equal(reused.length, 1, "a resigned-marked account logging fresh visits under a NEW name is the reused-slot pattern and must alert");
  assert.equal(reused[0].kind, "reused_resigned_slot");

  // ── "pending" keeps reminding; "mapped" alerts only on label drift ───────────────────────────
  const pending = selectUnmappedAgentAlerts({
    recentSinceIso,
    resolutions: [{ crmId: 1399, crmName: null, mappedHrId: null, status: "pending" }],
    rows: [row({})],
  });
  assert.equal(pending[0]?.kind, "pending_reminder");

  const drift = selectUnmappedAgentAlerts({
    recentSinceIso,
    resolutions: [{ crmId: 1536, crmName: "Essam.Youssef ( Dokki / P )", mappedHrId: "B-164", status: "mapped" }],
    rows: [row({ agentCrmId: 1536, agentName: "Someone.Else ( Dokki / P )" })],
  });
  assert.equal(drift[0]?.kind, "mapped_label_drift", "a mapped slot logging under a different name means the label-scoped override stopped applying");

  // ── The latest row's label wins (a handed-over slot reports the CURRENT occupant's name) ─────
  const latestName = selectUnmappedAgentAlerts({
    recentSinceIso,
    resolutions: [],
    rows: [
      row({ agentCrmId: 1102, agentName: "( Imbaba - Imbaba Centers )", visitDate: "2026-07-25" }),
      row({ agentCrmId: 1102, agentName: "Gannatallah.Amer ( Imbaba - P )", visitDate: "2026-08-03" }),
    ],
  });
  assert.equal(latestName[0]?.agentName, "Gannatallah.Amer ( Imbaba - P )");

  // ── Ordering: biggest invisible-work count first ─────────────────────────────────────────────
  const ordered = selectUnmappedAgentAlerts({
    recentSinceIso,
    resolutions: [],
    rows: [
      row({ agentCrmId: 7, visitDate: "2026-08-01" }),
      row({ agentCrmId: 9, visitDate: "2026-08-01" }),
      row({ agentCrmId: 9, visitDate: "2026-08-02" }),
    ],
  });
  assert.deepEqual(ordered.map((alert) => alert.agentCrmId), [9, 7]);

  // ── isoWeekKeyOf: the alert idempotency window ───────────────────────────────────────────────
  assert.equal(isoWeekKeyOf(new Date("2026-08-04T00:00:00Z")), "2026-W32");
  assert.equal(isoWeekKeyOf(new Date("2026-08-09T23:59:59Z")), "2026-W32", "Sunday still belongs to the same ISO week as its Monday");
  assert.equal(isoWeekKeyOf(new Date("2026-08-10T00:00:00Z")), "2026-W33", "Monday starts the next ISO week — the weekly reminder re-arms here");
  assert.equal(isoWeekKeyOf(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  assert.equal(isoWeekKeyOf(new Date("2027-01-01T00:00:00Z")), "2026-W53", "Jan 1 2027 is a Friday inside ISO week 53 of 2026 — the year must follow the ISO week, not the calendar");
}
