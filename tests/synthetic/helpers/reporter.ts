import fs from "node:fs";
import path from "node:path";

import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { declaredSkipReason } from "./skip-reason";
import type { JourneyResult } from "./types";

const REPORT_DIR = "tests/synthetic/report";

function statusIcon(status: JourneyResult["status"]): string {
  if (status === "passed") return "PASS";
  if (status === "skipped") return "SKIP";
  return "FAIL";
}

function printSummaryTable(results: JourneyResult[]): void {
  console.log("\nSynthetic User Journeys — summary\n");
  for (const r of results) {
    console.log(`[${statusIcon(r.status)}] ${r.journeyName} (${r.route}) — ${r.durationMs}ms`);
    if (r.status === "failed") {
      for (const err of r.errors) console.log(`   error: ${err}`);
      if (r.recommendation) console.log(`   next: ${r.recommendation}`);
    }
    if (r.status === "skipped" && r.skipReason) console.log(`   on purpose: ${r.skipReason}`);
  }
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`Full report: ${path.join(REPORT_DIR, "latest.md")}\n`);
}

function toMarkdown(results: JourneyResult[]): string {
  const lines: string[] = [
    "# Synthetic User Journeys — report",
    "",
    "| Journey | Route | Role | Status | Duration | Errors | Recommendation |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of results) {
    const errors = r.errors.join("; ").replace(/\|/g, "\\|") || "-";
    lines.push(
      `| ${r.journeyName} | ${r.route} | ${r.role} | ${statusIcon(r.status)} | ${r.durationMs}ms | ${errors} | ${r.recommendation ?? "-"} |`,
    );
  }
  lines.push("");
  for (const r of results) {
    if (r.consoleErrors.length || r.networkErrors.length || r.screenshotPath) {
      lines.push(`## ${r.journeyName}`, "");
      if (r.consoleErrors.length) {
        lines.push("**Console errors:**", ...r.consoleErrors.map((e) => `- ${e}`), "");
      }
      if (r.networkErrors.length) {
        lines.push("**Network errors:**", ...r.networkErrors.map((e) => `- ${e}`), "");
      }
      if (r.screenshotPath) {
        lines.push(`**Screenshot:** \`${r.screenshotPath}\``, "");
      }
    }
  }
  return lines.join("\n");
}

/**
 * Collects the typed JourneyResult each journey attaches via
 * testInfo.attach("journey-result", ...) and, on run end, writes the
 * machine-readable + human-readable report. Falls back to a minimal result
 * built from Playwright's own status/duration/screenshot for tests that
 * never reached the attach step (e.g. a skipped setup dependency or a crash
 * inside run-journey.ts itself).
 */
export default class SyntheticReporter implements Reporter {
  private results: JourneyResult[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find((a) => a.name === "journey-result");
    const screenshot = result.attachments.find((a) => a.name === "screenshot");

    if (attachment?.body) {
      const parsed = JSON.parse(attachment.body.toString("utf-8")) as JourneyResult;
      if (screenshot?.path) parsed.screenshotPath = screenshot.path;
      this.results.push(parsed);
      return;
    }

    const status: JourneyResult["status"] =
      result.status === "passed" ? "passed" : result.status === "skipped" ? "skipped" : "failed";

    this.results.push({
      journeyId: test.id,
      journeyName: test.title,
      route: "unknown",
      role: "unknown",
      status,
      durationMs: result.duration,
      errors: result.errors.map((e) => e.message ?? String(e)),
      consoleErrors: [],
      networkErrors: [],
      screenshotPath: screenshot?.path,
      // A check that skipped itself said why, and a run is not marked down for it. One skipped with
      // no reason — the sign-in step before it failed, say — carries none and still is.
      skipReason:
        status === "skipped" ? declaredSkipReason([...(result.annotations ?? []), ...test.annotations]) : undefined,
      recommendation:
        status === "failed"
          ? "This step crashed before it could report structured journey results — check the error above (often a login/auth-setup failure)."
          : undefined,
    });
  }

  onEnd(_result: FullResult): void {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, "latest.json"), JSON.stringify(this.results, null, 2));
    fs.writeFileSync(path.join(REPORT_DIR, "latest.md"), toMarkdown(this.results));
    printSummaryTable(this.results);
  }
}
