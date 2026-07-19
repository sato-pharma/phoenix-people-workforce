// Probation historical outcomes analytics (Enhancement E4). Read-only aggregate over DECIDED cases:
// pass/terminate rate, average final score, and count — grouped by line, manager, and decision month —
// plus evaluator predictiveness (did an evaluator's recommendation match the eventual decision?).
//
// Historical scores come from `probation_cases.decision_snapshot` (frozen at decision time) — never
// recomputed, so a later config/weight change can't rewrite history. The rollups are pure functions so
// they unit-test without a DB; only `getProbationOutcomesAnalytics` touches Supabase.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import type { ProbationCaseDecision, ProbationRecommendation } from "./types";

export type DecidedCaseInput = {
  decision: ProbationCaseDecision;
  score: number | null; // frozen final (or provisional) score at decision time
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  decisionAt: string | null; // ISO
};

export type OutcomeGroup = {
  key: string;
  label: string;
  total: number;
  passCount: number;
  terminateCount: number;
  passRate: number; // 0..1
  avgScore: number | null;
};

export type PredictivenessRow = {
  recommendation: ProbationRecommendation;
  total: number;
  endedInPass: number;
  endedInTerminate: number;
  // How often the recommendation aligned with the eventual decision:
  //  on_track → pass, needs_improvement/serious_concern → terminate.
  aligned: number;
  alignmentRate: number; // 0..1
};

export type OutcomesAnalytics = {
  overall: OutcomeGroup;
  byLine: OutcomeGroup[];
  byManager: OutcomeGroup[];
  byMonth: OutcomeGroup[];
  predictiveness: PredictivenessRow[];
  totalDecided: number;
  generatedAt: string;
};

function summarize(key: string, label: string, items: DecidedCaseInput[]): OutcomeGroup {
  const total = items.length;
  const passCount = items.filter((i) => i.decision === "pass").length;
  const terminateCount = total - passCount;
  const scored = items.map((i) => i.score).filter((s): s is number => typeof s === "number");
  const avgScore = scored.length > 0 ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100 : null;
  return {
    key,
    label,
    total,
    passCount,
    terminateCount,
    passRate: total > 0 ? passCount / total : 0,
    avgScore,
  };
}

function groupSummaries(
  items: DecidedCaseInput[],
  keyOf: (i: DecidedCaseInput) => string,
  labelOf: (i: DecidedCaseInput) => string,
): OutcomeGroup[] {
  const buckets = new Map<string, { label: string; items: DecidedCaseInput[] }>();
  for (const i of items) {
    const key = keyOf(i);
    const b = buckets.get(key) ?? { label: labelOf(i), items: [] };
    b.items.push(i);
    buckets.set(key, b);
  }
  return Array.from(buckets.entries())
    .map(([key, b]) => summarize(key, b.label, b.items))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// Month key from an ISO decision timestamp (YYYY-MM). Unknown timestamps bucket under "unknown".
function monthKey(iso: string | null): string {
  if (!iso || iso.length < 7) return "unknown";
  return iso.slice(0, 7);
}

/** Pure rollup: pass/terminate rates + avg score, grouped by line, manager, and decision month. */
export function rollupOutcomes(items: DecidedCaseInput[]): Omit<OutcomesAnalytics, "predictiveness" | "generatedAt"> {
  return {
    overall: summarize("overall", "All decided cases", items),
    byLine: groupSummaries(items, (i) => (i.lineName ?? "—").toLowerCase(), (i) => i.lineName ?? "Unassigned line"),
    byManager: groupSummaries(
      items,
      (i) => canonicalHrIdForDisplay(i.managerHrId) ?? "—",
      (i) => i.managerName ?? i.managerHrId ?? "Unassigned manager",
    ),
    byMonth: groupSummaries(items, (i) => monthKey(i.decisionAt), (i) => monthKey(i.decisionAt)),
    totalDecided: items.length,
  };
}

export type PredictivenessInput = {
  recommendation: ProbationRecommendation;
  caseDecision: ProbationCaseDecision;
};

const RECOMMENDATIONS: ProbationRecommendation[] = ["on_track", "needs_improvement", "serious_concern"];

// A recommendation "aligns" with the decision when on_track→pass, or a concern→terminate.
function recommendationAligns(rec: ProbationRecommendation, decision: ProbationCaseDecision): boolean {
  return rec === "on_track" ? decision === "pass" : decision === "terminate";
}

/** Pure rollup: for each recommendation value, how often it matched the eventual decision. */
export function rollupPredictiveness(items: PredictivenessInput[]): PredictivenessRow[] {
  return RECOMMENDATIONS.map((rec) => {
    const forRec = items.filter((i) => i.recommendation === rec);
    const total = forRec.length;
    const endedInPass = forRec.filter((i) => i.caseDecision === "pass").length;
    const aligned = forRec.filter((i) => recommendationAligns(rec, i.caseDecision)).length;
    return {
      recommendation: rec,
      total,
      endedInPass,
      endedInTerminate: total - endedInPass,
      aligned,
      alignmentRate: total > 0 ? aligned / total : 0,
    };
  });
}

type CaseRow = {
  id: string;
  decision: ProbationCaseDecision | null;
  line_name: string | null;
  manager_hr_id: string | null;
  decision_at: string | null;
  decision_snapshot: { score?: { finalScore?: number | null; provisionalScore?: number | null } } | null;
};

function snapshotScore(row: CaseRow): number | null {
  const s = row.decision_snapshot?.score;
  if (!s) return null;
  return s.finalScore ?? s.provisionalScore ?? null;
}

/** Load decided cases and compute the full analytics. Read-only. */
export async function getProbationOutcomesAnalytics(
  nowIso: string = new Date().toISOString(),
): Promise<OutcomesAnalytics> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("probation_cases")
    .select("id, decision, line_name, manager_hr_id, decision_at, decision_snapshot")
    .eq("status", "decided")
    .not("decision", "is", null);
  if (error) throw error;

  const rows = ((data ?? []) as unknown as CaseRow[]).filter(
    (r): r is CaseRow & { decision: ProbationCaseDecision } => r.decision === "pass" || r.decision === "terminate",
  );

  // probation_cases stores only manager_hr_id (there is no manager-name column on the table).
  // Batch-resolve the manager's display name from employees.full_name so the "by manager" grouping
  // shows a human name, not an HR code (show-names-not-codes). Mirrors the CEO dashboard resolver.
  const managerHrIds = Array.from(
    new Set(rows.map((r) => r.manager_hr_id).filter((x): x is string => Boolean(x))),
  );
  const managerNameByHrId = new Map<string, string>();
  if (managerHrIds.length > 0) {
    const { data: managers } = await supabase
      .from("employees")
      .select("hr_id, full_name, nickname")
      .in("hr_id", managerHrIds);
    for (const m of (managers ?? []) as Array<{ hr_id: string; full_name: string | null; nickname: string | null }>) {
      if (m.full_name) managerNameByHrId.set(m.hr_id.toLowerCase(), resolveEmployeeDisplayName(m.full_name, m.nickname));
    }
  }

  const items: DecidedCaseInput[] = rows.map((r) => ({
    decision: r.decision as ProbationCaseDecision,
    score: snapshotScore(r),
    lineName: r.line_name,
    managerHrId: r.manager_hr_id,
    managerName: r.manager_hr_id ? managerNameByHrId.get(r.manager_hr_id.toLowerCase()) ?? null : null,
    decisionAt: r.decision_at,
  }));

  const outcomes = rollupOutcomes(items);

  // Evaluator predictiveness: join each decided case's feedback recommendations to its decision.
  const decisionByCase = new Map<string, ProbationCaseDecision>();
  for (const r of rows) decisionByCase.set(r.id, r.decision as ProbationCaseDecision);
  let predictiveness: PredictivenessRow[] = rollupPredictiveness([]);
  if (rows.length > 0) {
    const { data: fb } = await supabase
      .from("probation_feedback")
      .select("case_id, recommendation")
      .in("case_id", Array.from(decisionByCase.keys()));
    const predInputs: PredictivenessInput[] = ((fb ?? []) as Array<{ case_id: string | null; recommendation: ProbationRecommendation | null }>)
      .filter((f) => f.case_id && f.recommendation)
      .map((f) => ({ recommendation: f.recommendation as ProbationRecommendation, caseDecision: decisionByCase.get(f.case_id as string)! }))
      .filter((f) => Boolean(f.caseDecision));
    predictiveness = rollupPredictiveness(predInputs);
  }

  return { ...outcomes, predictiveness, generatedAt: nowIso };
}
