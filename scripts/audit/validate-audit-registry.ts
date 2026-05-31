export type __AuditRegistryValidatorModule = never;

import fs from "node:fs";
import path from "node:path";

const REGISTRY_PATH = path.resolve(
  process.cwd(),
  "docs/production-audits/_registry/audit-registry.json",
);

const ALLOWED_VERDICTS = [
  "GO",
  "CONDITIONAL GO",
  "NO GO",
  "NOT AUDITED",
] as const;

const ALLOWED_STAGES = [
  "NOT AUDITED",
  "AUDIT COMPLETED",
  "FIX REQUIRED",
  "FIX COMPLETED",
  "VERIFICATION REQUIRED",
  "VERIFICATION COMPLETED",
  "PRODUCTION GO",
] as const;

type AllowedVerdict = (typeof ALLOWED_VERDICTS)[number];
type AllowedStage = (typeof ALLOWED_STAGES)[number];

type TopBusinessRisk = {
  risk: string;
  businessImpact: string;
  requiredAction: string;
};

type AuditRecord = {
  moduleName: string;
  moduleSlug: string;
  auditCycle: number;
  currentStage: AllowedStage;
  score: number | null;
  simpleAverageScore: number | null;
  weightedAverageScore: number | null;
  verdict: AllowedVerdict;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidSlug(value: unknown): value is string {
  return isNonEmptyString(value) && /^[a-z0-9-]+$/.test(value.trim());
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 10
  );
}

function isAllowedVerdict(value: unknown): value is AllowedVerdict {
  return typeof value === "string" && (ALLOWED_VERDICTS as readonly string[]).includes(value);
}

function isAllowedStage(value: unknown): value is AllowedStage {
  return typeof value === "string" && (ALLOWED_STAGES as readonly string[]).includes(value);
}

function existsIfProvided(filePathValue: unknown): { ok: boolean; resolved?: string } {
  if (filePathValue === null) return { ok: true };
  if (!isNonEmptyString(filePathValue)) return { ok: false };

  const resolved = path.resolve(process.cwd(), filePathValue);
  return { ok: fs.existsSync(resolved), resolved };
}

function mustHaveReadableManagerSummary(record: AuditRecord): boolean {
  if (record.currentStage === "NOT AUDITED") return false;
  if (record.verdict === "NOT AUDITED") return false;
  return true;
}

function pickDisplayScore(record: AuditRecord): number | null {
  if (record.weightedAverageScore !== null) return record.weightedAverageScore;
  if (record.simpleAverageScore !== null) return record.simpleAverageScore;
  return record.score;
}

function summarizeVerdict(records: AuditRecord[]): string {
  const anyNoGo = records.some((r) => r.verdict === "NO GO" || r.blocksLaunch);
  if (anyNoGo) return "NO GO";

  const anyConditional = records.some((r) => r.verdict === "CONDITIONAL GO");
  if (anyConditional) return "CONDITIONAL GO";

  const anyGo = records.some((r) => r.verdict === "GO");
  if (anyGo) return "GO";

  return "NOT AUDITED";
}

function validateTopBusinessRisks(value: unknown): { ok: boolean; message?: string } {
  if (!Array.isArray(value)) return { ok: false, message: "topBusinessRisks must be an array" };

  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isRecord(item)) return { ok: false, message: `topBusinessRisks[${i}] must be an object` };
    if (!isNonEmptyString(item.risk)) return { ok: false, message: `topBusinessRisks[${i}].risk is required` };
    if (!isNonEmptyString(item.businessImpact))
      return { ok: false, message: `topBusinessRisks[${i}].businessImpact is required` };
    if (!isNonEmptyString(item.requiredAction))
      return { ok: false, message: `topBusinessRisks[${i}].requiredAction is required` };
  }

  return { ok: true };
}

function main(): void {
  const errors: string[] = [];

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`Audit registry file not found: ${REGISTRY_PATH}`);
    process.exit(1);
  }

  let rawText = "";
  try {
    rawText = fs.readFileSync(REGISTRY_PATH, "utf8");
  } catch (err) {
    console.error(`Failed to read audit registry: ${REGISTRY_PATH}`);
    console.error(err);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error("Audit registry is not valid JSON.");
    console.error(err);
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error("Audit registry must be a JSON array.");
    process.exit(1);
  }

  const records: AuditRecord[] = [];

  for (let i = 0; i < parsed.length; i += 1) {
    const value = parsed[i];
    const recordErrors: string[] = [];
    if (!isRecord(value)) {
      errors.push(`Record #${i + 1} must be a JSON object`);
      continue;
    }

    const record = value as Partial<AuditRecord>;

    if (!isNonEmptyString(record.moduleName)) recordErrors.push(`moduleName is required`);
    if (!isValidSlug(record.moduleSlug))
      recordErrors.push(`moduleSlug is required and must be like "payroll-expenses"`);

    if (!isNonNegativeInteger(record.auditCycle)) recordErrors.push(`auditCycle must be a non-negative integer`);

    if (!isAllowedStage(record.currentStage))
      recordErrors.push(
        `Record #${i + 1}: currentStage must be one of: ${ALLOWED_STAGES.join(", ")}`,
      );

    if (!isAllowedVerdict(record.verdict))
      recordErrors.push(`verdict must be one of: ${ALLOWED_VERDICTS.join(", ")}`);

    const scoreFields: Array<[keyof Pick<AuditRecord, "score" | "simpleAverageScore" | "weightedAverageScore">, unknown]> =
      [
        ["score", record.score],
        ["simpleAverageScore", record.simpleAverageScore],
        ["weightedAverageScore", record.weightedAverageScore],
      ];

    for (const [fieldName, fieldValue] of scoreFields) {
      if (fieldValue === null) continue;
      if (!isScore(fieldValue)) recordErrors.push(`${fieldName} must be between 0 and 10 (or null)`);
    }

    const issueFields: Array<[keyof Pick<AuditRecord, "criticalIssues" | "highIssues" | "mediumIssues" | "lowIssues">, unknown]> =
      [
        ["criticalIssues", record.criticalIssues],
        ["highIssues", record.highIssues],
        ["mediumIssues", record.mediumIssues],
        ["lowIssues", record.lowIssues],
      ];

    for (const [fieldName, fieldValue] of issueFields) {
      if (!isNonNegativeInteger(fieldValue)) recordErrors.push(`${fieldName} must be a non-negative integer`);
    }

    if (typeof record.blocksLaunch !== "boolean") recordErrors.push(`blocksLaunch must be true/false`);
    if (!isNonEmptyString(record.requiredNextAction)) recordErrors.push(`requiredNextAction is required`);
    if (!isNonEmptyString(record.managerSummary)) recordErrors.push(`managerSummary is required`);

    const risksCheck = validateTopBusinessRisks(record.topBusinessRisks);
    if (!risksCheck.ok) recordErrors.push(risksCheck.message ?? "topBusinessRisks is invalid");

    if (!isNonEmptyString(record.lastUpdated)) {
      recordErrors.push(`lastUpdated is required`);
    } else {
      const d = new Date(record.lastUpdated);
      if (Number.isNaN(d.getTime())) recordErrors.push(`lastUpdated must be an ISO date string`);
    }

    const auditFileCheck = existsIfProvided(record.latestAuditFile ?? null);
    if (!auditFileCheck.ok) recordErrors.push(`latestAuditFile must be a valid file path or null`);

    const fixFileCheck = existsIfProvided(record.latestFixFile ?? null);
    if (!fixFileCheck.ok) recordErrors.push(`latestFixFile must be a valid file path or null`);

    const verificationFileCheck = existsIfProvided(record.latestVerificationFile ?? null);
    if (!verificationFileCheck.ok) recordErrors.push(`latestVerificationFile must be a valid file path or null`);

    if (isAllowedStage(record.currentStage)) {
      const stage = record.currentStage;

      const needsAuditFile = stage !== "NOT AUDITED";
      const needsFixFile = stage === "FIX COMPLETED" || stage === "VERIFICATION REQUIRED" || stage === "VERIFICATION COMPLETED" || stage === "PRODUCTION GO";
      const needsVerificationFile = stage === "VERIFICATION COMPLETED" || stage === "PRODUCTION GO";

      if (needsAuditFile) {
        if (!isNonEmptyString(record.latestAuditFile)) {
          recordErrors.push(`latestAuditFile is required for currentStage "${stage}"`);
        } else if (!auditFileCheck.ok || (auditFileCheck.resolved && !fs.existsSync(auditFileCheck.resolved))) {
          recordErrors.push(`latestAuditFile does not exist on disk for currentStage "${stage}"`);
        }
      }

      if (needsFixFile) {
        if (!isNonEmptyString(record.latestFixFile)) {
          recordErrors.push(`latestFixFile is required for currentStage "${stage}"`);
        } else if (!fixFileCheck.ok || (fixFileCheck.resolved && !fs.existsSync(fixFileCheck.resolved))) {
          recordErrors.push(`latestFixFile does not exist on disk for currentStage "${stage}"`);
        }
      }

      if (needsVerificationFile) {
        if (!isNonEmptyString(record.latestVerificationFile)) {
          recordErrors.push(`latestVerificationFile is required for currentStage "${stage}"`);
        } else if (
          !verificationFileCheck.ok ||
          (verificationFileCheck.resolved && !fs.existsSync(verificationFileCheck.resolved))
        ) {
          recordErrors.push(`latestVerificationFile does not exist on disk for currentStage "${stage}"`);
        }
      }
    }

    if (isAllowedStage(record.currentStage) && isAllowedVerdict(record.verdict)) {
      const typed = record as AuditRecord;
      if (mustHaveReadableManagerSummary(typed)) {
        const summary = typed.managerSummary.trim();
        if (summary.length < 30 || !summary.includes(" ")) {
          recordErrors.push(`managerSummary must be readable (at least a couple of sentences) when audited`);
        }
      }

      if (typed.currentStage !== "NOT AUDITED") {
        const displayScore = pickDisplayScore(typed);
        if (displayScore === null) {
          recordErrors.push(`score fields must be filled when currentStage is not "NOT AUDITED"`);
        }
      }
    }

    if (recordErrors.length > 0) {
      for (const msg of recordErrors) errors.push(`Record #${i + 1}: ${msg}`);
      continue;
    }

    if (isAllowedStage(record.currentStage) && isAllowedVerdict(record.verdict)) {
      records.push(record as AuditRecord);
    }
  }

  if (errors.length > 0) {
    console.error("Audit registry validation failed.");
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  const auditedCount = records.filter((r) => r.currentStage !== "NOT AUDITED").length;
  const blocksLaunchCount = records.filter((r) => r.blocksLaunch || r.verdict === "NO GO").length;
  const overallVerdict = summarizeVerdict(records);

  console.log("Audit registry validation passed.");
  console.log(`Registry file: ${path.relative(process.cwd(), REGISTRY_PATH)}`);
  console.log(`Total modules: ${records.length}`);
  console.log(`Audited modules: ${auditedCount}`);
  console.log(`Modules blocking launch: ${blocksLaunchCount}`);
  console.log(`Overall status (from registry): ${overallVerdict}`);
}

main();
