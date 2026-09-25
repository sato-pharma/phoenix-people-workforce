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
import { linkHeadwindApp, linkHeadwindFile } from "@/lib/devices/headwind/configurations";

export class HeadwindUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindUploadError";
  }
}

/** 300 MB — above any APK this fleet carries, and below what the route's 300-second budget can move. */
export const HEADWIND_MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

type FileUploadResult = { serverPath?: string; [field: string]: unknown };

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
): Promise<string> {
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
  return serverPath;
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

export type HeadwindAppUploadResult = {
  applicationId: number | null;
  packageName: string | null;
  version: string | null;
  installed: boolean;
  message: string;
};

/**
 * Send an APK up and, if a set of rules was named, install it on every tablet carrying those rules.
 *
 * The server reads the package name and version out of the APK itself — Phoenix does not parse it and
 * does not guess. `showIcon` defaults to true because an app nobody can see is the hidden case, not
 * the ordinary one.
 */
export async function uploadHeadwindApp(
  input: { file: unknown; configurationId?: number | null; showIcon?: boolean },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindAppUploadResult> {
  const file = checkFile(input.file, "an APK");
  if (!file.name.toLowerCase().endsWith(".apk")) {
    throw new HeadwindUploadError(
      "That is not an APK. An Android app has to be a .apk file — a .aab bundle is what Google Play " +
        "builds from and cannot be installed on a tablet directly.",
    );
  }

  const serverPath = await uploadBytes(file, fetchImpl, env);

  const application = await callHeadwind<Record<string, unknown>>(
    "/rest/private/applications/android",
    { body: JSON.stringify({ filePath: serverPath, showIcon: input.showIcon !== false }), method: "PUT" },
    fetchImpl,
    env,
  );

  const applicationId = typeof application?.id === "number" ? application.id : null;
  const packageName = typeof application?.pkg === "string" ? application.pkg : null;
  const version = typeof application?.version === "string" ? application.version : null;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: packageName ?? file.name,
    entityType: "headwind_configuration",
    newValues: {
      applicationId,
      change: "application-upload",
      fileName: file.name,
      packageName,
      sizeBytes: file.size,
      version,
    },
    oldValues: null,
    summary: `Added ${packageName ?? file.name}${version ? ` ${version}` : ""} to the Headwind app list`,
  });

  let installed = false;
  if (applicationId !== null && Number.isInteger(input.configurationId)) {
    await linkHeadwindApp(
      { action: 1, applicationId, configurationId: input.configurationId as number },
      actor,
      fetchImpl,
      env,
    );
    installed = true;
  }

  return {
    applicationId,
    installed,
    message: installed
      ? `${packageName ?? file.name}${version ? ` ${version}` : ""} is on the server and in the rules. Every ` +
        "tablet on those rules installs it at its next check-in."
      : `${packageName ?? file.name}${version ? ` ${version}` : ""} is on the server. 🔴 It is on NO tablet ` +
        "yet — put it in a set of tablet rules to install it. Uploading alone reaches nobody.",
    packageName,
    version,
  };
}

export type HeadwindFileUploadResult = { fileId: number | null; sent: boolean; message: string };

/**
 * Send an ordinary file up, and put it in a set of tablet rules so the tablets hold it.
 *
 * 🔴 STEP 2 HERE IS `PUT /rest/private/web-ui-files`, AND UNLIKE THE APK PATH ITS EXACT BODY IS NOT
 * PINNED FROM SOURCE IN THIS REPOSITORY — the server's own upload result is therefore passed back
 * whole, with only the destination path and description added, rather than a body assembled from
 * guesses. If the server refuses it, the refusal is shown as it came, and the bytes are still in the
 * staging area: nothing is half-installed on a tablet, because step 3 never runs.
 */
export async function uploadHeadwindFile(
  input: { file: unknown; configurationId?: number | null; description?: string | null; path?: string | null },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindFileUploadResult> {
  const file = checkFile(input.file, "a file");
  const serverPath = await uploadBytes(file, fetchImpl, env);

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

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: file.name,
    entityType: "headwind_configuration",
    newValues: { change: "file-upload", fileId, fileName: file.name, sizeBytes: file.size },
    oldValues: null,
    summary: `Added the file ${file.name} to the Headwind server`,
  });

  let sent = false;
  if (fileId !== null && Number.isInteger(input.configurationId)) {
    await linkHeadwindFile(
      { configurationId: input.configurationId as number, fileId },
      actor,
      fetchImpl,
      env,
    );
    sent = true;
  }

  return {
    fileId,
    message: sent
      ? `${file.name} is in the rules. Every tablet on those rules downloads it at its next check-in.`
      : `${file.name} is on the server. 🔴 It is on NO tablet yet — put it in a set of tablet rules to send it.`,
    sent,
  };
}
