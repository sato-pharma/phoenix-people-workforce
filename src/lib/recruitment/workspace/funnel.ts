// Recruitment workspace — the counts payload, read off `ats_workspace_counts` into the screen's shape.
//
// The COUNTING is the database's: every number comes from the same `ats_workspace_filter` the rows
// come from, so a tab badge, a region badge and the funnel can never disagree with the table under
// them. This file only reads the jsonb back — defensively, because a count is a number on screen
// and a malformed one must read as 0, never as "NaN" or a crash of the whole bar.
//
// The funnel's stages and their words are here too, so the bar and the export say them one way.

import { workspaceRoleTabs, NEEDS_PLACING, type WorkspaceTabKey } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspaceCounts, WorkspaceFunnel } from "@/lib/recruitment/workspace/types";

export const funnelStages = ["received", "shortlisted", "sent_to_manager", "interviewed", "offered", "hired"] as const;
export type FunnelStage = (typeof funnelStages)[number];

export const funnelStageLabels: Record<FunnelStage, string> = {
  hired: "Hired",
  interviewed: "Interviewed",
  offered: "Offered",
  received: "Received",
  sent_to_manager: "Sent to manager",
  shortlisted: "Shortlisted",
};

function count(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function emptyWorkspaceFunnel(): WorkspaceFunnel {
  return { hired: 0, interviewed: 0, offered: 0, received: 0, sent_to_manager: 0, shortlisted: 0 };
}

export function emptyWorkspaceCounts(): WorkspaceCounts {
  return { byPlace: [], byStatus: {}, byTab: {}, funnel: emptyWorkspaceFunnel(), total: 0 };
}

/** The `ats_workspace_counts` jsonb as `WorkspaceCounts`. PURE. A tab the viewer may not see is dropped. */
export function mapWorkspaceCounts(raw: unknown): WorkspaceCounts {
  const body = record(raw);
  const knownTabs = new Set<string>([...workspaceRoleTabs, NEEDS_PLACING]);

  const byTab: WorkspaceCounts["byTab"] = {};
  for (const [key, value] of Object.entries(record(body.by_tab))) {
    if (knownTabs.has(key)) byTab[key as WorkspaceTabKey] = count(value);
  }

  const byPlace: WorkspaceCounts["byPlace"] = [];
  for (const entry of Array.isArray(body.by_place) ? body.by_place : []) {
    const row = record(entry);
    const region = typeof row.region === "string" && row.region ? row.region : "unspecified";
    const area = typeof row.area === "string" && row.area ? row.area : null;
    byPlace.push({ area, n: count(row.n), region });
  }

  const byStatus: WorkspaceCounts["byStatus"] = {};
  for (const [key, value] of Object.entries(record(body.by_status))) byStatus[key] = count(value);

  const funnelRaw = record(body.funnel);
  const funnel = emptyWorkspaceFunnel();
  for (const stage of funnelStages) funnel[stage] = count(funnelRaw[stage]);

  return { byPlace, byStatus, byTab, funnel, total: count(body.total) };
}
