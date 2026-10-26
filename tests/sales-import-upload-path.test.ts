import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  buildSalesImportUploadPath,
  isOwnSalesImportUploadPath,
  parseSalesImportUploadPath,
  SALES_IMPORT_UPLOAD_ROOT,
  SALES_UPLOAD_PATH_REFUSAL,
  salesImportUploadOwner,
} from "../src/lib/sales/sales-import-upload-path.ts";

type Caller = Pick<AccessContext, "hrId" | "loginId"> | null | undefined;

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const source = (file: string) => readFileSync(join(repoRoot, file), "utf8");

const requestModule = "src/lib/sales/monthly-import-request.ts";
const uploadUrlRoute = "app/api/sales/monthly-import/upload-url/route.ts";

const salesImport = 'await assertPermission(access, "sales", "import")';
const weeklyImport = 'await assertPermission(access, "weekly_sales", "import")';

// Every route that takes a storage path back from the browser, with the permission it asserts and its
// first step that can reach storage: the storage helper itself where the route checks inline, or the
// call handing the request to the resolver (or detect's resolveBuffer) that checks inside.
const consumerRoutes = [
  { file: "app/api/sales/monthly-import/validate/route.ts", permission: salesImport, firstStorageStep: "await downloadSalesUploadFile(storagePath)" },
  { file: "app/api/sales/monthly-import/cancel/route.ts", permission: salesImport, firstStorageStep: "await removeSalesUploadObject(storagePath || null)" },
  { file: "app/api/sales/monthly-import/detect/route.ts", permission: salesImport, firstStorageStep: "await resolveBuffer(request, access)" },
  { file: "app/api/sales/monthly-import/preview/route.ts", permission: salesImport, firstStorageStep: "await resolveSalesUploadRequest(request, access)" },
  { file: "app/api/sales/monthly-import/commit/route.ts", permission: salesImport, firstStorageStep: "await resolveSalesUploadRequest(request, access)" },
  { file: "app/api/sales/sales-upload/analyze/route.ts", permission: salesImport, firstStorageStep: "await resolveUploadedSpreadsheet(request, access)" },
  { file: "app/api/sales/sales-upload/commit/route.ts", permission: salesImport, firstStorageStep: "await resolveUploadedSpreadsheet(request, access)" },
  { file: "app/api/sales/weekly/upload/route.ts", permission: weeklyImport, firstStorageStep: "await resolveWeeklyUploadRequest(request, access)" },
  { file: "app/api/sales/weekly/validate/route.ts", permission: weeklyImport, firstStorageStep: "await resolveWeeklyUploadRequest(request, access)" },
  { file: "app/api/sales/weekly/verify/route.ts", permission: weeklyImport, firstStorageStep: "await resolveWeeklyUploadRequest(request, access)" },
] as const;

const storageCall = /\.storage\s*\.\s*from\s*\(/;

function mint(caller: Caller, fileName: unknown, uploadId: string = randomUUID()): string {
  const path = buildSalesImportUploadPath({ caller, fileName, uploadId });
  assert.ok(path, `upload-url must be able to mint a slot for ${JSON.stringify(caller)}`);
  return path;
}

/** The text of a top-level function, from its declaration to its closing brace at column 0. */
function functionBody(text: string, name: string): { body: string; start: number } {
  const start = text.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is still defined`);
  const end = /\r?\n\}\r?\n/.exec(text.slice(start));
  assert.ok(end, `${name} still closes at column 0`);
  return { body: text.slice(start, start + end.index), start };
}

/**
 * The guard's shape at one site: the path is read from the body, matched to the caller, refused with a
 * 400 when it is not theirs, and only then collected for cleanup or handed to a storage call. Every
 * position is a first occurrence, so a storage step that also appears earlier fails the order too.
 */
function assertCheckedBeforeStorage(site: {
  label: string;
  text: string;
  declarations: readonly string[];
  checks: readonly string[];
  steps: readonly string[];
}) {
  const { label, text } = site;
  const declaredAt = Math.max(
    ...site.declarations.map((declaration) => {
      const at = text.indexOf(declaration);
      assert.ok(at >= 0, `${label}: the path is still read with ${declaration}`);
      return at;
    }),
  );
  const checkedAt = Math.max(
    ...site.checks.map((check) => {
      const at = text.indexOf(check);
      assert.ok(at > declaredAt, `${label}: ${check} must run on the path the route just read`);
      return at;
    }),
  );
  const refusedAt = text.indexOf("SALES_UPLOAD_PATH_REFUSAL", checkedAt);
  assert.ok(refusedAt > checkedAt, `${label}: a path that is not the caller's own is refused right after the check`);
  let previousAt = refusedAt;
  for (const step of site.steps) {
    const at = text.indexOf(step);
    assert.ok(at >= 0, `${label}: ${step} is still there`);
    assert.ok(
      at > refusedAt,
      `${label}: ${step} must come after the ownership check and its refusal, or another importer's workbook is read or deleted first`,
    );
    assert.ok(at >= previousAt, `${label}: ${step} keeps its place in the sequence`);
    previousAt = at;
  }
  const firstStepAt = text.indexOf(site.steps[0]);
  assert.match(
    text.slice(refusedAt, firstStepAt),
    /status: 400/,
    `${label}: a path that is not the caller's own upload answers 400`,
  );
}

// A workbook over ~4MB cannot be POSTed through a function, so the browser uploads it to the private
// sales-imports bucket through a signed URL and hands the storage path back to validate, detect,
// preview, commit and cancel, to the /sales/upload analyze and commit pair, and to weekly verify,
// validate and upload. Each reads the object with the service-role client, and most then delete it.
// Before this guard nothing tied the path to the caller, so any sales importer could read, and then
// erase, any object in the bucket.
export function runSalesImportUploadPathTests() {
  const uploadId = "0b7f8a52-3c1e-4d6a-9f2b-5e8c7d1a4b30";
  const otherUploadId = "7d3c1e90-2b4f-4a8e-b6d5-c1f0e9a8b7d6";
  const b10: Caller = { hrId: "b-10", loginId: "b10.login" };
  const b11: Caller = { hrId: "b-11", loginId: "b11.login" };
  const ownerB10 = salesImportUploadOwner(b10);
  const ownerB11 = salesImportUploadOwner(b11);
  assert.ok(ownerB10 && ownerB11, "an employee with an HR id owns upload slots");
  const own = mint(b10, "IS-S April 2026.xlsx", uploadId);
  const theirs = mint(b11, "IS-S April 2026.xlsx", otherUploadId);

  // 1. The caller's own upload is accepted.
  assert.equal(
    own,
    `${SALES_IMPORT_UPLOAD_ROOT}/${ownerB10}/${uploadId}/IS-S-April-2026.xlsx`,
    "upload-url mints incoming/<owner>/<upload id>/<file name>, the one shape every route accepts",
  );
  assert.equal(isOwnSalesImportUploadPath({ caller: b10, storagePath: own }), true, "an importer's own upload is exactly what the routes exist to accept");
  assert.deepEqual(
    parseSalesImportUploadPath(own),
    { fileName: "IS-S-April-2026.xlsx", owner: ownerB10, uploadId },
    "a slot parses into its owner, upload id and file name",
  );
  assert.match(ownerB10, /^[0-9a-f]{32}$/, "the owner segment is a 32-character lowercase hex digest");
  assert.equal(
    salesImportUploadOwner({ hrId: " B-10 " }),
    ownerB10,
    "the HR id decides the owner whatever its case or padding, and whatever login id rides along",
  );
  assert.equal(
    isOwnSalesImportUploadPath({ caller: { hrId: "B-10" }, storagePath: own }),
    true,
    "the same employee arriving through a dev-auth header context, with no login id, still owns the slot",
  );
  assert.ok(!own.includes("b-10") && !own.includes("b10.login"), "the storage key carries a digest, never the raw id");
  const loginOnly = mint({ hrId: null, loginId: "field.admin@example.com" }, "IS-S April 2026.xlsx");
  assert.ok(!loginOnly.includes("field.admin") && !loginOnly.includes("@"), "a login id, often an email address, never lands in a storage key");

  // Round trip: whatever upload-url mints, the routes accept back from the same caller. The three
  // upload screens post urlPayload.path back untouched, so a slot the parser refuses would refuse
  // every large workbook that importer uploads.
  const callers: Caller[] = [
    b10,
    { hrId: "B-10" },
    { hrId: null, loginId: "field.admin@example.com" },
    { hrId: "  ", loginId: "  imports.desk  " },
  ];
  const fileNames = [
    "IS-S April 2026.xlsx",
    "مبيعات أبريل ٢٠٢٦.xlsx",
    "Pharma Overseas (sales) — week 3.XLS",
    "a.xls",
    "report.csv",
    "../../../etc/passwd",
    "..",
    ".",
    "...xlsx",
    "-leading-and-trailing-.xlsx-",
    "C:\\fakepath\\book.xlsx",
    "a/b/c.xlsx",
    "%2e%2e%2fbook.xlsx",
    "book.xlsx\u0000.png",
    "",
    "   ",
    null,
    undefined,
  ];
  for (const caller of callers) {
    for (const fileName of fileNames) {
      const minted = mint(caller, fileName);
      assert.equal(
        isOwnSalesImportUploadPath({ caller, storagePath: minted }),
        true,
        `upload-url mints ${JSON.stringify(minted)} for ${JSON.stringify(caller)} and ${JSON.stringify(fileName)}; validate, cancel and every other route must accept it back from that caller`,
      );
      assert.equal(parseSalesImportUploadPath(minted)?.owner, salesImportUploadOwner(caller), "the minted owner segment is the caller's own");
    }
  }

  // 2. Another caller's upload is refused.
  assert.equal(
    isOwnSalesImportUploadPath({ caller: b11, storagePath: own }),
    false,
    "one importer must never name, and so read or delete, another importer's workbook",
  );
  assert.equal(isOwnSalesImportUploadPath({ caller: b10, storagePath: theirs }), false, "and the other way round");
  for (const other of [
    { hrId: "b-100" },
    { hrId: "b-1" },
    { hrId: null, loginId: "b-10" },
    { hrId: null, loginId: "hr:b-10" },
    { hrId: null, loginId: "b10.login" },
    { hrId: null, loginId: null },
    { hrId: "", loginId: "" },
    { hrId: "  ", loginId: "  " },
    null,
    undefined,
  ] satisfies Caller[]) {
    assert.equal(
      isOwnSalesImportUploadPath({ caller: other, storagePath: own }),
      false,
      `${JSON.stringify(other)} does not own B-10's slot: HR ids and login ids are separate identities, and no identity owns nothing`,
    );
  }
  const fieldAdminSlot = mint({ hrId: null, loginId: "field.admin" }, "book.xlsx");
  assert.equal(
    isOwnSalesImportUploadPath({ caller: { hrId: "field.admin" }, storagePath: fieldAdminSlot }),
    false,
    "an HR id spelled like a login id is a different caller",
  );
  assert.equal(
    isOwnSalesImportUploadPath({ caller: { hrId: null, loginId: "field.admin2" }, storagePath: fieldAdminSlot }),
    false,
    "one login-only account never owns another's slot",
  );
  for (const nobody of [{ hrId: null, loginId: null }, { hrId: " ", loginId: " " }, null, undefined] satisfies Caller[]) {
    assert.equal(salesImportUploadOwner(nobody), null, `${JSON.stringify(nobody)} has no identity, so it owns no slot at all`);
    assert.equal(
      buildSalesImportUploadPath({ caller: nobody, fileName: "book.xlsx", uploadId }),
      null,
      "upload-url answers 403 rather than mint a slot shared by every caller without an identity",
    );
  }
  for (const badUploadId of ["../../x", uploadId.toUpperCase(), `${uploadId}/x`, ""]) {
    assert.equal(
      buildSalesImportUploadPath({ caller: b10, fileName: "book.xlsx", uploadId: badUploadId }),
      null,
      `the builder never mints a slot around ${JSON.stringify(badUploadId)}`,
    );
  }

  // 3. A path outside the minted prefix is refused, the caller's own digest included.
  for (const storagePath of [
    `incoming/${uploadId}/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/IS-S-April-2026.xlsx`,
    `${ownerB10}/${uploadId}/IS-S-April-2026.xlsx`,
    `outgoing/${ownerB10}/${uploadId}/IS-S-April-2026.xlsx`,
    `Incoming/${ownerB10}/${uploadId}/IS-S-April-2026.xlsx`,
    `closings/${ownerB10}/${uploadId}/IS-S-April-2026.xlsx`,
    `closings/2026-08/${uploadId}/premium.xlsx`,
    "IS-S-April-2026.xlsx",
  ]) {
    assert.equal(parseSalesImportUploadPath(storagePath), null, `${JSON.stringify(storagePath)} is not an upload slot`);
    assert.equal(
      isOwnSalesImportUploadPath({ caller: b10, storagePath }),
      false,
      `${JSON.stringify(storagePath)} lies outside incoming/<owner>/<upload id>/ and must be refused`,
    );
  }

  // 4. Traversal, extra or empty segments, and anything the builder never mints are refused. The storage
  //    client puts the path into the download URL unencoded, and URL parsing resolves `..` and `%2e%2e`
  //    there, so an unchecked path reached objects in OTHER buckets; `#` and `?` would also have carried
  //    a non-workbook past the routes' file-name extension check.
  assert.notEqual(ownerB10, ownerB10.toUpperCase(), "the digest has letters, so the upper-case variant below is a real case");
  for (const storagePath of [
    `incoming/${ownerB10}/${uploadId}/%2e%2e`,
    `incoming/${ownerB10}/${uploadId}/IS-S-April-2026.pdf#.xlsx`,
    `incoming/${ownerB10}/${uploadId}/IS-S-April-2026.pdf?download=.xlsx`,
    `${own}/../../../${ownerB11}/${otherUploadId}/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/../${ownerB11}/${otherUploadId}/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/${uploadId}/../../${ownerB11}/${otherUploadId}/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/${uploadId}/..`,
    `incoming/${ownerB10}/${uploadId}/.`,
    `incoming/${ownerB10}/${uploadId}/...`,
    `incoming/${ownerB10}/..`,
    `incoming/${ownerB10}/${uploadId}/extra/IS-S-April-2026.xlsx`,
    `${own}/`,
    `/${own}`,
    own.replace("/", "//"),
    own.replaceAll("/", "\\"),
    `incoming/${ownerB10}/${uploadId}/..%2F..%2F${ownerB11}%2F${otherUploadId}%2FIS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/${uploadId}/`,
    `incoming/${ownerB10}/${uploadId}`,
    `incoming/${ownerB10.toUpperCase()}/${uploadId}/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/${uploadId.toUpperCase()}/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/not-an-upload-id/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10.slice(1)}/${uploadId}/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}0/${uploadId}/IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/${uploadId}/IS-S April 2026.xlsx`,
    `incoming/${ownerB10}/${uploadId}/IS-S-April-2026`,
    `incoming/${ownerB10}/${uploadId}/-IS-S-April-2026.xlsx`,
    `incoming/${ownerB10}/${uploadId}/IS-S-April-2026.xlsx\u0000`,
    "",
  ]) {
    assert.equal(parseSalesImportUploadPath(storagePath), null, `${JSON.stringify(storagePath)} does not parse`);
    assert.equal(
      isOwnSalesImportUploadPath({ caller: b10, storagePath }),
      false,
      `${JSON.stringify(storagePath)} is not a single upload slot and must be refused, even under the caller's own prefix`,
    );
  }
  assert.equal(isOwnSalesImportUploadPath({ caller: b10, storagePath: null }), false, "no path is no slot");
  assert.equal(SALES_UPLOAD_PATH_REFUSAL.code, "invalid_upload_path", "the refusal keeps a stable code the screens can read");

  // 5. Each route asserts its import permission, then reaches storage only through a check.
  for (const route of consumerRoutes) {
    const text = source(route.file);
    const accessAt = text.indexOf("const access = await resolveAccessContext(request)");
    const permissionAt = text.indexOf(route.permission);
    const firstStorageStepAt = text.indexOf(route.firstStorageStep);
    assert.ok(accessAt >= 0, `${route.file}: the caller is still the session's own access context`);
    assert.ok(permissionAt > accessAt, `${route.file}: ${route.permission} runs on that caller`);
    assert.ok(firstStorageStepAt > permissionAt, `${route.file}: ${route.permission} comes before ${route.firstStorageStep}`);
    assert.doesNotMatch(
      text,
      storageCall,
      `${route.file} must reach storage only through the guarded helpers in monthly-import-request.ts`,
    );
  }

  // validate, cancel and detect check inline, before collecting the path for cleanup or touching storage.
  assertCheckedBeforeStorage({
    label: "monthly-import/validate",
    text: source("app/api/sales/monthly-import/validate/route.ts"),
    declarations: ['const storagePath = String(body?.storagePath ?? "").trim();'],
    checks: ["!isOwnSalesImportUploadPath({ caller: access, storagePath })"],
    steps: ["cleanupStoragePath = storagePath", "await downloadSalesUploadFile(storagePath)"],
  });
  assertCheckedBeforeStorage({
    label: "monthly-import/cancel",
    text: source("app/api/sales/monthly-import/cancel/route.ts"),
    declarations: ['const storagePath = String(body?.storagePath ?? "").trim();'],
    checks: ["!isOwnSalesImportUploadPath({ caller: access, storagePath })"],
    steps: ["await removeSalesUploadObject(storagePath || null)"],
  });
  assertCheckedBeforeStorage({
    label: "monthly-import/detect resolveBuffer",
    text: functionBody(source("app/api/sales/monthly-import/detect/route.ts"), "resolveBuffer").body,
    declarations: ['const path = String(body?.storagePath ?? "").trim();'],
    checks: ["!isOwnSalesImportUploadPath({ caller, storagePath: path })"],
    steps: ["await downloadSalesUploadObject(path)"],
  });

  // The three shared resolvers check before the path joins what the route will delete, and before any download.
  const requestModuleText = source(requestModule);
  assertCheckedBeforeStorage({
    label: "resolveSalesUploadRequest (monthly preview and commit)",
    text: functionBody(requestModuleText, "resolveSalesUploadRequest").body,
    declarations: ['const path = String(body?.storagePath ?? "").trim();'],
    checks: ["!isOwnSalesImportUploadPath({ caller, storagePath: path })"],
    steps: ["storagePath = path;", "await downloadSalesUploadFile(path)"],
  });
  assertCheckedBeforeStorage({
    label: "resolveUploadedSpreadsheet (sales-upload analyze and commit)",
    text: functionBody(requestModuleText, "resolveUploadedSpreadsheet").body,
    // One reference or several (storagePaths[], several sheets of one distributor): each is checked
    // before it joins what the route deletes, and before any is downloaded.
    declarations: ["for (const path of requested) {"],
    checks: ["!isOwnSalesImportUploadPath({ caller, storagePath: path })"],
    steps: ["storagePaths.push(path)", "await downloadSalesUploadFile(path)", "storagePath: storagePaths[0], storagePaths"],
  });
  const weekly = functionBody(requestModuleText, "resolveWeeklyUploadRequest").body;
  const psBranchAt = weekly.indexOf('if (distributorCode.toUpperCase() === "PS") {');
  const singleFileAt = weekly.indexOf('const path = String(body?.storagePath ?? "").trim();');
  assert.ok(psBranchAt >= 0 && singleFileAt > psBranchAt, "the weekly resolver still has its Overseas POS branch before the single-file one");
  assertCheckedBeforeStorage({
    label: "resolveWeeklyUploadRequest, Overseas POS pair",
    text: weekly.slice(psBranchAt, singleFileAt),
    declarations: [
      'const salesPath = String(body?.salesStoragePath ?? "").trim();',
      'const stockPath = String(body?.stockStoragePath ?? "").trim();',
    ],
    checks: [
      "!isOwnSalesImportUploadPath({ caller, storagePath: salesPath })",
      "!isOwnSalesImportUploadPath({ caller, storagePath: stockPath })",
    ],
    steps: ["storagePaths.push(salesPath, stockPath)", "downloadSalesUploadFile(salesPath)", "downloadSalesUploadFile(stockPath)"],
  });
  assertCheckedBeforeStorage({
    label: "resolveWeeklyUploadRequest, single file",
    text: weekly.slice(singleFileAt),
    declarations: ['const path = String(body?.storagePath ?? "").trim();'],
    checks: ["!isOwnSalesImportUploadPath({ caller, storagePath: path })"],
    steps: ["storagePaths.push(path)", "await downloadSalesUploadFile(path)"],
  });
  assert.ok(
    weekly.indexOf("storagePaths.push(") > weekly.indexOf("!isOwnSalesImportUploadPath("),
    "no weekly path joins storagePaths, which the route deletes in its finally block, before it is matched to the caller",
  );

  // 6. The service-role storage helpers refuse anything that is not an upload slot themselves, and
  //    they are the module's only storage calls.
  const guardedHelpers = [
    { name: "downloadSalesUploadObject", guard: "if (!parseSalesImportUploadPath(storagePath)) return null;", call: ".download(storagePath)" },
    { name: "removeSalesUploadObject", guard: "!parseSalesImportUploadPath(storagePath)) return;", call: ".remove([storagePath])" },
    { name: "removeSalesUploadObjects", guard: "parseSalesImportUploadPath(path) !== null", call: ".remove(paths)" },
  ] as const;
  const helperRanges = guardedHelpers.map((helper) => {
    const { body, start } = functionBody(requestModuleText, helper.name);
    const guardAt = body.indexOf(helper.guard);
    const callAt = body.indexOf(helper.call);
    assert.ok(
      guardAt >= 0 && callAt > guardAt,
      `${helper.name} must refuse a path that is not an upload slot before its service-role ${helper.call} call`,
    );
    return { end: start + body.length, guardAt: start + guardAt, start };
  });
  const moduleStorageCalls = [...requestModuleText.matchAll(new RegExp(storageCall.source, "g"))].map((match) => match.index ?? -1);
  assert.equal(moduleStorageCalls.length, guardedHelpers.length, "monthly-import-request.ts has exactly one storage call per guarded helper");
  for (const at of moduleStorageCalls) {
    const line = requestModuleText.slice(0, at).split("\n").length;
    const helper = helperRanges.find((range) => at > range.start && at < range.end);
    assert.ok(
      helper && at > helper.guardAt,
      `the storage call on line ${line} of monthly-import-request.ts must sit inside a guarded helper, after its guard`,
    );
  }
  const downloadFile = functionBody(requestModuleText, "downloadSalesUploadFile").body;
  assert.ok(
    downloadFile.includes("await downloadSalesUploadObject(storagePath)") && !storageCall.test(downloadFile),
    "downloadSalesUploadFile reads only through the guarded downloadSalesUploadObject",
  );

  // Nothing else on the server opens the bucket: a new route that downloaded a client-supplied path
  // itself would step around every check above.
  const namesBucket = /SALES_IMPORT_BUCKET|=\s*["'`]sales-imports["'`]|from\(\s*["'`]sales-imports["'`]/;
  const bucketOpeners = ["app", "src/lib"]
    .flatMap((directory) =>
      readdirSync(join(repoRoot, directory), { encoding: "utf8", recursive: true })
        .filter((name) => /\.tsx?$/.test(name))
        .map((name) => `${directory}/${name.replaceAll("\\", "/")}`),
    )
    .filter((file) => {
      const text = source(file);
      return storageCall.test(text) && namesBucket.test(text);
    })
    .sort();
  assert.deepEqual(
    bucketOpeners,
    [uploadUrlRoute, requestModule],
    "only upload-url (which mints) and the guarded helpers open the sales-imports bucket; route any new reader through them",
  );

  // 7. upload-url mints through the same definition every route checks against, for its own caller.
  const uploadUrl = source(uploadUrlRoute);
  const mintAt = uploadUrl.indexOf("buildSalesImportUploadPath({ caller: access,");
  const noIdentityAt = uploadUrl.indexOf("if (!path) {", mintAt);
  const signAt = uploadUrl.indexOf("createSignedUploadUrl(path)");
  assert.ok(mintAt >= 0, "upload-url must mint its path with buildSalesImportUploadPath for the session's own caller");
  assert.ok(uploadUrl.indexOf(salesImport) >= 0 && uploadUrl.indexOf(salesImport) < mintAt, "upload-url asserts sales:import before minting");
  assert.match(uploadUrl, /uploadId: crypto\.randomUUID\(\)/, "each slot gets a fresh random upload id");
  assert.ok(noIdentityAt > mintAt && signAt > noIdentityAt, "a caller with no identity is turned away before a signed URL is created");
  assert.match(uploadUrl.slice(noIdentityAt, signAt), /status: 403/, "a caller with no identity answers 403");
  assert.match(
    uploadUrl,
    /\bpath, token: data\.token/,
    "upload-url answers with the path it minted, so the browser hands back exactly what the routes accept",
  );
  assert.doesNotMatch(uploadUrl, /`incoming\//, "a hand-built path can drift from the shape the routes accept and refuse every large upload");
  assert.doesNotMatch(uploadUrl, /function sanitizeFileName/, "the file name is sanitised once, in sales-import-upload-path.ts");
}
