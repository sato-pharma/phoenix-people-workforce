export type __AuditDashboardGeneratorModule = never;

import fs from "node:fs";
import path from "node:path";

const REGISTRY_PATH = path.resolve(
  process.cwd(),
  "docs/production-audits/_registry/audit-registry.json",
);

const DASHBOARD_PATH = path.resolve(
  process.cwd(),
  "docs/production-audits/MANAGEMENT-DASHBOARD.md",
);

type TopBusinessRisk = {
  risk: string;
  businessImpact: string;
  requiredAction: string;
};

type AuditRecord = {
  moduleName: string;
  moduleSlug: string;
  auditCycle: number;
  currentStage:
    | "NOT AUDITED"
    | "AUDIT COMPLETED"
    | "FIX REQUIRED"
    | "FIX COMPLETED"
    | "VERIFICATION REQUIRED"
    | "VERIFICATION COMPLETED"
    | "PRODUCTION GO";
  score: number | null;
  simpleAverageScore: number | null;
  weightedAverageScore: number | null;
  verdict: "GO" | "CONDITIONAL GO" | "NO GO" | "NOT AUDITED";
  criticalIssues: number;
  highIssues: number;
  mediumIssues: number;
  lowIssues: number;
  blocksLaunch: boolean;
  requiredNextAction: string;
  managerSummary: string;
  topBusinessRisks: TopBusinessRisk[];
  latestAuditFile: string | null;
  latestFixFile: string | null;
  latestVerificationFile: string | null;
  lastUpdated: string;
};

function translateToBusinessLanguage(text: string): string {
  return text
    .replace(/\bRLS\b/g, "database privacy rules")
    .replace(/\bAPI\b/g, "system connection")
    .replace(/\bAuthorization\b/g, "access control")
    .replace(/\bData integrity\b/g, "data accuracy")
    .replace(/\bRegression\b/g, "risk that a fix breaks something that worked before")
    .replace(/\bObservability\b/g, "ability to see system errors clearly")
    .replace(/\bBuild\b/g, "deployment packaging check")
    .replace(/\bTypecheck\b/g, "technical structure check")
    .replace(/\bLint\b/g, "code quality check");
}

function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return translateToBusinessLanguage(value.trim());
}

function pickDisplayScore(record: AuditRecord): number | null {
  if (record.weightedAverageScore !== null) return record.weightedAverageScore;
  if (record.simpleAverageScore !== null) return record.simpleAverageScore;
  return record.score;
}

function formatScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

function computeOverallStatus(records: AuditRecord[]): {
  headline: string;
  explanation: string;
} {
  if (records.length === 0) {
    return {
      headline: "Not enough information yet",
      explanation: "No modules are listed in the audit registry yet.",
    };
  }

  const audited = records.filter((r) => r.currentStage !== "NOT AUDITED");
  if (audited.length === 0) {
    return {
      headline: "Not enough information yet",
      explanation:
        "Modules have not been audited yet. We cannot make a confident launch decision without audit evidence.",
    };
  }

  const blocking = records.filter((r) => r.blocksLaunch || r.verdict === "NO GO");
  if (blocking.length > 0) {
    return {
      headline: "Not ready to launch",
      explanation:
        "At least one module is marked as blocking launch. Fix the listed blockers, verify them, and then re-check this dashboard.",
    };
  }

  const conditional = records.filter((r) => r.verdict === "CONDITIONAL GO");
  if (conditional.length > 0) {
    return {
      headline: "Launch is possible only after specific fixes",
      explanation:
        "Some modules are close to ready, but require specific fixes and verification before launch. Treat these as mandatory conditions.",
    };
  }

  const go = records.every((r) => r.verdict === "GO" || r.verdict === "NOT AUDITED");
  if (go) {
    return {
      headline: "Generally ready (based on audited modules)",
      explanation:
        "Audited modules are marked GO and no module is blocking launch. Continue normal monitoring and keep audits up to date.",
    };
  }

  return {
    headline: "Needs review",
    explanation:
      "The registry contains mixed statuses. Review the module rows and resolve blockers and conditions.",
  };
}

function collectTopRisks(records: AuditRecord[]): Array<{
  risk: string;
  affectedModule: string;
  businessImpact: string;
  requiredAction: string;
}> {
  const items: Array<{
    risk: string;
    affectedModule: string;
    businessImpact: string;
    requiredAction: string;
    sortWeight: number;
  }> = [];

  for (const r of records) {
    const moduleWeight =
      (r.blocksLaunch ? 1000 : 0) + r.criticalIssues * 50 + r.highIssues * 10;

    for (const risk of r.topBusinessRisks ?? []) {
      items.push({
        risk: safeText(risk.risk),
        affectedModule: safeText(r.moduleName),
        businessImpact: safeText(risk.businessImpact),
        requiredAction: safeText(risk.requiredAction),
        sortWeight: moduleWeight,
      });
    }
  }

  const notAuditedCount = records.filter((r) => r.currentStage === "NOT AUDITED").length;
  const auditedCount = records.length - notAuditedCount;
  if (auditedCount === 0 || notAuditedCount > 0) {
    items.push({
      risk: "Not enough audit coverage yet",
      affectedModule: "Multiple modules",
      businessImpact:
        "We may miss serious launch risks because the work is not documented and verified.",
      requiredAction: "Start auditing the highest-impact modules and keep the registry updated.",
      sortWeight: 5,
    });
  }

  items.sort((a, b) => b.sortWeight - a.sortWeight);

  return items.slice(0, 10).map((i) => ({
    risk: i.risk,
    affectedModule: i.affectedModule,
    businessImpact: i.businessImpact,
    requiredAction: i.requiredAction,
  }));
}

function collectNextActions(records: AuditRecord[]): string[] {
  const prioritized = [...records].sort((a, b) => {
    const aw = (a.blocksLaunch ? 1000 : 0) + a.criticalIssues * 50 + a.highIssues * 10;
    const bw = (b.blocksLaunch ? 1000 : 0) + b.criticalIssues * 50 + b.highIssues * 10;
    return bw - aw;
  });

  const actions: string[] = [];
  for (const r of prioritized) {
    const action = safeText(r.requiredNextAction);
    if (!action) continue;
    actions.push(`${safeText(r.moduleName)}: ${action}`);
    if (actions.length >= 8) break;
  }

  if (actions.length === 0) {
    actions.push("Add the first real module to the audit registry and complete the first audit cycle file.");
  }

  return actions;
}

function renderTableRow(cells: string[]): string {
  return `| ${cells.map((c) => (c === "" ? "—" : c)).join(" | ")} |`;
}

function main(): void {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`Audit registry file not found: ${REGISTRY_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const parsed = JSON.parse(raw) as AuditRecord[];

  const records = Array.isArray(parsed) ? parsed : [];

  const overall = computeOverallStatus(records);
  const risks = collectTopRisks(records);
  const nextActions = collectNextActions(records);

  const lines: string[] = [];

  lines.push("# Phoenix Workforce — Production Readiness Dashboard");
  lines.push("");
  lines.push("## Overall Launch Status");
  lines.push(safeText(overall.headline));
  lines.push("");
  lines.push(safeText(overall.explanation));
  lines.push("");
  lines.push("## Module Readiness Summary");
  lines.push(
    "| Module | Current Stage | Score | Verdict | Critical Issues | High Issues | Blocks Launch? | Required Next Action |",
  );
  lines.push("|---|---|---:|---|---:|---:|---|---|");

  if (records.length === 0) {
    lines.push(
      renderTableRow([
        "No modules listed yet",
        "NOT AUDITED",
        "—",
        "NOT AUDITED",
        "0",
        "0",
        "No",
        "Add the first module to the registry",
      ]),
    );
  } else {
    for (const r of records) {
      const displayScore = pickDisplayScore(r);
      lines.push(
        renderTableRow([
          safeText(r.moduleName),
          safeText(r.currentStage),
          formatScore(displayScore),
          safeText(r.verdict),
          String(r.criticalIssues ?? 0),
          String(r.highIssues ?? 0),
          r.blocksLaunch ? "Yes" : "No",
          safeText(r.requiredNextAction),
        ]),
      );
    }
  }

  lines.push("");
  lines.push("## What the Scores Mean");
  lines.push("- 9.0–10 = Ready / strong");
  lines.push("- 8.0–8.9 = Almost ready");
  lines.push("- 7.0–7.9 = Needs fixes before launch");
  lines.push("- Below 7 = Not ready");
  lines.push("");
  lines.push("## What the Verdicts Mean");
  lines.push("- GO: Ready to launch with normal monitoring");
  lines.push("- CONDITIONAL GO: Can launch only after specific fixes are completed and verified");
  lines.push("- NO GO: Must not launch until major risks are fixed and verified");
  lines.push("");
  lines.push("## Current Top Risks");
  lines.push("| Risk | Affected Module | Business Impact | Required Action |");
  lines.push("|---|---|---|---|");

  for (const risk of risks) {
    lines.push(
      renderTableRow([
        safeText(risk.risk),
        safeText(risk.affectedModule),
        safeText(risk.businessImpact),
        safeText(risk.requiredAction),
      ]),
    );
  }

  lines.push("");
  lines.push("## Next Recommended Actions");
  for (const action of nextActions) {
    lines.push(`- ${safeText(action)}`);
  }

  lines.push("");

  const output = lines.join("\n");
  fs.mkdirSync(path.dirname(DASHBOARD_PATH), { recursive: true });
  fs.writeFileSync(DASHBOARD_PATH, output, "utf8");

  console.log("Management dashboard generated.");
  console.log(`Registry: ${path.relative(process.cwd(), REGISTRY_PATH)}`);
  console.log(`Dashboard: ${path.relative(process.cwd(), DASHBOARD_PATH)}`);
}

main();
