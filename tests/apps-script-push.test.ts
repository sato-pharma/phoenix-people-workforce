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

//
// Sections 6-9 guard the second half, found 22 Oct 2026: content goes to the project's HEAD, but a
// web app's `/exec` URL runs a saved VERSION, so the Direct Orders one served version 5 (5 Aug) to
// Phoenix's instant refresh ping for eleven weeks while HEAD carried the fix. Section 8 drives the
// real `pushTarget` through a stubbed `fetch` on exactly that state — HEAD already current, the web
// app behind — because that is the path the old code returned from before looking at the web app.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import {
  APPS_SCRIPT_DEPLOYMENTS_SCOPE,
  APPS_SCRIPT_PROJECTS_SCOPE,
  APPS_SCRIPT_SCOPE,
  APPS_SCRIPT_TARGETS,
  OAUTH_ENV,
} from "../scripts/apps-script-manifest.mjs";
import {
  deploymentUpdateBody,
  planAppsScriptUpdate,
  planWebAppDeployment,
  pushTarget,
  sameAppsScriptFiles,
} from "../scripts/push-apps-script.mjs";

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

type Call = { method: string; url: string; body: unknown };

/**
 * A stand-in for Google that holds one project: its HEAD files, its saved versions, and its
 * deployments. Records every call so a test can say what was — and was not — written.
 */
function fakeGoogle(state: {
  head: ScriptFile[];
  versions: Record<number, ScriptFile[]>;
  deployments: Array<{ deploymentId: string; deploymentConfig: Record<string, unknown>; entryPoints: unknown[] }>;
}) {
  const calls: Call[] = [];
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
  const fake = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ body, method, url });
    const content = /\/content(?:\?versionNumber=(\d+))?$/.exec(url);
    if (content && method === "GET") {
      if (!content[1]) return reply({ files: state.head });
      const files = state.versions[Number(content[1])];
      return files ? reply({ files }) : reply({ error: { message: "no such version" } }, 404);
    }
    if (content && method === "PUT") {
      state.head = (body as { files: ScriptFile[] }).files;
      return reply({ files: state.head });
    }
    if (url.endsWith("/deployments") && method === "GET") return reply({ deployments: state.deployments });
    if (url.endsWith("/versions") && method === "POST") {
      const versionNumber = Math.max(0, ...Object.keys(state.versions).map(Number)) + 1;
      state.versions[versionNumber] = state.head.map((file) => ({ ...file }));
      return reply({ versionNumber });
    }
    const dep = /\/deployments\/([^/?]+)$/.exec(url);
    if (dep && method === "PUT") {
      const found = state.deployments.find((d) => d.deploymentId === decodeURIComponent(dep[1]));
      if (!found) return reply({ error: { message: "no such deployment" } }, 404);
      found.deploymentConfig = (body as { deploymentConfig: Record<string, unknown> }).deploymentConfig;
      return reply(found);
    }
    return reply({ error: { message: `unexpected ${method} ${url}` } }, 400);
  };
  return { calls, fake, state };
}

const WEB_APP = [{ entryPointType: "WEB_APP", webApp: { url: "https://script.google.com/macros/s/X/exec" } }];
const HEAD_DEPLOYMENT = { deploymentConfig: { manifestFileName: "appsscript", scriptId: "S" }, deploymentId: "HEAD-ID", entryPoints: WEB_APP };

async function withStubbedGoogle<T>(fake: typeof fetch, body: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const hadId = process.env[TARGET.scriptIdEnv];
  globalThis.fetch = fake;
  console.log = () => {};
  process.env[TARGET.scriptIdEnv] = "S";
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    if (hadId === undefined) delete process.env[TARGET.scriptIdEnv];
    else process.env[TARGET.scriptIdEnv] = hadId;
  }
}

const FULL_GRANT = { scopes: [APPS_SCRIPT_PROJECTS_SCOPE, APPS_SCRIPT_DEPLOYMENTS_SCOPE], token: "t" };

export async function runAppsScriptPushTests() {
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

  // ── 6. The consent asks for the deployment scope, and nothing broader ──────
  assert.deepEqual(
    APPS_SCRIPT_SCOPE.split(" ").sort(),
    [APPS_SCRIPT_DEPLOYMENTS_SCOPE, APPS_SCRIPT_PROJECTS_SCOPE].sort(),
    "the grant needs script.deployments to move a web app, and must not ask for more",
  );

  // ── 7. Exactly ONE versioned web app is moved; none is a skip, two a refusal
  const pinned = { deploymentConfig: { versionNumber: 5, scriptId: "S", manifestFileName: "appsscript", description: "kept" }, deploymentId: "EXEC-ID", entryPoints: WEB_APP };
  assert.deepEqual(planWebAppDeployment([HEAD_DEPLOYMENT], TARGET), { action: "none" }, "the /dev HEAD deployment is not an /exec URL");
  assert.deepEqual(planWebAppDeployment([], TARGET), { action: "none" });
  assert.deepEqual(planWebAppDeployment(null, TARGET), { action: "none" });
  const apiOnly = { ...pinned, deploymentId: "API-ID", entryPoints: [{ entryPointType: "EXECUTION_API" }] };
  assert.deepEqual(planWebAppDeployment([apiOnly], TARGET), { action: "none" }, "an API-executable deployment is not the web app");

  const chosen = planWebAppDeployment([HEAD_DEPLOYMENT, pinned], TARGET);
  if (chosen.action !== "use") assert.fail(`one versioned web app must be used (got ${chosen.action})`);
  assert.equal(chosen.deployment.deploymentId, "EXEC-ID");
  assert.equal(chosen.versionNumber, 5);

  const two = planWebAppDeployment([pinned, { ...pinned, deploymentId: "OTHER-ID" }], TARGET);
  if (two.action !== "refuse") assert.fail("two web apps must refuse — moving the wrong one leaves Phoenix's stale");
  assert.match(two.reason, /EXEC-ID on version 5/);
  assert.match(two.reason, /OTHER-ID/);

  // The update body changes the version and nothing else — same script, manifest, description.
  assert.deepEqual(deploymentUpdateBody(pinned, "S", 9), {
    deploymentConfig: { description: "kept", manifestFileName: "appsscript", scriptId: "S", versionNumber: 9 },
  });

  assert.equal(sameAppsScriptFiles([MANIFEST, { name: "Code", type: "SERVER_JS", source: "a" }], [{ name: "Code", type: "SERVER_JS", source: "a" }, MANIFEST]), true, "order must not matter");
  assert.equal(sameAppsScriptFiles([MANIFEST, { name: "Code", type: "SERVER_JS", source: "a" }], [MANIFEST, { name: "Code", type: "SERVER_JS", source: "b" }]), false);
  assert.equal(sameAppsScriptFiles([MANIFEST], [MANIFEST, { name: "Code", type: "SERVER_JS", source: "a" }]), false, "a missing file is a difference");

  // ── 8. HEAD current, web app behind → a new version, the SAME deployment moved
  // This is the 22 Oct 2026 state of the Direct Orders sheet, and the path the old pusher left
  // through `return` before it ever looked at the web app.
  const local = readFileSync(TARGET.localPath, "utf8");
  const current = [MANIFEST, { name: "Code", type: "SERVER_JS", source: local }];
  const stale = [MANIFEST, { name: "Code", type: "SERVER_JS", source: "the August code" }];
  const behind = fakeGoogle({
    deployments: [structuredClone(HEAD_DEPLOYMENT), structuredClone(pinned)],
    head: structuredClone(current),
    versions: { 4: structuredClone(stale), 5: structuredClone(stale) },
  });
  await withStubbedGoogle(behind.fake as typeof fetch, () => pushTarget(FULL_GRANT, TARGET));

  assert.equal(behind.calls.some((c) => c.method === "PUT" && c.url.endsWith("/content")), false, "a current HEAD must not be rewritten");
  const created = behind.calls.filter((c) => c.method === "POST" && c.url.endsWith("/versions"));
  assert.equal(created.length, 1, "exactly one version is created");
  const moved = behind.calls.filter((c) => c.method === "PUT" && /\/deployments\//.test(c.url));
  assert.equal(moved.length, 1, "exactly one deployment is updated");
  assert.match(moved[0].url, /\/deployments\/EXEC-ID$/, "the EXISTING /exec deployment is moved, so its URL never changes");
  assert.equal(behind.calls.some((c) => c.method === "POST" && /\/deployments$/.test(c.url)), false, "no deployment is ever created");
  const exec = behind.state.deployments.find((d) => d.deploymentId === "EXEC-ID");
  assert.equal(exec?.deploymentConfig.versionNumber, 6, "the web app now serves the new version");
  assert.equal(exec?.deploymentConfig.description, "kept");
  assert.equal(sameAppsScriptFiles(behind.state.versions[6], current), true, "the new version holds HEAD");
  assert.equal(behind.state.deployments.find((d) => d.deploymentId === "HEAD-ID")?.deploymentConfig.versionNumber, undefined, "the /dev deployment is left alone");

  // A web app already on HEAD's code costs nothing: no version, no deployment write.
  const onHead = fakeGoogle({ deployments: [structuredClone(pinned)], head: structuredClone(current), versions: { 5: structuredClone(current) } });
  await withStubbedGoogle(onHead.fake as typeof fetch, () => pushTarget(FULL_GRANT, TARGET));
  assert.deepEqual(onHead.calls.map((c) => c.method), ["GET", "GET", "GET"], "a current web app must not be redeployed");

  // ── 9. A grant without the deployment scope still pushes HEAD, then fails LOUDLY
  const narrow = fakeGoogle({ deployments: [structuredClone(pinned)], head: structuredClone(stale), versions: { 5: structuredClone(stale) } });
  let refusal = "";
  await withStubbedGoogle(narrow.fake as typeof fetch, () =>
    pushTarget({ scopes: [APPS_SCRIPT_PROJECTS_SCOPE], token: "t" }, TARGET).catch((error: Error) => {
      refusal = error.message;
    }),
  );
  assert.equal(narrow.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/content")).length, 1, "HEAD is still written — the sheet's own trigger runs it");
  assert.match(refusal, /script\.deployments/, "the run must fail naming the missing scope, never report success");
  assert.match(refusal, /apps-script-authorize\.mjs/);
  assert.equal(narrow.state.deployments[0].deploymentConfig.versionNumber, 5);
}
