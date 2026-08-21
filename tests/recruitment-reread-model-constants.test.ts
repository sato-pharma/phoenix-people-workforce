// Recruitment / ATS — the re-read script's "this was not a real read" set must be built from the
// EXPORTED constants, never from strings typed out a second time.
//
// The incident this pins, 2026-08-21. scripts/recruitment-reread-never-read-cvs.ts holds back
// candidates whose only extraction row came from the free engine, so that restoring the OpenAI key
// later re-reads exactly the CVs that were read most poorly. It decided that with a set of two
// hand-typed strings, and the second of them was a value nothing in this repository has ever
// written: the OCR path records OCR_EXTRACTION_MODEL, which is "phoenix-rules+ocr", not the
// shortened form the set carried. A grep for that shortened form returned nothing, and had done
// since the constant was introduced.
//
// So an OCR-only row matched neither entry, was counted as a genuine model read, and its candidate
// was dropped from the re-read set PERMANENTLY — the exact failure the hold-back exists to prevent,
// arriving through the back door, and silent because a set of strings cannot report a typo.
// Production (ozucdzovmcqvepbozvqf), same day:
//
//     select ai_model, count(distinct candidate_id) from ats_candidate_cv_extractions group by 1;
//     gpt-5.4 = 282   phoenix-rules = 36   phoenix-rules+ocr = 4
//
// Four candidates were already frozen, and the count grew on every run made while the key was dead.
//
// The invariant: every model name cv-extraction.ts exports as a NON-MODEL read must appear in that
// set, by identifier. The test derives the list from the library's own source rather than repeating
// it, so a THIRD free engine added tomorrow is caught the day it lands, not the day someone notices
// candidates going quiet.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { OCR_EXTRACTION_MODEL, RULE_ONLY_EXTRACTION_MODEL } from "../src/lib/recruitment/cv-extraction.ts";

const LIB = "src/lib/recruitment/cv-extraction.ts";
const SCRIPT = "scripts/recruitment-reread-never-read-cvs.ts";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

// Every identifier-ish token in a fragment of source. Membership in a Set beats a per-name regex
// built by interpolation: a word-boundary escape assembled inside a template literal becomes a
// BACKSPACE character rather than a boundary, and the resulting check silently matches nothing —
// a test that can only ever pass. This version has no escaping to get wrong.
const identifiersIn = (fragment: string) => new Set(fragment.split(/[^\w$]+/).filter(Boolean));

// Comments go first wherever this file scans for a dead VALUE. The paragraph above the set in the
// script names that value deliberately, so the next reader knows what to look for — history in a
// comment is not a string in a set, and a guard that cannot tell them apart forces the explanation
// to be deleted to stay green. Only line-leading `//` is stripped, so a `//` inside a URL survives.
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

// A non-model read is recorded under Phoenix's own name — "phoenix-rules", "phoenix-rules+ocr".
// A read the model did is recorded under the MODEL's name ("gpt-5.4", or the model plus a "+rules"
// suffix when the rules filled the gaps), so cost stays attributable to it. That is the
// discriminator, and it is why this list can be derived instead of maintained: an exported constant
// in cv-extraction.ts whose literal value begins "phoenix-" is a read no model was involved in.
function nonModelExtractionConstants(librarySource: string): { name: string; value: string }[] {
  return [...librarySource.matchAll(/export const (\w+) = "(phoenix-[^"]*)";/g)].map((match) => ({
    name: match[1],
    value: match[2],
  }));
}

export function runRecruitmentRereadModelConstantsTests() {
  const librarySource = read(LIB);
  const scriptSource = read(SCRIPT);

  // --- 1. The parser still sees the library, so nothing below can pass vacuously ----------------
  // A regex that matches nothing satisfies every "all of them are present" loop there is.
  const nonModel = nonModelExtractionConstants(librarySource);
  const names = nonModel.map((entry) => entry.name);
  assert.ok(
    nonModel.length >= 2,
    `expected ${LIB} to export at least the two non-model read names, found ${nonModel.length} — if those declarations were reshaped, repair this parser rather than deleting the check`,
  );
  for (const anchor of ["RULE_ONLY_EXTRACTION_MODEL", "OCR_EXTRACTION_MODEL"]) {
    assert.ok(names.includes(anchor), `${anchor} is no longer exported from ${LIB} as a "phoenix-" model name`);
  }

  // --- 2. THE HEADLINE. Every one of them is in the script's exclusion set ----------------------
  const setBody = scriptSource.match(/const RULES_ONLY_MODELS\s*=\s*new Set(?:<[^>]*>)?\(\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(
    setBody,
    `could not find the RULES_ONLY_MODELS set literal in ${SCRIPT} — it was renamed or restructured; re-point this test at it, because without the hold-back a rules-only candidate is excluded from every future re-read forever`,
  );
  const heldBack = identifiersIn(setBody[1]);
  for (const entry of nonModel) {
    assert.ok(
      heldBack.has(entry.name),
      `${entry.name} ("${entry.value}") is a NON-MODEL read but is MISSING from RULES_ONLY_MODELS in ${SCRIPT} — every candidate read only that way counts as already read and is dropped from the re-read set PERMANENTLY`,
    );
  }

  // --- 3. ...by identifier. A re-typed string is the defect itself -----------------------------
  const literalsInSet = setBody[1].match(/"[^"]*"|'[^']*'|`[^`]*`/g) ?? [];
  assert.deepEqual(
    literalsInSet,
    [],
    `RULES_ONLY_MODELS must hold the imported constants, not string literals — ${literalsInSet.join(", ")} can drift from ${LIB} silently, which is exactly how a name nothing writes survived in the set`,
  );
  const importBlock = scriptSource.match(/import \{([^}]*)\} from "@\/lib\/recruitment\/cv-extraction";/);
  assert.ok(importBlock, `${SCRIPT} must import from @/lib/recruitment/cv-extraction`);
  const imported = identifiersIn(importBlock[1]);
  for (const entry of nonModel) {
    assert.ok(
      imported.has(entry.name),
      `${entry.name} must be imported from @/lib/recruitment/cv-extraction in ${SCRIPT} — a locally redeclared copy is a literal wearing a constant's name`,
    );
  }

  // --- 4. The dead value must not come back as code ---------------------------------------------
  assert.doesNotMatch(
    withoutComments(scriptSource),
    /phoenix-ocr(?![+\w-])/,
    'the OCR model name is "phoenix-rules+ocr"; the shortened form was never written by anything and matched no row for the whole time it sat in the set',
  );

  // --- 5. The values themselves are a data contract, not a naming choice -----------------------
  // These strings are already sitting in ats_candidate_cv_extractions.ai_model in production
  // (phoenix-rules on 36 candidates, phoenix-rules+ocr on 4, read 2026-08-21). Changing a value
  // orphans the stored rows: the script would stop recognising them and would freeze those
  // candidates the same way. Renaming one needs the existing rows migrated in the same change.
  assert.equal(RULE_ONLY_EXTRACTION_MODEL, "phoenix-rules");
  assert.equal(OCR_EXTRACTION_MODEL, "phoenix-rules+ocr");

  // --- 6. The write side spells them the same way ----------------------------------------------
  // A constant on the read side is worth nothing if the row was written with a hand-typed string.
  assert.match(
    librarySource,
    /model: RULE_ONLY_EXTRACTION_MODEL/,
    "the rules-only write path must stamp ai_model from the constant, not from a repeated string",
  );
  assert.match(
    librarySource,
    /model: OCR_EXTRACTION_MODEL/,
    "the OCR write path must stamp ai_model from the constant, not from a repeated string",
  );
}
