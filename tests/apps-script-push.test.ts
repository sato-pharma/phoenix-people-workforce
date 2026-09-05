// The Apps Script push is the one piece of automation that WRITES into the owner's Google account,
// and the API it uses has a sharp edge: `projects.updateContent` replaces EVERY file in the
// project. There is no per-file write. So a push that gets the file list wrong does not fail — it
// succeeds, and takes the sheet's script with it.
//
// That is why the decision is a pure function. Every refusal below is proved here rather than
// discovered against a live sheet, where the evidence would be a blank Apps Script project.
//
// The first test is the other kind of guard: the manifest is checked against the filesystem, so a
// FOURTH live sheet cannot be added and quietly left on the old paste-it-by-hand footing. Nothing
// would look wrong if it were — its sheet would simply keep running last month's script, which is
// exactly the failure this whole pipeline exists to end.

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";

import { APPS_SCRIPT_TARGETS, OAUTH_ENV } from "../scripts/apps-script-manifest.mjs";
import { planAppsScriptUpdate } from "../scripts/push-apps-script.mjs";

const DOCS_DIR = "docs";

type ScriptFile = { name: string; type: string; source: string };

const TARGET = {
  key: "cv-lifecycle",
  localPath: "docs/cv-lifecycle-live-sheet.gs",
  remoteFile: "Code",
  scriptIdEnv: "CV_LIFECYCLE_APPS_SCRIPT_ID",
  sheet: "CV Lifecycle",
};

/** appsscript.json — the project's timezone, runtime and OAuth scopes. Losing it breaks the run. */
const MANIFEST: ScriptFile = { name: "appsscript", type: "JSON", source: '{"timeZone":"Africa/Cairo"}' };

/** Every live-sheet script in the repo, by repo-relative path. */
function liveSheetScriptsOnDisk(): string[] {
  return readdirSync(DOCS_DIR)
    .filter((entry) => entry.endsWith("-live-sheet.gs"))
    .map((entry) => `${DOCS_DIR}/${entry}`)
    .sort();
}

function byName(files: ScriptFile[], name: string): ScriptFile {
  const found = files.find((file) => file.name === name);
  if (!found) assert.fail(`the plan dropped "${name}" — updateContent would delete it from the project`);
  return found;
}

export function runAppsScriptPushTests() {
  // ── 1. The manifest covers every live sheet that exists on disk ─────────────
  const onDisk = liveSheetScriptsOnDisk();
  const declared = APPS_SCRIPT_TARGETS.map((entry) => entry.localPath);

  assert.ok(onDisk.length > 0, "found no docs/*-live-sheet.gs at all — the scan is broken, not the repo");

  const unmanaged = onDisk.filter((file) => !declared.includes(file));
  assert.deepEqual(
    unmanaged,
    [],
    `these live sheets have no entry in scripts/apps-script-manifest.mjs, so merging a fix to them ` +
      `would change nothing on the sheet itself: ${unmanaged.join(", ")}`,
  );

  for (const entry of APPS_SCRIPT_TARGETS) {
    assert.ok(
      existsSync(entry.localPath),
      `manifest entry "${entry.key}" points at ${entry.localPath}, which does not exist`,
    );
  }

  // Keys and env-var names must be unique, or one target silently shadows another.
  assert.equal(new Set(APPS_SCRIPT_TARGETS.map((e) => e.key)).size, APPS_SCRIPT_TARGETS.length);
  assert.equal(new Set(declared).size, APPS_SCRIPT_TARGETS.length);
  assert.equal(new Set(APPS_SCRIPT_TARGETS.map((e) => e.scriptIdEnv)).size, APPS_SCRIPT_TARGETS.length);
  assert.equal(new Set(Object.values(OAUTH_ENV)).size, 3, "the three OAuth variables must be distinct");

  // ── 2. Refuse an empty project rather than write over it ───────────────────
  for (const empty of [[], null, undefined]) {
    const plan = planAppsScriptUpdate(empty, TARGET, "x");
    if (plan.action !== "refuse") assert.fail(`an empty file list must never be written (got ${plan.action})`);
    assert.match(plan.reason, /no files at all/);
  }

  // ── 3. Refuse when the managed file is not there under that exact name ─────
  const wrongName = planAppsScriptUpdate(
    [MANIFEST, { name: "Main", type: "SERVER_JS", source: "old" }],
    TARGET,
    "new",
  );
  if (wrongName.action !== "refuse") assert.fail("a missing target file must refuse, not add a second file");
  assert.match(wrongName.reason, /no SERVER_JS file named "Code"/);
  // The message must name what IS there — otherwise fixing it is a guessing game.
  assert.match(wrongName.reason, /Main \(SERVER_JS\)/);
  assert.match(wrongName.reason, /apps-script-manifest\.mjs/);

  // Right name, wrong TYPE is the same refusal: an HTML file called Code is not the script.
  const wrongType = planAppsScriptUpdate(
    [MANIFEST, { name: "Code", type: "HTML", source: "old" }],
    TARGET,
    "new",
  );
  assert.equal(wrongType.action, "refuse", "matching on name alone would overwrite an HTML file");

  // ── 4. Identical source is a no-op, so re-running the push costs nothing ───
  const same = planAppsScriptUpdate(
    [MANIFEST, { name: "Code", type: "SERVER_JS", source: "identical" }],
    TARGET,
    "identical",
  );
  if (same.action !== "current") assert.fail(`an unchanged script must not be rewritten (got ${same.action})`);
  assert.equal(same.bytes, "identical".length);

  // ── 5. A real update replaces ONLY the managed file ────────────────────────
  const sidecar: ScriptFile = { name: "Sidebar", type: "HTML", source: "<p>untouched</p>" };
  const before: ScriptFile[] = [
    MANIFEST,
    { name: "Code", type: "SERVER_JS", source: "old source" },
    sidecar,
  ];
  const update = planAppsScriptUpdate(before, TARGET, "new source");

  if (update.action !== "update") assert.fail(`a changed script must be pushed (got ${update.action})`);
  assert.equal(update.from, "old source".length);
  assert.equal(update.to, "new source".length);
  assert.equal(update.files.length, 3, "no file may be dropped — updateContent replaces the lot");

  assert.equal(byName(update.files, "Code").source, "new source");
  assert.deepEqual(byName(update.files, "appsscript"), MANIFEST);
  assert.deepEqual(byName(update.files, "Sidebar"), sidecar);

  // The caller's array must not be mutated — the failure path re-reads it to build its message.
  assert.equal(before[1].source, "old source", "planAppsScriptUpdate must not mutate its input");
}
