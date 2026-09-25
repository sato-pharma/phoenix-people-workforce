import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listText } from "../src/components/phoenix-crm/labels.ts";

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
 *      Taking the comments off a line is `readableText` below, which is where that promise was
 *      broken once — read its note before changing what the sweep ignores.
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

  const offenders: string[] = [];
  for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    let inBlockComment = false;

    /**
     * The part of one line a rep could read, with comments taken off it — `""` when the whole line
     * is comment. Stateful: `inBlockComment` carries across lines.
     *
     * A JSX comment opener has to open a block exactly as a bare one does, and until 2026-09-25 it
     * did not: `{/*` was skipped as a single line without ever setting the flag, so the BODY of a
     * multi-line JSX comment was read as code. Its continuation lines are plain indented prose and
     * start with neither `*` nor a slash, so nothing else caught them — which is how an explanatory
     * comment in `dictate.tsx` that used the word "doctor" failed the required `test` job over a
     * rule about screen strings. It was reworded then (00c8ddea6); the scanner is fixed here.
     *
     * Two deliberate limits, because this guards an owner rule and must not go blind:
     *
     *   - An opener is recognized only at the START of a line. A mid-line one is far more often
     *     inside a string than a real comment, and honouring it there would hand any screen string
     *     a way out.
     *   - Whatever follows a closing token is kept and scanned, never dropped with the line. Real
     *     code can share that line, and a label must not be able to hide behind one. This closes a
     *     hole rather than opening one: the old sweep returned on sight of `{/*`, so a screen string
     *     written after a one-line JSX comment on the same line was never read at all. Measured on
     *     2026-09-25 against four shapes — `<span>Accounts seen</span>` behind a one-liner went
     *     unseen before, is caught now, and both comment bodies that used to trip are ignored.
     */
    const readableText = (line: string): string => {
      let rest = line.trim();
      for (;;) {
        if (inBlockComment) {
          const closer = rest.indexOf("*/");
          if (closer === -1) return "";
          inBlockComment = false;
          rest = rest.slice(closer + 2).replace(/^\}/, "").trim();
          continue;
        }
        if (rest.startsWith("{/*")) rest = rest.slice(1);
        if (rest.startsWith("/*")) {
          inBlockComment = true;
          rest = rest.slice(2);
          continue;
        }
        if (rest.startsWith("*") || rest.startsWith("//")) return "";
        return rest;
      }
    };

    lines.forEach((line, index) => {
      const text = readableText(line);
      if (!text) return;
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
    "src/components/phoenix-crm/plan-tab.tsx",
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
