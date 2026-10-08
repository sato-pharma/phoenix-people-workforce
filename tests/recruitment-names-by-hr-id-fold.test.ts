/**
 * Recruitment reads a person's NAME through the shared lookup, and nowhere builds its own.
 *
 * `src/lib/employees/names-by-hr-id.ts` exists because several modules had written the same
 * `employees` name read by hand and had already drifted apart. #5597 folded three of them; this
 * suite covers the six recruitment copies folded after it, and — the part that matters a year from
 * now — it refuses a SEVENTH.
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOUR TEST. The behaviour of the lookup itself is pinned in
 * `tests/employees-names-by-hr-id.test.ts`, against the in-memory Supabase fake. What this suite
 * pins is the absence of a second implementation, which is a property of the module, not of a
 * function — nothing you can call can tell you whether somebody has written the loop again
 * elsewhere.
 */
import assert from "node:assert/strict";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";
import { cachedIsDirectory, cachedReadFile, cachedReaddir } from "./support/source-corpus.ts";

const RECRUITMENT = path.join(process.cwd(), "src", "lib", "recruitment");

/** The six that were folded, and the function in each that used to carry its own copy. */
const FOLDED: Array<[string, string]> = [
  ["cv-folder-tree-db.ts", "attachFolderCreatorNames"],
  ["cv-lifecycle-share-links.ts", "mapLink"],
  ["candidate-call-claims-db.ts", "resolveManagerName"],
  ["district-returns.ts", "resolveManagerName"],
  ["interview-notifications.ts", "interviewerName"],
  ["manager-cv-engagement.ts", "resolveManagerEngagementViewerName"],
];

/**
 * A read of `employees` that asks ONLY for name columns IS this lookup, wherever it is written.
 * One file is exempt, and the reason is written out rather than assumed.
 */
const NAME_ONLY_EXEMPT: Record<string, string> = {
  "candidate-views.ts":
    "resolveViewerNames reads full_name ONLY (no nickname) and THROWS on a real error — folding it " +
    "would change both what a screen shows and how that screen fails, which is a product decision, " +
    "not a refactor",
};

const NAME_COLUMNS = new Set(["hr_id", "full_name", "nickname"]);

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of cachedReaddir(directory)) {
    const full = path.join(directory, entry);
    if (cachedIsDirectory(full)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every `.select("…")` that follows a `.from("employees")` in this source, as a column list. */
function employeeSelects(source: string): string[][] {
  const selects: string[][] = [];
  const code = stripComments(source);
  for (const match of code.matchAll(/\.from\(\s*"employees"\s*\)([\s\S]{0,400}?)\.select\(\s*(["'`])([^"'`]*)\2/g)) {
    const between = match[1] ?? "";
    // Only the select that belongs to THIS from() — a second `.from(` in between means the regex
    // jumped a query boundary and the match says nothing about either one.
    if (between.includes(".from(")) continue;
    selects.push(
      (match[3] ?? "")
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean),
    );
  }
  return selects;
}

export async function runRecruitmentNamesByHrIdFoldTests() {
  // ── 1 · Each folded file reads the shared lookup, and keeps no copy of its own ───────────────────
  for (const [file, functionName] of FOLDED) {
    const source = cachedReadFile(path.join(RECRUITMENT, file));
    const code = stripComments(source);

    assert.match(
      code,
      /import \{[^}]*\bnamesByHrId\b[^}]*\} from "@\/lib\/employees\/names-by-hr-id"/,
      `${file} must import the shared namesByHrId (it is where ${functionName} resolves a name now)`,
    );
    assert.match(code, /namesByHrId\(/, `${file} must actually CALL it, not merely import it`);

    // 🔴 The empty-key read every hand-written copy forced on its callers: `?? ""` looks up the
    // EMPTY key when there is no id, instead of answering "no name". The accessor canonicalises on
    // the way in, so no call site needs it — and none may reintroduce it.
    assert.ok(
      !/\.get\(\s*canonicalHrIdKey\([^)]*\)\s*\?\?\s*""\s*\)/.test(code),
      `${file} must not read a name map as get(canonicalHrIdKey(id) ?? "") — that looks up the empty key`,
    );
  }

  // ── 2 · No second copy anywhere in the module ───────────────────────────────────────────────────
  //
  // A read of `employees` asking only for hr_id/full_name/nickname is this lookup by definition. A
  // read that also wants a job title, an area or an email is a different query and is left alone.
  {
    const offenders: string[] = [];
    for (const file of walk(RECRUITMENT)) {
      const relative = path.relative(RECRUITMENT, file).split(path.sep).join("/");
      const exemption = NAME_ONLY_EXEMPT[relative];
      for (const columns of employeeSelects(cachedReadFile(file))) {
        if (columns.length === 0) continue;
        const nameOnly = columns.every((column) => NAME_COLUMNS.has(column));
        if (!nameOnly) continue;
        if (exemption) continue;
        offenders.push(`${relative} selects ${columns.join(",")}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "🔴 a recruitment read of employees asking ONLY for name columns is a second copy of " +
        `namesByHrId — fold it onto @/lib/employees/names-by-hr-id: ${offenders.join(" · ")}`,
    );
  }

  // The exemption is not a blanket: it only holds while that file really is the shape described.
  for (const [file, reason] of Object.entries(NAME_ONLY_EXEMPT)) {
    const code = stripComments(cachedReadFile(path.join(RECRUITMENT, file)));
    assert.ok(
      !/nickname/.test(code.split('from("employees")')[1]?.slice(0, 200) ?? ""),
      `${file} is exempt only because it reads NO nickname (${reason}) — it now does, so either ` +
        "fold it or restate the exemption",
    );
  }

  // ── 3 · The bare `.eq("hr_id", …)` ratchet — it may only FALL ───────────────────────────────────
  //
  // 🔴 A bare `.eq("hr_id", id)` is the mixed-case miss itself: production stores hr_id mixed-case,
  // PostgREST matches case-sensitively, and a miss returns no row AND NO ERROR. `interviewerName`
  // was exactly this and shipped a raw id into an interview notification until 2026-10-09.
  //
  // 🔴 COUNTED ON THE `employees` TABLE ONLY, and that distinction is the whole measurement: the
  // first version of this ratchet counted every `.eq("hr_id", …)` in the module and read 8 against a
  // baseline of 3, because five of them sit on other tables — `app_auth_users`, the ICS token table
  // and the calendar shares table — where the id was read back from the row it is being compared to
  // and there is no spelling to get wrong.
  //
  // Counted 2026-10-09 on `employees`, after the interviewerName fix: 3, in two files that are NOT
  // name lookups (they read work_email, manager_hr_id, job_title, mobile_number) and so cannot fold
  // onto this helper — each needs `.in("hr_id", hrIdLookupKeys(id))` instead, a separate change with
  // its own blast radius, since one of them picks an email recipient.
  {
    const BASELINE = 3;
    const found: string[] = [];
    for (const file of walk(RECRUITMENT)) {
      const relative = path.relative(RECRUITMENT, file).split(path.sep).join("/");
      const code = stripComments(cachedReadFile(file));
      for (const match of code.matchAll(/\.from\(\s*"employees"\s*\)([\s\S]{0,400}?)\.eq\(\s*"hr_id"\s*,/g)) {
        if ((match[1] ?? "").includes(".from(")) continue;
        found.push(relative);
      }
    }
    assert.ok(
      found.length <= BASELINE,
      `🔴 a NEW bare .eq("hr_id", …) was added — it matches case-sensitively against a mixed-case ` +
        `column and misses with no error. Use .in("hr_id", hrIdLookupKeys(id)), or namesByHrId when ` +
        `all you want is the name. Baseline ${BASELINE}, now ${found.length}: ${found.join(" · ")}`,
    );
  }

  console.log("recruitment — every name read goes through the shared namesByHrId: OK");
}
