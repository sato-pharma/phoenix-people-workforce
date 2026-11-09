/**
 * Getting an app or a file onto the tablets.
 *
 * 🔴 THERE IS NO "INSTALL THIS APP" COMMAND IN HEADWIND, AND LOOKING FOR ONE WASTES A SESSION. An app
 * is on a tablet because it is in that tablet's configuration; a file is on a tablet because it is in
 * that configuration's file list. So "install" is three separate acts, and only the last one reaches a
 * tablet:
 *
 *   1. Send the bytes up            POST /rest/private/web-ui-files   (multipart, field `file`)
 *                                        → FileUploadResult.serverPath
 *   2. Register what they are       PUT  /rest/private/applications/android   { filePath: serverPath }
 *                                        (the server reads the APK itself for package and version)
 *   3. Put it in the rules          POST /rest/private/applications/configurations   ← configurations.ts
 *
 * 🔴 THE UPLOAD PATH IS `/rest/private/web-ui-files`, NOT `/rest/upload`. There is no `/rest/upload`
 * in this server at all; it is a plausible-looking name that returns 404 and reads as a broken bridge.
 *
 * 🔴 STEP 1 ALONE CHANGES NOTHING. The bytes sit in the server's own staging area until step 2 names
 * them, and no tablet hears about either until step 3. A caller that stops after step 1 and reports
 * "uploaded" has told the truth about the bytes and a lie about the fleet, which is why this module
 * does the whole chain in one call and says at the end which tablets it actually reaches.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import {
  applyToEachRules,
  type HeadwindAuditWriter,
  type HeadwindConfigurationSummary,
  type HeadwindRulesTarget,
  linkHeadwindApp,
  linkHeadwindFile,
  resolveHeadwindRules,
  secureHeadwindVersionLinks,
  tabletFollowableUrl,
} from "@/lib/devices/headwind/configurations";

export class HeadwindUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindUploadError";
  }
}

/** 300 MB — above any APK this fleet carries, and below what the route's 300-second budget can move. */
export const HEADWIND_MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

type FileUploadResult = { serverPath?: string; fileDetails?: unknown; [field: string]: unknown };

/**
 * The body that registers an uploaded APK as an application.
 *
 * 🔴 THE NAME, PACKAGE AND VERSION COME FROM THE SERVER'S OWN READING OF THE FILE, AND LEAVING THEM
 * OUT FAILS AS A 200. `POST /rest/private/web-ui-files` answers `{ serverPath, fileDetails }`, where
 * `fileDetails` is what the server read out of the APK — `pkg`, `name` (the label), `version`,
 * `versionCode`, `arch`. The Headwind console copies those onto the application before it calls
 * `PUT /rest/private/applications/android` (`applications.controller.js`). Sending only `filePath`
 * makes the insert hit `null value in column "name" of relation "applications"` and the server answers
 * `{"status":"ERROR","message":"error.internal.server"}` under an HTTP 200 — measured on production,
 * 9 Nov 2026, uploading the Sato Anti-Infective line app. A label the server could not read falls back
 * to the package name, so the NOT NULL column is never sent empty.
 */
export function applicationRegisterBody(
  serverPath: string,
  fileDetails: unknown,
  showIcon: boolean,
): Record<string, unknown> {
  const details = fileDetails && typeof fileDetails === "object" ? (fileDetails as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const pkg = text(details.pkg);
  const body: Record<string, unknown> = { filePath: serverPath, showIcon, type: "app" };
  if (pkg) body.pkg = pkg;
  const name = text(details.name) ?? pkg;
  if (name) body.name = name;
  const version = text(details.version);
  if (version) body.version = version;
  if (typeof details.versionCode === "number") body.versionCode = details.versionCode;
  const arch = text(details.arch);
  if (arch) body.arch = arch;
  return body;
}

/**
 * `tabletFollowableUrl` and the https step live beside the link check in `configurations.ts`, because
 * linking an app (not only uploading one) must move its links onto https first. Re-exported here, where
 * the upload's own readers look for it.
 */
export { tabletFollowableUrl };

/**
 * Step 1 — send the bytes up.
 *
 * 🔴 `FormData` IS PASSED THROUGH UNTOUCHED AND THAT IS DELIBERATE. `callHeadwind` recognises a
 * `FormData` body and sets no content type, because writing one by hand drops the multipart boundary
 * the server needs to find the file — an upload that then fails with a shape error rather than a
 * useful one.
 */
async function uploadBytes(
  file: File,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<{ serverPath: string; fileDetails: unknown }> {
  const form = new FormData();
  form.append("file", file, file.name);
  const result = await callHeadwind<FileUploadResult>(
    "/rest/private/web-ui-files",
    { body: form, method: "POST" },
    fetchImpl,
    env,
  );
  const serverPath = typeof result?.serverPath === "string" ? result.serverPath : "";
  if (!serverPath) {
    throw new HeadwindUploadError(
      "The Headwind server took the file but did not say where it put it, so it cannot be installed. " +
        "Nothing reached any tablet. Check the server has disk space left and try again.",
    );
  }
  return { fileDetails: result?.fileDetails ?? null, serverPath };
}

function checkFile(file: unknown, what: string): File {
  if (!(file instanceof File) || !file.size) {
    throw new HeadwindUploadError(`Choose ${what} to send.`);
  }
  if (file.size > HEADWIND_MAX_UPLOAD_BYTES) {
    throw new HeadwindUploadError(
      `That file is ${Math.round(file.size / (1024 * 1024))} MB. The limit here is ` +
        `${HEADWIND_MAX_UPLOAD_BYTES / (1024 * 1024)} MB, because anything larger will not finish before the ` +
        "request times out and would leave a half-written file on the server.",
    );
  }
  return file;
}

/**
 * The most a request to the upload route may carry: the file's own limit plus room for the multipart
 * framing around it.
 */
export const HEADWIND_MAX_UPLOAD_REQUEST_BYTES = HEADWIND_MAX_UPLOAD_BYTES + 1024 * 1024;

/**
 * Whether the upload route may read a request body of this declared length at all.
 *
 * 🔴 `formData()` HOLDS THE WHOLE BODY IN MEMORY BEFORE ANY CHECK RUNS. The route is left out of the
 * proxy (its 10 MB copy cut every APK short), so nothing in front of it caps the body either: a 2 GB
 * POST was buffered whole and only then refused by `checkFile` as over 300 MB. The declared length is
 * read first — none (a chunked body, whose size is unknown until it is read) is refused, and so is one
 * over the cap. A browser's FormData upload always declares it.
 */
export function headwindUploadLengthDecision(
  value: string | null,
): { ok: true } | { ok: false; status: 400 | 411 | 413; message: string } {
  const text = value?.trim() ?? "";
  if (!text) {
    return { message: "The upload did not say how large it is, so it was not read. Send it again from the page.", ok: false, status: 411 };
  }
  if (!/^\d+$/.test(text) || Number(text) <= 0) {
    return { message: "The upload's size is not a number, so it was not read.", ok: false, status: 400 };
  }
  if (Number(text) > HEADWIND_MAX_UPLOAD_REQUEST_BYTES) {
    return {
      message: `That upload is over the ${HEADWIND_MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit, so it was not read. Nothing reached the tablet server.`,
      ok: false,
      status: 413,
    };
  }
  return { ok: true };
}

/**
 * An APK is a zip archive, and every zip starts with the four bytes `PK\x03\x04`.
 *
 * 🔴 A FILE MERELY NAMED `.apk` USED TO BE SENT WHOLE AND REGISTERED. The server then read no package
 * out of it, the register failed as `error.internal.server` under an HTTP 200, and that failed register
 * consumed the uploaded file — a sentence that names nothing, after up to 300 MB crossed the network
 * twice. Four bytes read here refuse it before anything is sent.
 */
export async function looksLikeApk(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

export type HeadwindAppUploadResult = {
  applicationId: number | null;
  packageName: string | null;
  version: string | null;
  installed: boolean;
  /** The names of the sets of rules the app was put on — empty when none was named. */
  rules: string[];
  message: string;
};

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Send an APK up and, if sets of rules were named, install it on every tablet carrying them.
 *
 * The server reads the package name and version out of the APK itself — Phoenix does not parse it and
 * does not guess. `showIcon` defaults to true because an app nobody can see is the hidden case, not
 * the ordinary one. `rules` may name sets by id, or be `"rep"`: every rep set of rules ("Rep tablets"
 * and each line's copy), which a change meant for every rep tablet needs (runbook §8.17) — the app is
 * uploaded ONCE and linked to each, with one audit row per set.
 *
 * 🔴 THE REGISTRATION IS AUDITED THE MOMENT IT HAPPENS, before the https step and the links. Either of
 * those can refuse, and the app is on the server by then whatever happens next — an audit row written
 * after them left a registered app with no record of who added it.
 */
export async function uploadHeadwindApp(
  input: { file: unknown; rules?: HeadwindRulesTarget | null; showIcon?: boolean },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: HeadwindAuditWriter = writeRequiredAuditLog,
): Promise<HeadwindAppUploadResult> {
  const file = checkFile(input.file, "an APK");
  if (!file.name.toLowerCase().endsWith(".apk")) {
    throw new HeadwindUploadError(
      "That is not an APK. An Android app has to be a .apk file — a .aab bundle is what Google Play " +
        "builds from and cannot be installed on a tablet directly.",
    );
  }
  if (!(await looksLikeApk(file))) {
    throw new HeadwindUploadError(
      "That file is named .apk but is not an Android app — an APK is a zip archive and this file does not start like one. Nothing was sent.",
    );
  }
  // The rules are read BEFORE the bytes go up, so a set that does not exist refuses with nothing sent.
  const rules: HeadwindConfigurationSummary[] = input.rules ? await resolveHeadwindRules(input.rules, fetchImpl, env) : [];

  const { fileDetails, serverPath } = await uploadBytes(file, fetchImpl, env);
  const details = fileDetails && typeof fileDetails === "object" ? (fileDetails as Record<string, unknown>) : {};
  const readPackage = readText(details.pkg);
  const readVersion = readText(details.version);
  // 🔴 NO PACKAGE READ, NO REGISTER. The server could not read the file as an app; registering it anyway
  // fails as `error.internal.server` under an HTTP 200 and consumes the uploaded file (see below).
  if (!readPackage) {
    throw new HeadwindUploadError(
      "The tablet server could not read a package name out of that file, so it was not added — it is not a working Android app. Nothing reached any tablet.",
    );
  }

  // 🔴 `type: "app"` IS NOT OPTIONAL, AND LEAVING IT OUT FAILS AS A 200. Headwind's `applications`
  // table has NOT NULL on `type`, so without it the insert throws and the server answers
  // `{"status":"ERROR","message":"error.internal.server"}` under an HTTP **200** — a message that
  // names nothing and reads like the server being unwell. The real cause is only in the container's
  // own log: `PSQLException: null value in column "type" of relation "applications" violates
  // not-null constraint` (measured on production, 2026-09-28, uploading the Phoenix mdm APK). Every
  // one of the 75 seeded catalogue rows carries `"app"`; nothing else appears.
  //
  // 🔴 AND A FAILED REGISTER CONSUMES THE UPLOADED TEMP FILE. The next attempt against the same
  // `serverPath` dies with `FileNotFoundException … Could not move the uploaded .apk-file` — a
  // DIFFERENT error that hides the first one, so retrying a body shape without re-uploading tests
  // nothing and reads as a second, unrelated fault.
  const application = await callHeadwind<Record<string, unknown>>(
    "/rest/private/applications/android",
    {
      body: JSON.stringify(applicationRegisterBody(serverPath, fileDetails, input.showIcon !== false)),
      method: "PUT",
    },
    fetchImpl,
    env,
  );

  const applicationId = typeof application?.id === "number" ? application.id : null;
  const packageName = readText(application?.pkg);
  const version = readText(application?.version);
  const shownVersion = version ?? readVersion;
  const label = `${packageName ?? readPackage}${shownVersion ? ` ${shownVersion}` : ""}`;

  await audit({
    actorLoginId: actor,
    entityId: packageName ?? readPackage,
    entityType: "headwind_configuration",
    newValues: {
      applicationId,
      change: "application-upload",
      fileName: file.name,
      packageName,
      readPackage,
      readVersion,
      sizeBytes: file.size,
      version,
    },
    oldValues: null,
    summary: `Added ${label} to the Headwind app list`,
  });

  // 🔴 WHAT THE SERVER REGISTERED MUST BE WHAT WAS UPLOADED. A register that answers with another
  // package, or another version of it, would put THAT on the tablets under this upload's name.
  if (packageName && packageName !== readPackage) {
    throw new HeadwindUploadError(
      `The file is ${readPackage}, but the tablet server registered it as ${packageName}, so it was put on no tablet rules. Check the app list in the Headwind console before sending it again.`,
    );
  }
  // 🔴 A DIFFERENT VERSION IN THE ANSWER IS SAID, NEVER REFUSED (9 Nov 2026). Registering a version of a
  // package the server already holds answers with that package's row, and its `version` is the newest the
  // server keeps — what a linked tablet installs, because a set of rules links the APP, not one version.
  // Refusing here would refuse the ordinary upgrade whenever the row answers before it moved on; the
  // tablets' version is named in the message instead, so nobody believes the upload's version went out.
  const versionNote =
    version && readVersion && version !== readVersion
      ? ` The tablet server's newest ${readPackage} is ${version}, not the uploaded ${readVersion} — tablets on these rules install ${version}.`
      : "";
  if (applicationId === null) {
    if (rules.length) {
      throw new HeadwindUploadError(
        `${label} was added to the tablet server, but the server did not say which app it became, so it was put on no tablet rules. Put it on the rules from the app list in the Headwind console.`,
      );
    }
    return {
      applicationId,
      installed: false,
      message: `${label} is on the server. 🔴 It is on NO tablet yet — put it in a set of tablet rules to install it. Uploading alone reaches nobody.`,
      packageName,
      rules: [],
      version,
    };
  }

  // Every version onto https, and refused while the one the tablets get is not (§8.18).
  await secureHeadwindVersionLinks(applicationId, fetchImpl, env);

  const reached = rules.length
    ? await applyToEachRules(
        rules,
        (set) =>
          linkHeadwindApp(
            { action: 1, applicationId, configurationId: set.id, showIcon: input.showIcon !== false },
            actor,
            fetchImpl,
            env,
            audit,
          ),
        `${label} is on the tablet server. Putting it on the rules`,
      )
    : [];

  return {
    applicationId,
    installed: reached.length > 0,
    message: reached.length
      ? `${label} is on the server and in ${reached.join(", ")}. Every tablet on those rules installs it at its next check-in.${versionNote}`
      : `${label} is on the server. 🔴 It is on NO tablet yet — put it in a set of tablet rules to install it. Uploading alone reaches nobody.${versionNote}`,
    packageName,
    rules: reached,
    version,
  };
}

export type HeadwindFileUploadResult = { fileId: number | null; sent: boolean; rules: string[]; message: string };

/**
 * Send an ordinary file up, and put it in sets of tablet rules so the tablets hold it.
 *
 * 🔴 STEP 2 HERE IS `PUT /rest/private/web-ui-files`, AND UNLIKE THE APK PATH ITS EXACT BODY IS NOT
 * PINNED FROM SOURCE IN THIS REPOSITORY — the server's own upload result is therefore passed back
 * whole, with only the destination path and description added, rather than a body assembled from
 * guesses. If the server refuses it, the refusal is shown as it came, and the bytes are still in the
 * staging area: nothing is half-installed on a tablet, because step 3 never runs.
 */
export async function uploadHeadwindFile(
  input: { file: unknown; rules?: HeadwindRulesTarget | null; description?: string | null; path?: string | null },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: HeadwindAuditWriter = writeRequiredAuditLog,
): Promise<HeadwindFileUploadResult> {
  const file = checkFile(input.file, "a file");
  const rules: HeadwindConfigurationSummary[] = input.rules ? await resolveHeadwindRules(input.rules, fetchImpl, env) : [];
  const { serverPath } = await uploadBytes(file, fetchImpl, env);

  const saved = await callHeadwind<Record<string, unknown>>(
    "/rest/private/web-ui-files",
    {
      body: JSON.stringify({
        description: input.description?.trim() || null,
        filePath: serverPath,
        path: input.path?.trim() || file.name,
      }),
      method: "PUT",
    },
    fetchImpl,
    env,
  );

  const fileId = typeof saved?.id === "number" ? saved.id : null;

  await audit({
    actorLoginId: actor,
    entityId: file.name,
    entityType: "headwind_configuration",
    newValues: { change: "file-upload", fileId, fileName: file.name, sizeBytes: file.size },
    oldValues: null,
    summary: `Added the file ${file.name} to the Headwind server`,
  });

  // 🔴 A FILE ASKED FOR ON RULES BUT NEVER LINKED IS A REFUSAL, NOT A QUIET "ON NO TABLET YET".
  if (fileId === null && rules.length) {
    throw new HeadwindUploadError(
      `${file.name} is on the tablet server, but the server did not say which file it became, so it was sent to no tablet rules. Send it to the rules from the Headwind console.`,
    );
  }
  const reached =
    fileId !== null && rules.length
      ? await applyToEachRules(
          rules,
          (set) => linkHeadwindFile({ configurationId: set.id, fileId }, actor, fetchImpl, env, audit),
          `${file.name} is on the tablet server. Sending it to the rules`,
        )
      : [];

  return {
    fileId,
    message: reached.length
      ? `${file.name} is in ${reached.join(", ")}. Every tablet on those rules downloads it at its next check-in.`
      : `${file.name} is on the server. 🔴 It is on NO tablet yet — put it in a set of tablet rules to send it.`,
    rules: reached,
    sent: reached.length > 0,
  };
}
