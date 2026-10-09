import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonPath,
  directoriesLinkedThrough,
  isLoadBearing,
  linksThroughFolder,
} from "../scripts/repo-doctor-load-bearing.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// A ZERO-FILE FOLDER CAN BE HOLDING THE WHOLE MACHINE UP.
//
// On 2026-10-09 `repo-doctor --fix` deleted `F:\Phoenix Workforce\_wt-reconcile-deductions` three
// times in one day, in three separate sessions, and each time the next command run anywhere on the
// machine died with ERR_MODULE_NOT_FOUND. The folder satisfied every husk test the report had:
// unregistered, no `.git`, and ZERO files in a full recursive walk. It held exactly one entry — a
// `node_modules` junction — and all 68 of the primary checkout's top-level package links had been
// rewritten (by a stray `pnpm run` inside that worktree) to absolute paths routed through it.
// Links are not files, so the file count was honest and the conclusion was catastrophic.
//
// WHAT IS PINNED HERE. Not the string "_wt-reconcile-deductions" — an exception list naming one
// folder would protect that folder and nothing else, while making the report look careful. What is
// pinned is the PROPERTY: a folder is load-bearing when the primary's own package links resolve
// through it, read from the link targets on a real disk with real junctions, plus the two places in
// the report that must consult it (the husk split, before the zero-file test, and --fix's re-prove
// immediately before the delete).
// ─────────────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const doctorSource = fs.readFileSync(path.join(here, "..", "scripts", "repo-doctor.mjs"), "utf8");
const newSessionSource = fs.readFileSync(path.join(here, "..", "scripts", "new-session.mjs"), "utf8");

/**
 * A throwaway primary checkout with a `node_modules`, plus the sibling folders a test needs.
 *
 * Junctions, not symlinks: `fs.symlinkSync(target, link, "junction")` needs no privilege on
 * Windows (a plain directory symlink does, and would make this test pass only for an administrator)
 * and the type argument is ignored on every other platform, where a directory symlink is created
 * instead. Both answer `readlinkSync`, which is the only thing the module under test reads.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-doctor-load-bearing-"));
  const primary = path.join(root, "phoenix-workforce");
  fs.mkdirSync(path.join(primary, "node_modules"), { recursive: true });
  return { root, primary };
}

/** `<store>/node_modules/.pnpm/<pkg>/node_modules/<pkg>` — the real shape pnpm produces. */
function storePathFor(storeFolder: string, pkg: string) {
  const dir = path.join(storeFolder, "node_modules", ".pnpm", `${pkg}@1.0.0`, "node_modules", pkg);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function link(from: string, to: string) {
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.symlinkSync(to, from, "junction");
}

export function runRepoDoctorLoadBearingTests() {
  // ── 1 · The incident's exact shape: a zero-file sibling the primary resolves through ──
  {
    const { root, primary } = fixture();
    const sibling = path.join(root, "_wt-reconcile-deductions");
    const target = storePathFor(sibling, "react");
    link(path.join(primary, "node_modules", "react"), target);

    const unrelated = path.join(root, "_wt-something-else");
    fs.mkdirSync(path.join(unrelated, "node_modules"), { recursive: true });

    const linked = directoriesLinkedThrough(primary);
    assert.equal(
      isLoadBearing(sibling, linked),
      true,
      "a folder the primary's own package links resolve THROUGH must read as load-bearing — this " +
        "is the folder --fix deleted three times on 2026-10-09, and it holds zero files",
    );
    assert.equal(
      isLoadBearing(unrelated, linked),
      false,
      "an empty sibling nothing resolves through must NOT be called load-bearing — a check that " +
        "protects every folder protects none of them and the husk section stops working",
    );

    // The ancestors of the target are what make this work: the link points deep inside
    // `<folder>/node_modules/.pnpm/…`, and deleting ANY directory on that path dangles it.
    assert.equal(
      isLoadBearing(path.join(sibling, "node_modules", ".pnpm"), linked),
      true,
      "every directory on a link target's path is load-bearing, not only the folder's own root",
    );

    const { count, example } = linksThroughFolder(primary, sibling);
    assert.equal(count, 1, "the report line must say how many of the primary's links travel through it");
    assert.equal(example, "react", "and name one, so the reader can check the claim themselves");
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 2 · A HEALTHY primary marks no sibling at all ────────────────────────────
  // The gate has to be inert in the normal case. If a self-contained install reads as
  // load-bearing, every husk and every idle worktree becomes untouchable and the sections that
  // reclaim 30,000 empty directories stop working — the failure nobody would notice for weeks.
  {
    const { root, primary } = fixture();
    link(path.join(primary, "node_modules", "react"), storePathFor(primary, "react"));
    const husk = path.join(root, "_wt-old");
    fs.mkdirSync(path.join(husk, "node_modules", ".next"), { recursive: true });

    const linked = directoriesLinkedThrough(primary);
    assert.equal(
      isLoadBearing(husk, linked),
      false,
      "a primary whose links resolve inside its own store must leave every sibling alone",
    );
    assert.equal(
      linksThroughFolder(primary, husk).count,
      0,
      "and nothing may be reported as travelling through it",
    );
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 3 · Scoped packages sit one level deeper, and they are the ones that broke ──
  // The import that actually failed on 2026-10-09 was `@supabase/supabase-js`. A reader that only
  // looks at top-level entries sees a real `@supabase` DIRECTORY, not a link, and walks past it —
  // which would have missed the incident while passing every other case in this file.
  {
    const { root, primary } = fixture();
    const sibling = path.join(root, "_wt-scoped");
    const target = storePathFor(sibling, "supabase-js");
    link(path.join(primary, "node_modules", "@supabase", "supabase-js"), target);

    const linked = directoriesLinkedThrough(primary);
    assert.equal(
      isLoadBearing(sibling, linked),
      true,
      "a @scope/ directory must be opened and its links read — @supabase/supabase-js is the import " +
        "that failed in the real incident",
    );
    assert.equal(
      linksThroughFolder(primary, sibling).example,
      "@supabase/supabase-js",
      "and the example must name the scoped package the way an import does",
    );
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 4 · Several links through one folder are counted, not just detected ──────
  {
    const { root, primary } = fixture();
    const sibling = path.join(root, "_wt-many");
    for (const pkg of ["react", "next", "zod"]) {
      link(path.join(primary, "node_modules", pkg), storePathFor(sibling, pkg));
    }
    assert.equal(
      linksThroughFolder(primary, sibling).count,
      3,
      "the count is what tells the owner how much breaks — 68 is the number that mattered",
    );
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 5 · No node_modules, and an unreadable one, answer EMPTY rather than throw ──
  // This runs on every invocation of the report, including on a half-installed tree and in a cloud
  // clone with no install at all. A throw here would take down a report whose other sections are
  // the reason it is being run.
  {
    const { root, primary } = fixture();
    fs.rmSync(path.join(primary, "node_modules"), { recursive: true, force: true });
    const linked = directoriesLinkedThrough(primary);
    assert.equal(linked.size, 0, "a primary with no node_modules reads as nothing load-bearing");
    assert.equal(
      isLoadBearing(path.join(root, "_wt-anything"), linked),
      false,
      "and the fallback is the report's previous behaviour, never a worse one",
    );
    assert.equal(
      linksThroughFolder(primary, root).count,
      0,
      "the report line must survive the same condition",
    );
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 6 · A dangling link still counts ────────────────────────────────────────
  // The state the machine was actually in between a deletion and the repair: the junction exists,
  // its target is gone. `existsSync` on the target would read false and call the folder safe to
  // delete — which is how a folder gets deleted twice. `lstat`/`readlink` answer from the link
  // itself and do not care whether the target is there.
  {
    const { root, primary } = fixture();
    const sibling = path.join(root, "_wt-dangling");
    const target = storePathFor(sibling, "react");
    link(path.join(primary, "node_modules", "react"), target);
    fs.rmSync(path.join(sibling, "node_modules"), { recursive: true, force: true });

    assert.equal(
      isLoadBearing(sibling, directoriesLinkedThrough(primary)),
      true,
      "a link whose target is already missing still proves the primary depends on this path — " +
        "reading the target's existence instead would call a half-broken machine healthy",
    );
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── 7 · Paths are compared canonically, because git and node disagree ───────
  // git prints `F:/Phoenix Workforce/...`, node prints `F:\Phoenix Workforce\...`, and Windows is
  // case-insensitive. The candidate folder comes from a node readdir and the link target from a
  // readlink; a raw string compare between them misses on either difference and silently answers
  // "not load-bearing" — the exact failure this whole file exists to prevent.
  {
    assert.equal(
      canonPath("F:\\Phoenix Workforce\\_WT-Reconcile-Deductions\\"),
      canonPath("F:/phoenix workforce/_wt-reconcile-deductions"),
      "slash direction, trailing slash and case must all collapse before the comparison",
    );
  }

  // ── 8 · The report consults it in BOTH destructive paths ────────────────────
  // Source checks, because `repo-doctor.mjs` runs its whole report at import time and cannot be
  // driven from a test. These pin the two properties a refactor can quietly lose:
  //
  //   a) the load-bearing branch comes BEFORE the zero-file husk test. A load-bearing folder
  //      passes every husk test there is, so ordering is the only thing keeping it out of the
  //      bucket --fix consumes.
  //   b) --fix re-proves it from a FRESH read immediately before deleting. A parallel session's
  //      `pnpm` re-points the primary's links mid-run, which is how this happened three times in
  //      one day rather than once.
  {
    const loadBearingBranch = doctorSource.indexOf("else if (isLoadBearing(dir, linkedThrough)) loadBearing.push(row);");
    const huskBranch = doctorSource.indexOf("else if (files === 0 && !unreadable) husks.push(row);");
    assert.ok(
      loadBearingBranch > 0 && huskBranch > 0,
      "both classification branches must exist in repo-doctor.mjs — if either was renamed, this " +
        "test can no longer tell which order they run in",
    );
    assert.ok(
      loadBearingBranch < huskBranch,
      "the load-bearing test must run BEFORE the zero-file husk test, or a load-bearing folder " +
        "lands in the bucket --fix deletes",
    );
    assert.ok(
      /if \(fix\) \{[\s\S]*?isLoadBearing\(r\.dir, directoriesLinkedThrough\(primaryRoot\)\)[\s\S]*?fs\.rmSync\(r\.dir/.test(
        doctorSource,
      ),
      "--fix must re-prove load-bearing from a fresh link read before each removal — the " +
        "inventory can be seconds old and a parallel pnpm re-points the primary mid-run",
    );
    assert.ok(
      /FIFTH GATE[\s\S]*?isLoadBearing\(dir, linkedThrough\)/.test(doctorSource),
      "--strip-idle must refuse a worktree whose node_modules the primary resolves through — " +
        "the folder surviving is no comfort when the directory inside it was the chain",
    );
    assert.ok(
      doctorSource.includes("LOAD-BEARING folders (zero files, but the PRIMARY's packages resolve THROUGH them — NEVER delete)"),
      "the section must be printed under its own heading, including when it is zero: silence here " +
        "is indistinguishable from the version of this report that deleted the folder",
    );
  }

  // ── 9 · `new-session.mjs --remove` asks the same question, twice ─────────────
  // It is the OTHER way to break this, and the more likely one once the report has stopped
  // offering: `dropModulesJunction` unlinks the very junction the primary's links travel over
  // (retiring the folder is not what breaks it — removing that link is), and the retirement then
  // prints `rmdir /s /q <dir>` for the husk it leaves, which is a deletion command for a
  // load-bearing folder.
  {
    assert.ok(
      /function dropModulesJunction\(dir\) \{[\s\S]*?isLoadBearing\(dir, directoriesLinkedThrough\(primaryRoot\)\)[\s\S]*?execFileSync\("cmd", \["\/c", "rmdir", nm\]/.test(
        newSessionSource,
      ),
      "dropModulesJunction must refuse to unlink a junction the PRIMARY's packages resolve over, " +
        "BEFORE it runs rmdir — the link is the chain, and the folder surviving does not help",
    );
    assert.ok(
      /isLoadBearing\(dir, directoriesLinkedThrough\(primaryRoot\)\)[\s\S]{0,400}DO NOT clear it[\s\S]{0,400}rmdir \/s \/q/.test(
        newSessionSource,
      ),
      "the husk advice must ask the load-bearing question before printing `rmdir /s /q` — that " +
        "line is the last way left to break the machine once repo-doctor stopped offering to",
    );
  }
}
