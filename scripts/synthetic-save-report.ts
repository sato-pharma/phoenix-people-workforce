import fs from "node:fs";
import path from "node:path";

import { ingestSyntheticJourneyReport, type JourneyResult } from "@/lib/synthetic-journeys/service";

const reportPath = path.resolve(process.cwd(), process.argv[2] ?? "tests/synthetic/report/latest.json");

if (!fs.existsSync(reportPath)) {
  console.error(`No report found at ${reportPath}. Run "npm run synthetic:test" first.`);
  process.exit(1);
}

const raw = fs.readFileSync(reportPath, "utf-8");
let journeyResults: JourneyResult[];
try {
  journeyResults = JSON.parse(raw) as JourneyResult[];
} catch (error) {
  console.error(`Failed to parse ${reportPath} as JSON:`, error);
  process.exit(1);
}

if (!Array.isArray(journeyResults) || journeyResults.length === 0) {
  console.error(`${reportPath} is empty or not an array. Nothing to save.`);
  process.exit(1);
}

const baseUrl = process.env.SYNTHETIC_BASE_URL ?? "unknown";

const run = await ingestSyntheticJourneyReport(journeyResults, {
  baseUrl,
  createdBy: process.env.USER ?? process.env.USERNAME ?? "local-script",
});

console.log(
  `Saved run ${run.id}: ${run.overallStatus} (${run.passedCount} passed, ${run.failedCount} failed, ${run.skippedCount} skipped).`,
);
