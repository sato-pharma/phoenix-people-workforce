import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Every module that PERSISTS a CV extraction must also APPLY it to the candidate.
//
// This is a wiring invariant, not a formatting one. Extraction has two writers — inbound intake
// (cv-intake-service.ts) and the re-read path (cv-extraction.ts, used by the per-candidate
// "re-run extraction" button and every bulk re-read). Until 2026-08-23 only the first applied
// anything. The second persisted to extracted_fields and returned, which was correct while a
// review queue existed to collect the proposals — that queue was removed on 2026-08-15, and from
// then on a re-read's findings had no screen anywhere and no writer.
//
// Measured on production before the fix: of 189 candidates with a blank governorate, the 169 read
// by a rules-involving model had all been extracted 65-80 hours AFTER the candidate was created
// (bulk re-reads), and none of ~130 high-confidence universities had reached a single row.
//
// The test is written against the set of persisters rather than against the one function that was
// broken, so a THIRD extraction path added later fails here instead of silently repeating this.
const recruitmentDir = new URL("../src/lib/recruitment/", import.meta.url);

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, recruitmentDir), "utf8");
}

function collectSourceFiles(dir: URL, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".ts")) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

export function runCvRereadAppliesWhatItReadsTests() {
  const extractionSource = readSource("cv-extraction.ts");

  // 1. The re-read path applies. This is the regression the fix exists for: assert the call sits
  //    inside extractCandidateFieldsFromCv, not merely somewhere in the file.
  const rereadStart = extractionSource.indexOf("export async function extractCandidateFieldsFromCv");
  assert.ok(rereadStart > 0, "extractCandidateFieldsFromCv must still exist in cv-extraction.ts");
  const rereadBody = extractionSource.slice(rereadStart);
  assert.ok(
    rereadBody.includes("selectAutoApplyFields("),
    "the CV re-read path must apply what it reads — without this a re-read writes extracted_fields and stops there, which is exactly how ~130 high-confidence fields never reached a candidate",
  );
  assert.ok(
    rereadBody.includes("await updateCandidate("),
    "selecting the auto-apply subset is not enough; the re-read must actually write it to the candidate",
  );

  // 2. Phone stays excluded on a re-read. The candidate already existed, so its identity was
  //    resolved by a different CV; rewriting the dedupe-deciding number could repoint a record.
  assert.ok(
    /candidateWasCreatedByThisIntake:\s*false/.test(rereadBody),
    "a re-read must pass candidateWasCreatedByThisIntake: false, which is what keeps phone out of an unattended write on an existing candidate",
  );

  // 3. Enrichment must never fail the extraction. The row is persisted and returned either way.
  const applyBlock = rereadBody.slice(rereadBody.indexOf("selectAutoApplyFields("));
  assert.ok(
    applyBlock.slice(0, applyBlock.indexOf("return {")).includes("catch"),
    "auto-apply on re-read must be best-effort — a write failure must not turn a successful read into a thrown error",
  );

  // 4. The general invariant: every persister applies. Catches a future third path.
  const persisters = collectSourceFiles(recruitmentDir).filter((file) => {
    if (file.endsWith("cv-extraction.ts")) return true;
    const source = readSource(file);
    return source.includes("persistCvExtraction(") && !source.includes("export async function persistCvExtraction");
  });
  assert.ok(
    persisters.length >= 2,
    `expected at least the two known extraction persisters, found ${persisters.length}`,
  );
  for (const file of persisters) {
    assert.ok(
      readSource(file).includes("selectAutoApplyFields"),
      `${file} persists a CV extraction but never applies it to the candidate — that is the shape that left production data unread for eight days`,
    );
  }
}
