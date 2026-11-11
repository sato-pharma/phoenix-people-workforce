import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listText } from "../src/components/phoenix-crm/labels.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM calls a list type "AM" and "PM" — never "Doctors" or "Accounts" (the owner,
 * 2026-09-23: "in employee-portals/field-crm make it ALL AM PM not doctors and accounts").
 *
 * ## Why this exists
 *
 * The module shipped speaking two vocabularies for one thing. `PHOENIX_CRM_LIST_LABEL` and
 * `PHOENIX_CRM_LIST_SINGULAR` turned the codes into "Accounts"/"Doctors", and roughly forty screen
 * strings said "Doctor coverage · PM", "Accounts · AM", "A day holds 15 doctors at most". The rep
 * plans his day in AM and PM; a manager reading "Doctors · PM" beside "Accounts · AM" is reading the
 * same fact twice in two languages, and the tab labelled "Doctors" held the AM customers too.
 *
 * Two things are pinned here, because the wording can come back by two different routes:
 *
 *   1. **No lookup exists that can reintroduce the words.** The two label maps were deleted from
 *      `types.ts` rather than filled with "AM"/"PM", so there is nothing for a later session to
 *      "restore". `listText` is the one function that decides how a list type reads.
 *   2. **No screen string in the module says doctor or account.** A regex sweep over every source
 *      file under `src/lib/phoenix-crm` and `src/components/phoenix-crm` for those words inside a
 *      quoted string or JSX text. Comments and identifiers are deliberately out of scope: the
 *      internal names (`DoctorDirectoryRow`, the `/api/phoenix-crm/doctors` route, the `doctors`
 *      counter in `server/plans.ts`) are not what the rep reads, and renaming them would be churn.
 *      Taking the comments off is `stripComments` (`tests/support/comment-strip.ts`), the repo's
 *      one sanctioned stripper, and that promise is why: a hand-rolled line classifier here read
 *      the BODY of a multi-line JSX comment as code and failed a correct file on 2026-09-25.
 *
 * The exception list below is the whole of what may still carry the word, each with its reason. Add
 * to it only for something the rep never sees.
 */
export function runPhoenixCrmAmPmWordTests() {
  // ── 1. The list type has no other name ─────────────────────────────────────────────────────────

  assert.equal(listText("AM"), "AM", "an AM list type reads as AM");
  assert.equal(listText("PM"), "PM", "a PM list type reads as PM");

  const types = readFileSync("src/lib/phoenix-crm/types.ts", "utf8");
  for (const removed of ["PHOENIX_CRM_LIST_LABEL", "PHOENIX_CRM_LIST_SINGULAR"]) {
    assert.equal(
      types.includes(`export const ${removed}`),
      false,
      `${removed} must stay deleted — a map from the code to a word is exactly how "Doctors" and "Accounts" came back onto the screens`,
    );
  }

  // ── 2. No screen string in the module says doctor or account ───────────────────────────────────

  /**
   * What may still hold the word, and why. Everything here is an identifier, a route or a type name
   * the rep never reads — never a label, a note, a heading or an error message.
   */
  const ALLOWED = [
    /Doctor(Directory|sTab)/, // the directory's exported types and component
    /"@\/components\/phoenix-crm\/doctors-tab"/, // its import specifier
    /"\/api\/phoenix-crm\/doctors"/, // its route, unchanged
    /-doctors-search`/, // a DOM id, never rendered as text
    /\b(doctors|accounts): (number|boolean|hasScope)/, // server counters and overview flags
    /\b(let|const) (doctors|accounts) =/, // their local accumulators
    /\b(doctors|accounts) \+= 1;/, // incrementing them
    /\b(doctors|accounts),$/, // shorthand in an object literal
    /row\.(doctors|accounts)/, // reading those counters back
    /"doctors"/, // the tab KEY, whose visible label is "Directory"
    /`doctors\|\$\{test\}`/, // that tab's React key
    /doctors: "Directory"/, // that label itself
    /Your account is not linked to an HR record/, // a sign-in account, not an AM customer
    /loadDoctorDirectory|isDirectoryCompanyRole/, // directory functions
    // The coverage NORMS live in `src/lib/crm`, whose filename carries the retired word. The
    // frequency report reads the company's own A/B/C expectation from there rather than typing a
    // number of its own, so this is an import path — never anything a rep can read.
    /"@\/lib\/crm\/doctor-coverage-config"/,
    // The Super Admin's own tab is called "Test accounts" in HIS words (owner, 2026-10-22) — a sign-in
    // account, never an AM customer. The label lives in ONE constant (`PHOENIX_CRM_TEST_TAB_LABEL`) that
    // every screen reads, and its screen file is reached by this import specifier; nothing else may say it.
    /"Test accounts"/,
    /"@\/components\/phoenix-crm\/test-accounts-tab"/,
    // The question put to the model about a visit comment (comment-reading.ts). Reps write about doctors in those
    // comments and no rep or manager ever reads the question, and the wording is what the sample was checked on.
    /^\s*"(stock|price|follow_up): /,
    // The honorific `phoenix_crm_fold_name` drops from a typed name ("Doctor Ahmed Ali" folds to "ahmed ali"),
    // in name-fold.ts's own list — matched as a whole entry so the word never reaches a screen through it.
    /^\s*"doctor",$/,
  ];

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk("src/lib/phoenix-crm");
  walk("src/components/phoenix-crm");
  assert.ok(files.length > 20, `the sweep must actually read the module — it found ${files.length} files`);

  // Comments are blanked to spaces rather than removed, so one entry still means one source line
  // and the offender below can name the line it was actually found on.
  const offenders: string[] = [];
  for (const path of files) {
    stripComments(readFileSync(path, "utf8")).split(/\r?\n/).forEach((text, index) => {
      if (!text.trim()) return;
      if (!/\b(doctor|doctors|account|accounts)\b/i.test(text)) return;
      if (ALLOWED.some((allowed) => allowed.test(text))) return;
      offenders.push(`${path}:${index + 1}  ${text}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Phoenix CRM must say AM and PM, never doctor or account, on any screen (owner, 2026-09-23). Offending lines:\n${offenders.join("\n")}`,
  );

  // ── 3. The words are gone from the places they were loudest ────────────────────────────────────

  // Each of these carried a "Doctors · PM" / "Accounts · AM" pair that read the fact twice.
  const pairedBefore = [
    "src/components/phoenix-crm/reports-tab.tsx",
    // plan-tab.tsx carried a pair until it was retired (2026-09-29); the plan board that replaced it is held to the same rule.
    "src/components/phoenix-crm/plan-board.tsx",
    "src/components/phoenix-crm/plan-week-panel.tsx",
    "src/components/phoenix-crm/plan-day-panel.tsx",
    "src/components/phoenix-crm/visits-tab.tsx",
    "src/components/phoenix-crm/settings-tab.tsx",
    "src/components/phoenix-crm/doctors-tab.tsx",
  ];
  for (const path of pairedBefore) {
    const source = readFileSync(path, "utf8");
    assert.equal(/Doctors? · PM|Accounts? · AM/.test(source), false, `${path} must not name a list type twice ("Doctors · PM")`);
  }

  // The directory holds AM customers as well as PM, so its own name cannot be "Doctors".
  const app = readFileSync("src/components/phoenix-crm/phoenix-crm-app.tsx", "utf8");
  assert.match(app, /doctors: "Directory"/, "the directory tab is labelled Directory — it holds AM customers too");
}
