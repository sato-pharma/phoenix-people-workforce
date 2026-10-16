import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";
import { cachedIsDirectory, cachedReaddir, cachedReadFile } from "./support/source-corpus.ts";

import { CRM_VISITS_MIRROR_ALLOW_LIST } from "./crm-single-source.test.ts";

import {
  sortVendorLeftovers,
  vendorLeftoverNote,
  VENDOR_LEFTOVER_TITLE,
  type VendorLeftoverRep,
} from "../src/lib/phoenix-crm/vendor-leftovers.ts";

/**
 * Phoenix CRM — who is still recording in iReports360 after his team moved.
 *
 * From a team's start its reps' iReports360 visits are IGNORED everywhere (owner, 2026-10-02), so a
 * rep who carries on logging there is doing real work that reaches no figure at all. The flag exists
 * to make that visible to the people who can act on it.
 *
 * Two things here are easy to get wrong in opposite directions, and both are pinned:
 *   · the question CANNOT be asked of `crm_visits_unified` — the view anti-joins exactly these rows
 *     out, so it would answer a confident zero for a rep logging every day;
 *   · and the answer must never reach the rep (Golden Rule #1), which the SERVER enforces rather
 *     than a screen choosing not to render it.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function rep(repName: string, visits: number, lastDay: string): VendorLeftoverRep {
  return { repName, visits, lastDay };
}

export function runPhoenixCrmVendorLeftoverTests(): void {
  // ── 1. The sentence ──────────────────────────────────────────────────────────────────────────
  {
    assert.equal(vendorLeftoverNote([]), null, "nobody on the old app says nothing at all");
    assert.equal(vendorLeftoverNote([rep("Ahmed Samir", 0, "2026-10-05")]), null, "a rep with no visits there is not on it");

    assert.equal(
      vendorLeftoverNote([rep("Ahmed Samir", 1, "2026-10-05")]),
      "Ahmed Samir is still recording in iReports360 — 1 visit since the team moved, counted nowhere.",
      "one rep, one visit: singular on both halves",
    );
    assert.equal(
      vendorLeftoverNote([rep("Ahmed Samir", 12, "2026-10-05"), rep("Mona Fathy", 3, "2026-10-04")]),
      "Ahmed Samir and Mona Fathy are still recording in iReports360 — 15 visits since the team moved, counted nowhere.",
      "two reps: both named, the visits summed",
    );
    assert.equal(
      vendorLeftoverNote([
        rep("Ahmed Samir", 12, "2026-10-05"),
        rep("Mona Fathy", 3, "2026-10-04"),
        rep("Karim Adel", 1, "2026-10-03"),
      ]),
      "Ahmed Samir, Mona Fathy and Karim Adel are still recording in iReports360 — 16 visits since the team moved, counted nowhere.",
      "three reps read as a sentence, not as a list of rows",
    );

    // NAMES, never HR ids — the owner's standing rule, and the list is short by construction.
    assert.ok(!(vendorLeftoverNote([rep("Ahmed Samir", 2, "2026-10-05")]) ?? "").includes("B-"), "a name, never an id");
  }

  // ── 2. It says where the work went, never what the rep is ────────────────────────────────────
  {
    const note = (vendorLeftoverNote([rep("Ahmed Samir", 9, "2026-10-05")]) ?? "").toLowerCase();
    const heading = VENDOR_LEFTOVER_TITLE.toLowerCase();
    assert.ok(note.length > 0 && heading.length > 0, "nothing to check — the assertions below would pass vacuously");
    // A rep still on the old app is following the habit he was trained in. The wording carries the
    // COST ("counted nowhere") and no verdict on him.
    for (const accusing of ["refus", "ignor", "fail", "violat", "should", "must", "warning", "breach", "wrong", "not allowed"]) {
      assert.ok(!note.includes(accusing), `the sentence reads as a complaint about the rep ("${accusing}")`);
      assert.ok(!heading.includes(accusing), `the heading reads as a verdict ("${accusing}")`);
    }
    assert.ok(note.includes("counted nowhere"), "it states the cost, which is the whole reason to show it");
  }

  // ── 3. The order a manager works them ────────────────────────────────────────────────────────
  {
    const sorted = sortVendorLeftovers([
      rep("Zeinab", 2, "2026-10-01"),
      rep("Ahmed", 40, "2026-10-01"),
      rep("Mona", 1, "2026-10-06"),
      rep("Bassem", 40, "2026-10-01"),
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.repName),
      ["Mona", "Ahmed", "Bassem", "Zeinab"],
      "still arriving first, then the heaviest, then by name — a one-visit rep yesterday outranks forty last week",
    );
    // It copies: a caller's array is never reordered under it.
    const input = [rep("Zeinab", 2, "2026-10-01"), rep("Mona", 1, "2026-10-06")];
    sortVendorLeftovers(input);
    assert.equal(input[0].repName, "Zeinab", "the caller's own array is left alone");
  }

  // ── 4. The mirror, because the module's read door answers zero by design ─────────────────────
  {
    const loader = source("src/lib/crm/phoenix-vendor-leftovers.ts");
    assert.match(loader, /\.from\("ireports360_visits"\)/, "it reads the raw mirror, which is the only place these rows survive");
    // 🔴 Paged (2026-10-16): 765 rows that day and growing daily — one read past 1,000 undercounts silently.
    assert.match(loader, /fetchAllRowsKeyset<[^>]*>\(\s*\(\) =>\s*supabase\s*\.from\("ireports360_visits"\)/, "the mirror read is a keyset walk, never one capped read");
    assert.ok(loader.includes('getOrLoadShared<LeftoverTally>(VENDOR_LEFTOVERS_CACHE, "company", loadLeftoverTallies'), "one company-wide tally, shared for a minute");
    // 🔴 `queryVisits` selects from `crm_visits_unified`, and from a team's start that view ANTI-JOINS
    // its reps' iReports360 rows out — the owner's rule of 2026-10-02. So the door is built to answer
    // zero to exactly this question, and routing the read through it would look tidy and read wrong.
    assert.doesNotMatch(loader, /queryVisits|crm_visits_unified/, "the door cannot see these rows; this is not a cleanup to make");
    assert.match(source("src/lib/crm/reads.ts"), /from\(CRM_VISITS_UNIFIED_VIEW\)/, "which is because the door reads the unified view");

    // The single-source guard's own escape: a NAMED entry with a reason, so the exception is visible
    // debt rather than a file that quietly reaches past the door.
    assert.equal(
      CRM_VISITS_MIRROR_ALLOW_LIST["src/lib/crm/phoenix-vendor-leftovers.ts"],
      "who is still recording in iReports360 after his team moved — the unified view anti-joins exactly those rows out, so the door would answer a confident zero",
      "the allow-list entry carries WHY, which is what stops it being removed as dead weight",
    );

    // Each rep's OWN window, so a team started later is never judged by visits that still belonged
    // in iReports360 when they were made, and a rep who left a started seat stops counting.
    assert.match(loader, /candidate\.countedFrom <= day/, "a day before his team moved is not a leftover");
    assert.match(loader, /candidate\.countedUntil === null \|\| day < candidate\.countedUntil/, "nor a day after he left the seat");

    // One reader of the mirror for this question. A second would drift from the window rules above.
    const readers = walkSource("src")
      .concat(walkSource("app"))
      .filter((file) => {
        const text = stripComments(cachedReadFile(file));
        return text.includes("ireports360_visits") && /stillOnVendor|VendorLeftover|vendorLeftover/.test(text);
      })
      .map((file) => file.split(path.sep).join("/"));
    assert.deepEqual(readers, ["src/lib/crm/phoenix-vendor-leftovers.ts"], "exactly one place asks the mirror this question");
    // And nothing OUTSIDE src/lib/crm may: that is the module boundary, and the two servers below take
    // the answer rather than the query.
    for (const consumer of ["src/lib/phoenix-crm/server/team.ts", "src/lib/crm/phoenix-team-starts-server.ts"]) {
      assert.doesNotMatch(source(consumer), /ireports360_visits/, `${consumer} takes the loader's answer, never the mirror`);
    }
  }

  // ── 5. Golden Rule #1 — the SERVER clears it, the screen decides nothing ─────────────────────
  {
    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.match(
      team,
      /stillOnVendor: isLocationBlind\(viewer, seat\) \? \[\] : sortVendorLeftovers\(/,
      "a rep's scope holds his own territory, so the answer is emptied before it leaves the server",
    );

    // Every file that reads the flag at all, named. A new one is a decision about who may see it,
    // never a side effect of a refactor — and the rep's own screens are not on the list.
    const vocabulary = /stillOnVendor|vendorLeftoverNote|VENDOR_LEFTOVER_TITLE|VendorLeftoverRep|sortVendorLeftovers|loadVendorLeftoversBySeat/;
    const files = walkSource("src")
      .concat(walkSource("app"))
      .filter((file) => vocabulary.test(stripComments(cachedReadFile(file))))
      .map((file) => file.split(path.sep).join("/"))
      .sort();
    assert.deepEqual(
      files,
      [
        // The Super Admin's team-starts panel, folded up to the team…
        "src/components/crm/crm-phoenix-team-starts-panel.tsx",
        // …and the district manager's and SFE Manager's Team tab, on the territory's own row.
        "src/components/phoenix-crm/team-tab.tsx",
        "src/lib/crm/phoenix-team-starts-server.ts",
        "src/lib/crm/phoenix-team-starts.ts",
        "src/lib/crm/phoenix-vendor-leftovers.ts",
        "src/lib/phoenix-crm/server/team.ts",
        "src/lib/phoenix-crm/vendor-leftovers.ts",
      ],
      "a new reader of the leftover flag — check it is not a rep-facing screen (Golden Rule #1)",
    );
  }

  // ── 6. Two manager screens, ONE wording ──────────────────────────────────────────────────────
  {
    for (const screen of ["src/components/crm/crm-phoenix-team-starts-panel.tsx", "src/components/phoenix-crm/team-tab.tsx"]) {
      const text = source(screen);
      assert.match(text, /vendorLeftoverNote\(/, `${screen} prints the shared sentence`);
      assert.match(text, /VENDOR_LEFTOVER_TITLE/, `${screen} prints the shared heading`);
      assert.ok(
        !text.includes("still recording in iReports360"),
        `${screen} restates the wording instead of asking for it — two screens would then drift apart`,
      );
    }
  }

  console.log("phoenix-crm vendor leftovers: OK");
}

/** The source tree, the way every other ratchet here walks it. */
function walkSource(dir: string, out: string[] = []): string[] {
  for (const entry of cachedReaddir(dir)) {
    const full = path.join(dir, entry);
    if (cachedIsDirectory(full)) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walkSource(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}
