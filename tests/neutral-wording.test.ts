import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Nothing this app shows anybody assumes its subject is a man.
 *
 * ## Why this exists
 *
 * The owner reported it on the field activity report, which called B-154 "he" in six places and
 * labelled her outstation claim "His own phone fix". She is a District Sales Manager. The same
 * default was written across the whole app: **275 non-comment lines when it was measured on
 * 2026-10-05**, from the Phoenix CRM screens a rep opens every working day to the notices that
 * leave the building by email and Telegram.
 *
 * ## Why neutral, and not the gender we hold
 *
 * `employees.gender` exists and is populated — measured the same day on production, for active
 * employees: **88 female, 87 male, 31 blank**. The workforce is majority women, and 31 people have
 * no answer at all, so a pronoun lookup still needs a neutral fallback and the neutral wording has
 * to be right anyway. One neutral sentence is correct for every subject, so there is only one.
 *
 * ## What is deliberately NOT in scope
 *
 *   - 🔒 **Comments, and a test's own name and assertion messages.** Asked directly on 2026-10-05,
 *     with the count in front of him — about 6,200 lines — the owner answered **"leave the code
 *     comments as they are"**. A developer note saying "he saves the visit" is not what anyone in
 *     the field reads, and rewriting hundreds would bury the change that matters.
 *     `tests/phoenix-crm-am-pm-words.test.ts` draws the same line for the same reason. **It is
 *     settled: never propose it, and never widen this guard past `stripComments` to reach them.**
 *     `stripComments` is the repo's one sanctioned stripper — a hand-rolled line classifier reads
 *     the body of a multi-line JSX comment as code and fails a correct file.
 *   - **The Arabic on the HR papers.** Asked directly on 2026-10-05, the owner answered "leave the
 *     Arabic papers as supplied". Arabic has no neutral equivalent of "they", the text is his and
 *     signing documents turn on it. It is settled: `.claude/rules/hiring-documents.md`.
 *   - **`mobile/`**, which is frozen.
 *
 * Everything that may still carry a masculine word is named below with its reason. Add to it only
 * for something that is NOT the default — the owner's own recorded words, a role that is a single
 * named person, or a pronoun that is already derived correctly.
 */
export function runNeutralWordingTests() {
  const MASCULINE = /\b(?:he|his|him|himself)\b/i;

  /** Whole files whose "he" is the owner's own voice or a deliberate mechanism. */
  const EXEMPT_FILES = new Map([
    [
      "src/lib/hiring-pack/experience-certificate-en.ts",
      "pronounsFor() resolves he / she / they from the SAME value as the honorific, so the page can "
        + "never read \"Ms. … he held the position\". A certificate read at an embassy names a "
        + "person; neutralising this would be the regression.",
    ],
    [
      "src/lib/hiring-pack/template-registry.ts",
      "dated provenance notes whose \"he\" is the OWNER — \"he asked whether it was compatible\", "
        + "\"his legal substance throughout\". Rewriting a dated record to make a sweep clean "
        + "destroys the account of where each paper came from.",
    ],
    [
      "src/lib/sales/office-golden-rule.ts",
      "the owner's own ruling, quoted. The file is locked by tests/office-golden-rule-lock.test.ts "
        + "and CLAUDE.md; a wording change here is exactly what that lock exists to catch.",
    ],
    [
      "src/lib/sales/july-2026-direct-orders.ts",
      "a dated record of what the owner supplied for July 2026, carried \"at his 14 EGP unit price "
        + "exactly as supplied, never recomputed\".",
    ],
    [
      "src/lib/payroll/copilot/llm.ts",
      "a regex matching the CEO's own words — /pay (them|him|her)/ — plus prompt examples that show "
        + "both genders on purpose (\"hold his salary\", \"don't pay her yet\"). Neutralising these "
        + "would stop the parser recognising what he actually types.",
    ],
  ]);

  /** Single lines, anywhere, whose "he" is correct. */
  const ALLOWED = [
    // Already inclusive — not the default this test is about.
    /\bhe or she\b/i,
    // The Super Admin and HR Section Head is B-10, the owner himself: one named man, not a role
    // that could be anyone.
    /the HR Section Head reads it himself/,
    // The owner's own mapping decision, which the hold exists to protect.
    /somebody else's change was about to replace his/,
    // The owner chose these recipients, and the workbook's button bar is his.
    /recipients chosen by him/,
    /serialises it as XLSM with his button bar live/,
    // The list-template importer matches the header a filled sheet actually carries. Every sheet
    // downloaded before 2026-10-05 says "Where to find him", so the alias stays beside the new one
    // — dropping it would silently fail to read a column somebody already filled in. The LABEL,
    // which is what a new sheet is written with, is neutral.
    /aliases: \["where to find them", "where to find him"/,
  ];

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk("src");
  walk("app");
  assert.ok(files.length > 2000, `the sweep must actually read the app — it found ${files.length} files`);

  for (const [path, reason] of EXEMPT_FILES) {
    assert.ok(files.includes(path), `the exemption for ${path} names a file that no longer exists (${reason})`);
  }

  // Comments are blanked to spaces rather than removed, so one entry still means one source line
  // and the offender below can name the line it was actually found on.
  const offenders: string[] = [];
  let swept = 0;
  for (const path of files) {
    if (EXEMPT_FILES.has(path)) continue;
    swept += 1;
    const source = readFileSync(path, "utf8");
    if (!MASCULINE.test(source)) continue;
    stripComments(source).split(/\r?\n/).forEach((text, index) => {
      if (!text.trim()) return;
      if (!MASCULINE.test(text)) return;
      if (ALLOWED.some((allowed) => allowed.test(text))) return;
      offenders.push(`${path}:${index + 1}  ${text.trim()}`);
    });
  }
  assert.ok(swept > 2000, `the sweep must actually read the app — it swept ${swept} files`);

  assert.deepEqual(
    offenders,
    [],
    "No screen, export, workbook, notice or prompt may assume its subject is a man — write it "
      + "neutrally (owner, 2026-10-05, after the field activity report called a woman \"he\"). "
      + `Offending lines:\n${offenders.join("\n")}`,
  );

  // Four places where the default was loudest, pinned by name so a revert is obvious: a notice that
  // leaves the building, a refusal a rep meets at the door, a workbook column, a table heading.
  const neutralNow: Array<[string, RegExp]> = [
    ["src/lib/phoenix-crm/server/notifications.ts", /confirmed they started working at/],
    ["src/lib/phoenix-crm/server/db.ts", /Ask to add them to your list first\./],
    // The column moved into the rules module on 2026-10-05, when the "Already on the list" sheet
    // became an input and had to be built from one shared list. The WORDING is what is pinned, so
    // the pin follows it rather than the file it used to be typed in.
    ["src/lib/phoenix-crm/list-template-rules.ts", /label: "Where they stand"/],
    ["src/lib/business-review/pack/model.ts", /"Area they stand in"/],
  ];
  for (const [path, expected] of neutralNow) {
    assert.match(readFileSync(path, "utf8"), expected, `${path} says it neutrally`);
  }
}
