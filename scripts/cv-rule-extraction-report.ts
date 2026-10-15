// Measures the no-AI CV rule engine against a folder of real CVs, and prints the coverage table.
//
// This exists so the accuracy claims in src/lib/recruitment/rule-extraction/index.ts are
// REPRODUCIBLE rather than something an agent once asserted in a commit message. Point it at the
// CV inbox and it recounts every number from scratch:
//
//   pnpm run recruitment:cv-rule-report "E:/111/Inbox"
//
// It reads local files only — no database, no network, no OpenAI key, no cost. Whatever folder is
// given, every .pdf in it is parsed for its text layer and run through the rules.
//
// Ground truth for the sender/subject context is taken from the exported filename where it is
// present ("..._From(Name (address))_Subject(...)_Date(...)"), because that is the shape the mailbox
// export produces. A folder of plainly-named CVs simply reports no context, which is also a fair
// test — it is what a recruiter-uploaded CV looks like.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { PDFParse } from "pdf-parse";

import { runRuleCvExtraction, type CvRuleContext } from "@/lib/recruitment/rule-extraction";
import { shouldEscalateToAi } from "@/lib/recruitment/cv-extraction-merge";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "cv-rule-extraction-report",
  entry: import.meta.url,
  known: [],
});

// Below this many letters/digits there is no text layer worth reading — the CV is a scan, and
// belongs to the OCR path rather than to this engine. Same threshold as cv-text-layer.ts.
const MIN_READABLE_CHARS = 200;

const FIELDS_IN_SCHEMA = 38;

function contextFromFileName(fileName: string): CvRuleContext {
  const from = /_From\((.*?)\s*\(([^()]*@[^()]*)\)\)/.exec(fileName);
  const subject = /_Subject\((.*?)\)_Date\(/.exec(fileName);
  return {
    senderEmail: from ? from[2]!.trim().toLowerCase() : null,
    senderName: from ? from[1]!.trim() : null,
    subject: subject ? subject[1]!.trim() : null,
  };
}

async function readPdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText({ parseHyperlinks: true });
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

function pct(count: number, total: number): string {
  return total === 0 ? "  n/a" : `${Math.round((count / total) * 100)}%`.padStart(5);
}

async function main(): Promise<void> {
  // A literal "--" is filtered out because pnpm forwards the separator itself as an argument rather
  // than consuming it, so `pnpm run … -- "E:/111/Inbox"` arrives here as ["--", "E:/111/Inbox"].
  const folder = process.argv.slice(2).find((argument) => argument !== "--");
  if (!folder) {
    console.error('Usage: pnpm run recruitment:cv-rule-report "<folder of CVs>"');
    process.exitCode = 1;
    return;
  }

  const files = (await readdir(folder)).filter((name) => /\.pdf$/i.test(name));
  if (files.length === 0) {
    console.error(`No .pdf files found in ${folder}`);
    process.exitCode = 1;
    return;
  }

  let unreadable = 0;
  let failed = 0;
  const results: { filled: number; high: number; fields: Record<string, unknown>; escalate: boolean; isCv: boolean }[] =
    [];

  for (const [index, file] of files.entries()) {
    if (index % 25 === 0) console.log(`  ...${index}/${files.length}`);
    let text = "";
    try {
      text = await readPdfText(await readFile(join(folder, file)));
    } catch {
      failed += 1;
      continue;
    }
    const readable = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (readable < MIN_READABLE_CHARS) {
      unreadable += 1;
      continue;
    }
    const rule = runRuleCvExtraction(text, contextFromFileName(file));
    results.push({
      escalate: shouldEscalateToAi(rule).escalate,
      fields: rule.fields,
      filled: rule.filled,
      high: rule.highConfidence,
      isCv: rule.isCv,
    });
  }

  const total = results.length;
  const has = (key: string) => results.filter((r) => r.fields[key] !== undefined).length;

  console.log(`\n  Folder            ${folder}`);
  console.log(`  Files seen        ${files.length}`);
  console.log(`  Scanned / no text ${unreadable}   (these need OCR, not rules)`);
  console.log(`  Failed to open    ${failed}`);
  console.log(`  MEASURED ON       ${total}\n`);

  console.log("  Field coverage");
  for (const key of [
    "email",
    "phone",
    "fullName",
    "governorate",
    "currentJobTitle",
    "currentEmployer",
    "workHistory",
    "yearsExperience",
    "university",
    "degree",
    "graduationYear",
    "skills",
    "languages",
    "appliedForJobTitle",
    "dateOfBirth",
    "maritalStatus",
    "militaryStatus",
  ]) {
    console.log(`    ${key.padEnd(20)} ${pct(has(key), total)}`);
  }

  const filled = results.reduce((sum, r) => sum + r.filled, 0);
  const high = results.reduce((sum, r) => sum + r.high, 0);
  const sorted = results.map((r) => r.filled).sort((a, b) => a - b);

  console.log(`\n  Fields filled per CV  ${(filled / total).toFixed(1)} of ${FIELDS_IN_SCHEMA}`);
  console.log(`  High confidence       ${(high / total).toFixed(1)}`);
  console.log(`  Median / min / max    ${sorted[Math.floor(total / 2)]} / ${sorted[0]} / ${sorted[total - 1]}`);
  console.log(`  Classified as a CV    ${results.filter((r) => r.isCv).length} of ${total}`);

  const escalated = results.filter((r) => r.escalate).length;
  console.log(`\n  NEEDS AN AI CALL      ${escalated} of ${total}  (${pct(escalated, total).trim()})`);
  console.log(`  COSTS NOTHING         ${total - escalated} of ${total}  (${pct(total - escalated, total).trim()})\n`);
}

await main();
