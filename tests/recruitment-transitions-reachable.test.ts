import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Every registered stage move must have a way to be invoked.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * The workflow registry has defined `app_to_pre_boarding` since the ATS re-platform — from
 * `offer_accepted`, to `pre_boarding`, for Super Admin and HR Advisory, labelled "Move to
 * pre-boarding". The server would have accepted it all along. But `nextStageAction` in the
 * workspace is the ONLY thing that turns a plain transition into a button, and `offer_accepted`
 * was not a key in it. So the action existed, was allowed, was audited — and could be reached by
 * nothing at all.
 *
 * That is not cosmetic. `pre_boarding` is the entire "Joining" group on the HR command centre and
 * one of three stages `pipeline-metrics` counts as an accepted offer. With no way in, Joining
 * could only ever read zero — which looks like nobody is joining, not like a missing button.
 *
 * It is the same shape as the "Application link" button removed on 2026-09-05, which called a
 * route deleted in a re-platform and had 404'd on every press since. That one was wiring pointing
 * at nothing; this one is a thing nothing pointed at. Both are dead wiring, and both survived
 * because no check asked whether the two halves still met.
 *
 * ── WHAT COUNTS AS REACHABLE ────────────────────────────────────────────────────────────────
 *
 * Naming the key anywhere the recruitment UI can drive — a component, an API route, or a lib map
 * the UI drives through some other vocabulary. That last part is load-bearing: the screening cards
 * do NOT name action keys, they send outcome names, and `screening.ts` maps `shortlisted` to
 * `app_cv_shortlist`. A sweep of components alone reports seven false positives and would have
 * been "fixed" by adding buttons that already exist. Searching for action keys while the UI speaks
 * intents is a mistake already made in this repository.
 */

const UI_ROOTS = [
  join("src", "components", "recruitment"),
  join("src", "lib", "recruitment"),
  join("app", "api", "recruitment"),
];

/**
 * The declaration file is excluded from the "reachable" side, or every key would trivially match
 * itself. `types.ts` likewise — it holds the union of every key by definition.
 */
const NOT_EVIDENCE = ["src/lib/recruitment/applications.ts", "src/lib/recruitment/types.ts"];

/**
 * Fired by the server inside `createApplication`, not chosen by anybody: adding an application IS
 * the move into the candidate pool. Asserted positively below rather than merely skipped, so this
 * exemption is a claim that can fail rather than a hole.
 */
const SERVER_FIRED = new Set(["app_add"]);

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === ".next") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        found.push(full);
      }
    }
  };
  try {
    walk(root);
  } catch {
    // A root that does not exist is a real failure, surfaced by the count assertion below rather
    // than by a crash that reads as a broken test.
  }
  return found;
}

export function runRecruitmentTransitionsReachableTests() {
  const applications = readFileSync("src/lib/recruitment/applications.ts", "utf8");

  const block = /const plainTransitionNextStatus[^=]*=\s*\{([\s\S]*?)\n\};/.exec(applications);
  assert.ok(block, "plainTransitionNextStatus must still be a single object literal - this sweep reads it");
  const keys = [...block[1].matchAll(/^\s*(app_[a-z_]+):/gm)].map((m) => m[1]);

  // A positive control. If the declaration is renamed or reshaped, an empty key list would make
  // every assertion below pass while measuring nothing.
  assert.ok(
    keys.length >= 20,
    `only ${keys.length} plain transitions parsed; the declaration this sweep reads has moved, so `
      + "it is certifying nothing",
  );

  let blob = "";
  let filesRead = 0;
  for (const root of UI_ROOTS) {
    for (const file of filesUnder(root)) {
      const rel = file.split(sep).join("/");
      if (NOT_EVIDENCE.some((skip) => rel.endsWith(skip))) continue;
      blob += readFileSync(file, "utf8");
      filesRead += 1;
    }
  }
  assert.ok(filesRead >= 20, `only ${filesRead} recruitment files read; the roots this sweep walks have moved`);

  const unreachable = keys.filter((key) => !SERVER_FIRED.has(key) && !blob.includes(key));
  assert.deepEqual(
    unreachable,
    [],
    "these stage moves are registered and permitted but nothing can invoke them. A registry action "
      + "with no control is dead wiring: the stage it leads to can only ever read zero, which looks "
      + "like nobody reaching it rather than like a missing button. Add it to `nextStageAction`, or "
      + "to whichever card owns that stage:\n"
      + unreachable.join("\n"),
  );

  // The exemption, checked rather than assumed.
  assert.match(
    applications,
    /runApplicationTransition\(application\.id, "app_add", access\)/,
    "app_add is exempt ONLY because the server fires it inside createApplication. If that call goes, "
      + "the exemption is hiding a genuinely unreachable transition",
  );

  // ── the specific gap this test was written for ────────────────────────────────────────────
  const workspace = readFileSync("src/components/recruitment/recruitment-workspace.tsx", "utf8");
  // The ACTION, not the label. Wording is somebody's to change; the wiring is not. Pinning the
  // exact string would false-fail on a rename - the same source-pinning trap that turned the hr-id
  // casing test red earlier today on a file that had just been made more correct.
  assert.match(
    workspace,
    /offer_accepted: \{ action: "app_to_pre_boarding"/,
    "offer_accepted must offer the move to pre-boarding. The registry has allowed it since the "
      + "re-platform and nothing could ask for it, so the HR command centre's Joining group was "
      + "unreachable by construction",
  );
}
