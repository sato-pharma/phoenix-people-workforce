// Recruitment / ATS — how many CVs reached the candidate pool inside a window.
//
// Counted on `ats_candidates.created_at`, the same column the daily CV digest reads, so the Talent
// Acquisition overview's "CVs Received" card and the 18:00 summary count one thing. The window is
// the one the Hired card already uses (inclusive Cairo dates), turned into real UTC instants by
// `cairoMidnightUtcIso` so a CV stamped 22:30Z on 30 September lands on 1 October, in Cairo.
//
// Count only — no candidate row leaves this function.

import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";
import type { HiredWindow } from "@/lib/recruitment/dashboard";
import { recruitmentDb } from "@/lib/recruitment/db";

export async function countCandidatesReceivedInWindow(window: HiredWindow): Promise<number> {
  const { count, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("id", { count: "exact", head: true })
    .gte("created_at", cairoMidnightUtcIso(window.fromIso))
    .lt("created_at", cairoMidnightUtcIso(window.toIso, 1));
  if (error) throw new Error(error.message);
  return count ?? 0;
}
