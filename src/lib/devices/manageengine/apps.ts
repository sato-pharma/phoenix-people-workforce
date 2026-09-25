/**
 * The apps on a rep's tablet — what is installed, what the company can send it, and the changes a
 * Super Admin can make from Phoenix: add an APK to the company repository, put an app on a tablet,
 * take an app off.
 *
 * WHAT ManageEngine DISTINGUISHES, AND WHY IT MATTERS HERE. `GET /devices/{id}/apps` lists what the
 * tablet is carrying. `GET /apps` lists the company's own repository — the store and enterprise apps
 * that have been added to ManageEngine and may therefore be distributed. An app on the tablet that
 * is NOT in the repository is one the rep installed themself, and Phoenix says so on the row: it is
 * the single most useful thing this screen can tell the owner about a tablet in the field.
 *
 * 🔴 INSTALLING AND REMOVING REACH A REAL TABLET IN A REP'S HANDS. Both write a REQUIRED audit row
 * naming the tablet by its custody asset tag and the app by its name, exactly as the remote commands
 * do. Removal is `DELETE /devices/{id}/apps` with `app_ids` — it un-distributes and uninstalls the
 * app; it does not touch the rep's own data elsewhere on the tablet.
 *
 * A VERSION IS A RELEASE LABEL. ManageEngine versions an app through `release_label_id`, and the
 * install call takes `{ app_id, release_label_id }`. Phoenix sends the label the repository reports
 * for that app, so "install" means "install what the company has approved", never a version nobody
 * chose. When the repository reports no label, the app id is sent alone and ManageEngine picks the
 * current one.
 *
 * SILENT BY DEFAULT. These are company-owned, company-managed tablets: `silent_install` is true so
 * the app simply appears, and `notify_user_via_email` is false — there is no rep mailbox behind a
 * tablet and an invitation email would reach nobody.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callManageEngine, ManageEngineRequestError } from "@/lib/devices/manageengine/client";
import {
  listManageEngineDevices,
  matchManageEngineToRegister,
} from "@/lib/devices/manageengine/devices";
import { getDeviceRegisterData } from "@/lib/devices/service";

type RawRecord = Record<string, unknown>;

export class ManageEngineAppInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManageEngineAppInputError";
  }
}

export type ManageEngineApp = {
  /** What an install or a removal is aimed at. A React key too. */
  appId: string;
  name: string;
  /** The package name — `com.phoenix.app`. Shown because two apps can carry the same title. */
  identifier: string | null;
  version: string | null;
  releaseLabelId: string | null;
  releaseLabelName: string | null;
  /** True when the company repository holds this app, so Phoenix can send or remove it. */
  managed: boolean;
};

function pickString(record: RawRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function nested(record: RawRecord, key: string): RawRecord | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : null;
}

function appsArray(payload: RawRecord | null): RawRecord[] {
  if (!payload) return [];
  for (const key of ["apps", "app_details", "installed_apps", "mdm_apps"] as const) {
    const value = payload[key];
    if (Array.isArray(value)) return value as RawRecord[];
  }
  return [];
}

/**
 * One app record, from either the device list or the repository list — the two answer with the same
 * field names (`app_id`, `app_name`, `identifier`, `app_version`, nested `release_label_details`).
 */
function normalizeApp(record: RawRecord, managed: boolean): ManageEngineApp | null {
  const appId = pickString(record, ["app_id", "id"]);
  if (!appId) return null;
  const label = nested(record, "release_label_details");
  const labels = Array.isArray(record.release_label_details)
    ? ((record.release_label_details as RawRecord[])[0] ?? null)
    : label;
  const name = pickString(record, ["app_name", "name", "title"]);
  return {
    appId,
    identifier: pickString(record, ["identifier", "bundle_identifier", "package_name"]),
    managed,
    name: name ?? pickString(record, ["identifier", "package_name"]) ?? appId,
    releaseLabelId: labels ? pickString(labels, ["release_label_id", "id"]) : pickString(record, ["release_label_id"]),
    releaseLabelName: labels ? pickString(labels, ["release_label_name", "name"]) : null,
    version: pickString(record, ["app_version", "version", "app_version_code"]),
  };
}

/** Every app the company repository holds — what Phoenix is able to send to a tablet. */
export async function listManageEngineAppRepository(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineApp[]> {
  const payload = await callManageEngine<RawRecord>("/api/v1/mdm/apps", {}, fetchImpl, env);
  return appsArray(payload)
    .map((record) => normalizeApp(record, true))
    .filter((app): app is ManageEngineApp => app !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The biggest APK Phoenix will carry to ManageEngine. Well past any Phoenix build; a guard, not a limit. */
export const MAX_APP_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * ManageEngine's own enumerations, written out rather than left as bare numbers at the call site.
 *
 * 🔴 app_type is 0-INDEXED here, and getting it wrong costs a whole afternoon: the live tenant returns
 * `app_type: "0"` for its Free-Store apps, so the order is 0 Free Store · 1 Paid Store · 2 Enterprise —
 * NOT the 1-based reading the docs invite. An out-of-range `3` is not rejected with a clear message;
 * /api/v1/mdm/apps answers a bare `500 COM0004 Internal Server error`, which looks transient and is not
 * (measured live 2026-09-25: app_type 3 → 500, app_type 2 → 200 with the new app_id). platform_type is
 * a SEPARATE, 1-indexed enum (2 = Android, confirmed against the same live apps) — do not "align" them.
 */
const APP_TYPE_ENTERPRISE = 2;
const SUPPORTED_DEVICES_BOTH = 3;
// 🔴 platform_type is REQUIRED on create — /api/v1/mdm/apps answers `400 Invalid value for the
// parameter platform_type` without it (measured live 2026-09-25). 1 iOS · 2 Android · 3 Windows;
// the rep tablets are Android, and the artifact is an .apk, so this is always 2 here.
const PLATFORM_TYPE_ANDROID = 2;
/** The module the file is uploaded FOR. Without it the file lands with no purpose and the app create fails. */
const FILE_MODULE_APP_MGMT = "MDM_APP_MGMT";

export type UploadedApp = {
  app: ManageEngineApp | null;
  /** ManageEngine's id for the uploaded package, kept so a failed create can be chased in the console. */
  fileId: string;
  message: string;
};

export function manageEngineFileId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  // 🔴 /emsapi/files answers with an ARRAY of file records — `[{ "fileID": … }]`, confirmed live
  // 2026-09-25 — so the file id sits one level inside it, not on the top-level object. The deprecated
  // /api/v1/mdm/files answers with a bare object. Unwrap a single-file array before reading, or the
  // upload looks like it lost its id and the app is never created.
  const record = (Array.isArray(payload) ? payload[0] : payload) as RawRecord | undefined;
  if (!record || typeof record !== "object") return null;
  // The two upload endpoints answer with different spellings — `fileID` from /emsapi/files, `file_id`
  // from the deprecated one — so both are read rather than assuming which one served the call.
  return pickString(record, ["fileID", "file_id", "fileId", "id"]);
}

/**
 * Whether a failed upload means "this tenant does not serve that path" — the only case worth
 * retrying on the older endpoint. A refusal, a rejected token or a file ManageEngine would not take
 * is the real answer and must surface as itself rather than being asked again somewhere else.
 */
export function isMissingEndpointStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/**
 * An id ManageEngine sends back as a string is sent back to it as a number, which is how it types
 * them — EXCEPT when the id is too big for a JS number to hold exactly.
 *
 * 🔴 ManageEngine's own ids run to 18 digits, past JavaScript's safe-integer ceiling (2^53 ≈ 9e15).
 * `Number("243158000000134349")` is `243158000000134340` — the last digits are silently rounded off.
 * The create call then carries an `app_file` that points at no uploaded file, and ManageEngine
 * answers a bare `500 Internal Server error` with no hint that a rounded id is the cause (measured
 * live 2026-09-25: the exact string in a JSON field is accepted, the rounded number 500s). So an id
 * outside the safe range is kept as the exact string it arrived as; only a small id — a hand-set
 * release label, a test fixture — becomes a number.
 */
function asId(value: string): number | string {
  if (!/^\d+$/.test(value)) return value;
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value;
}

/**
 * Refuse a file that cannot become an app on a rep's tablet, before a byte is uploaded.
 *
 * The `.aab` case is called out by name because it is the mistake that will actually be made: the
 * Play Store build of this app is an `.aab`, it sits beside the APK in the same folder, and
 * ManageEngine would take it and hand every tablet something that cannot install.
 */
export function assertUploadableApk(fileName: string, byteLength: number): void {
  if (!fileName) throw new ManageEngineAppInputError("Choose the APK file to add.");
  if (!/\.apk$/i.test(fileName)) {
    throw new ManageEngineAppInputError(
      `Only an Android package can be added from here, and "${fileName}" is not one. The rep tablets are Android, so the file must end in .apk — an .aab is a Play Store upload and cannot be installed on a tablet.`,
    );
  }
  if (byteLength === 0) throw new ManageEngineAppInputError("That file is empty, so there is nothing to add.");
  if (byteLength > MAX_APP_UPLOAD_BYTES) {
    throw new ManageEngineAppInputError(
      `That file is ${Math.round(byteLength / (1024 * 1024))} MB, which is past the ${Math.round(MAX_APP_UPLOAD_BYTES / (1024 * 1024))} MB this page carries. Add it in the ManageEngine console instead.`,
    );
  }
}

/**
 * The body that creates the repository entry once the package is on the server.
 *
 * Enterprise, because a self-built APK is by definition not a store listing. Both device sizes, so a
 * phone-sized device in the fleet is not silently excluded. And `release_label_id` is DELIBERATELY
 * absent when no channel was chosen: ManageEngine's own documentation says an app with no label
 * "will be added in default stable channel", which is what is wanted — inventing a channel per
 * upload would scatter versions of one app across labels nobody chose.
 */
export function manageEngineAppCreateBody(input: {
  fileId: string;
  appName: string;
  appCategoryId: string;
  description?: string | null;
  releaseLabelId?: string | null;
}): Record<string, unknown> {
  const releaseLabelId = input.releaseLabelId?.trim() || null;
  return {
    app_file: asId(input.fileId),
    app_name: input.appName,
    app_type: APP_TYPE_ENTERPRISE,
    platform_type: PLATFORM_TYPE_ANDROID,
    supported_devices: SUPPORTED_DEVICES_BOTH,
    // 🔴 app_category_id is REQUIRED — a create without it answers 500 COM0004, not a clear
    // "missing field", so the caller resolves one before building this body (see
    // resolveManageEngineAppCategoryId). release_label_id stays absent unless a channel was chosen —
    // for a new enterprise app ManageEngine rejects it (IAM0018) and files the app in default stable.
    app_category_id: asId(input.appCategoryId),
    ...(releaseLabelId ? { release_label_id: asId(releaseLabelId) } : {}),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
  };
}

/**
 * Find a category id the create call will accept.
 *
 * 🔴 app_category_id is required on create, it is a PER-TENANT id, and the app list exposes only the
 * category NAME — the numeric id appears only on a single app's own detail. So a real id is read from
 * an app the repository already holds rather than hardcoded (a hardcoded id is wrong on every other
 * tenant and answers 400 COM0005). A workforce APK is business software, so a BUSINESS or PRODUCTIVITY
 * category is preferred when one exists; otherwise any existing category serves, because the category
 * is a grouping label in the repository, not a capability granted to the app.
 */
const PREFERRED_CATEGORY_NAMES = ["BUSINESS", "PRODUCTIVITY"];

export async function resolveManageEngineAppCategoryId(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const apps = appsArray(await callManageEngine<RawRecord>("/api/v1/mdm/apps", {}, fetchImpl, env));
  const byName = (name: string) =>
    apps.find((record) => (pickString(record, ["app_category_name"]) ?? "").toUpperCase() === name);
  const chosen = PREFERRED_CATEGORY_NAMES.map(byName).find(Boolean) ?? apps[0] ?? null;
  const appId = chosen ? pickString(chosen, ["app_id", "id"]) : null;
  if (!appId) {
    throw new ManageEngineRequestError(
      502,
      "The company app repository holds no existing app to read a category from, and ManageEngine requires one on every new app. Add the first app from the ManageEngine console, then upload from here.",
    );
  }
  const categoryId = pickString(await callManageEngine<RawRecord>(`/api/v1/mdm/apps/${appId}`, {}, fetchImpl, env), [
    "app_category_id",
  ]);
  if (!categoryId) {
    throw new ManageEngineRequestError(
      502,
      "ManageEngine returned no category id for an existing app, so a new app cannot be filed under the category its create call requires.",
    );
  }
  return categoryId;
}

/**
 * Put the package bytes on the ManageEngine server and get back the file id the app create needs.
 *
 * TWO ENDPOINTS, BECAUSE ONE OF THEM IS BEING RETIRED. `/emsapi/files` is the endpoint ManageEngine
 * now documents, and it takes a real multipart form whose part is named `fileName`. The older
 * `/api/v1/mdm/files` takes the raw bytes with the name in a `Content-Disposition` header, and is
 * marked deprecated — but the deprecation is dated against an On-Premises build, and this tenant is
 * Cloud, so which of the two a given tenant answers on cannot be known from the documentation. The
 * new one is tried first and the old one is the fallback, on exactly the statuses that mean "no such
 * endpoint here" — never on a refusal, which must surface as itself.
 */
async function uploadAppPackage(
  fileName: string,
  bytes: Uint8Array,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const form = new FormData();
  form.append("fileName", new Blob([bytes as BlobPart], { type: "application/vnd.android.package-archive" }), fileName);

  const headers: Record<string, string> = { module: FILE_MODULE_APP_MGMT };
  const customer = env.MANAGEENGINE_MDM_CUSTOMER_ID?.trim();
  if (customer) headers["X-Customer"] = customer;

  let payload: RawRecord | null = null;
  try {
    payload = await callManageEngine<RawRecord>("/emsapi/files", { body: form, headers, method: "POST" }, fetchImpl, env);
  } catch (error) {
    const status = error instanceof ManageEngineRequestError ? error.status : 0;
    if (!isMissingEndpointStatus(status)) throw error;
    payload = await callManageEngine<RawRecord>(
      "/api/v1/mdm/files",
      { body: bytes as BodyInit, headers: { "content-disposition": `filename=${fileName}` }, method: "POST" },
      fetchImpl,
      env,
    );
  }

  const fileId = manageEngineFileId(payload);
  if (!fileId) {
    throw new ManageEngineRequestError(
      502,
      "ManageEngine took the file but did not say which id it stored it under, so the app could not be created. Check the App Repository in the ManageEngine console before uploading it again.",
    );
  }
  return fileId;
}

/**
 * Add an APK to the company app repository, from Phoenix.
 *
 * 🔴 WHAT THIS CLOSES. Until this existed the repository could only be filled in the ManageEngine web
 * console, so the per-tablet Apps section had nothing to offer and said so — "the company app
 * repository could not be read, so there is nothing to send from here yet". This is the other half:
 * the APK goes in from here, and every tablet's Apps section can then send it.
 *
 * IT REACHES NO TABLET. Adding an app to the repository installs it on nobody — distribution is the
 * per-tablet Apps section, one tablet at a time, with its own audit row. That separation is
 * deliberate: an upload is a safe act, and it should not need the ceremony a wipe needs.
 *
 * TWO CALLS, AND THE FIRST CAN LAND WITHOUT THE SECOND. The package is uploaded, then the repository
 * entry is created from the file id. If the create fails the bytes are already on ManageEngine's
 * server under that id, so the id is returned with the error rather than dropped — otherwise the
 * only way to find an orphaned upload is to guess.
 */
export async function uploadManageEngineApp(
  input: {
    fileName: string;
    bytes: Uint8Array;
    appName?: string | null;
    description?: string | null;
    releaseLabelId?: string | null;
    appCategoryId?: string | null;
  },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UploadedApp> {
  const fileName = input.fileName.trim();
  assertUploadableApk(fileName, input.bytes.byteLength);

  const appName = input.appName?.trim() || fileName.replace(/\.apk$/i, "");
  // The category is resolved BEFORE the upload so a repository that cannot supply one fails fast,
  // rather than after a multi-megabyte package is already on the wire.
  const appCategoryId = input.appCategoryId?.trim() || (await resolveManageEngineAppCategoryId(fetchImpl, env));
  const fileId = await uploadAppPackage(fileName, input.bytes, fetchImpl, env);

  const created = await callManageEngine<RawRecord>(
    "/api/v1/mdm/apps",
    {
      body: JSON.stringify(
        manageEngineAppCreateBody({
          appCategoryId,
          appName,
          description: input.description,
          fileId,
          releaseLabelId: input.releaseLabelId,
        }),
      ),
      method: "POST",
    },
    fetchImpl,
    env,
  );

  const app = normalizeApp(created, true);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: app?.appId ?? fileId,
    entityType: "manageengine_app_repository",
    newValues: {
      appId: app?.appId ?? null,
      appName,
      bytes: input.bytes.byteLength,
      change: "UPLOAD",
      fileId,
      fileName,
      version: app?.version ?? null,
    },
    oldValues: null,
    summary: `Added ${appName} to the company app repository`,
  });

  return {
    app,
    fileId,
    message: `${appName} is in the company app repository. It is on no tablet yet — open a tablet below and send it from that tablet's Apps section.`,
  };
}

export type DeviceAppsState = {
  installed: ManageEngineApp[];
  /** Repository apps this tablet does not have — the ones worth offering to install. */
  available: ManageEngineApp[];
  /** The repository could not be read, so "managed" and the install list are unknown. */
  repositoryError: boolean;
};

/**
 * What is on the tablet, and what the company could put on it.
 *
 * An app is matched to the repository by package identifier first (the stable thing) and by app id
 * second, so the same app carrying different ids across the two lists is still recognised as one.
 */
export async function getManageEngineDeviceApps(
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeviceAppsState> {
  const payload = await callManageEngine<RawRecord>(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}/apps`,
    {},
    fetchImpl,
    env,
  );

  let repositoryError = false;
  const repository = await listManageEngineAppRepository(fetchImpl, env).catch(() => {
    repositoryError = true;
    return [] as ManageEngineApp[];
  });

  const sameApp = (left: ManageEngineApp, right: ManageEngineApp): boolean =>
    (left.identifier !== null && left.identifier === right.identifier) || left.appId === right.appId;

  const installed = appsArray(payload)
    .map((record) => normalizeApp(record, false))
    .filter((app): app is ManageEngineApp => app !== null)
    .map((app) => {
      const inRepository = repository.find((candidate) => sameApp(app, candidate));
      return inRepository
        ? {
            ...app,
            managed: true,
            releaseLabelId: app.releaseLabelId ?? inRepository.releaseLabelId,
            releaseLabelName: app.releaseLabelName ?? inRepository.releaseLabelName,
          }
        : app;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const available = repository.filter((candidate) => !installed.some((app) => sameApp(app, candidate)));

  return { available, installed, repositoryError };
}

type AppActionContext = { assetTag: string | null; deviceName: string };

/** Resolve the tablet from the live fleet, so an audit row names the real one and not an id. */
async function resolveDevice(
  deviceId: string,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<AppActionContext> {
  const [devices, register] = await Promise.all([
    listManageEngineDevices(fetchImpl, env),
    getDeviceRegisterData().catch(() => ({ devices: [] as Awaited<ReturnType<typeof getDeviceRegisterData>>["devices"] })),
  ]);
  const device = devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device) {
    throw new ManageEngineAppInputError(
      "That tablet is not in the ManageEngine fleet any more. Reload the page and try again from its row.",
    );
  }
  return {
    assetTag: matchManageEngineToRegister(device, register.devices)?.assetTag ?? null,
    deviceName: device.name,
  };
}

export type AppChangeResult = { message: string };

/**
 * Put an app on one tablet, silently, and record it.
 *
 * `appName` comes from the browser only so the audit summary and the confirmation read as words; the
 * app itself is identified to ManageEngine by id and release label, never by the name.
 */
export async function installManageEngineApp(
  input: { deviceId: string; appId: string; releaseLabelId?: string | null; appName?: string | null },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppChangeResult> {
  const deviceId = input.deviceId.trim();
  const appId = input.appId.trim();
  if (!deviceId) throw new ManageEngineAppInputError("Say which tablet to install on.");
  if (!appId) throw new ManageEngineAppInputError("Say which app to install.");

  const { assetTag, deviceName } = await resolveDevice(deviceId, fetchImpl, env);
  const releaseLabelId = input.releaseLabelId?.trim() || null;

  await callManageEngine(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}/apps`,
    {
      body: JSON.stringify({
        app_details: [releaseLabelId ? { app_id: appId, release_label_id: releaseLabelId } : { app_id: appId }],
        do_not_uninstall: false,
        invite_user: false,
        notify_user_via_email: false,
        silent_install: true,
      }),
      method: "POST",
    },
    fetchImpl,
    env,
  );

  const subject = assetTag ?? deviceName;
  const appLabel = input.appName?.trim() || "the app";
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: deviceId,
    entityType: "manageengine_device_app",
    newValues: { appId, appName: input.appName ?? null, assetTag, change: "INSTALL", deviceName },
    oldValues: null,
    summary: `Installed ${appLabel} on ${subject}`,
  });

  return { message: `${appLabel} is being installed on ${subject}. It appears once the tablet next reports in.` };
}

/** Take an app off one tablet, and record it. */
export async function removeManageEngineApp(
  input: { deviceId: string; appId: string; appName?: string | null },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppChangeResult> {
  const deviceId = input.deviceId.trim();
  const appId = input.appId.trim();
  if (!deviceId) throw new ManageEngineAppInputError("Say which tablet to remove from.");
  if (!appId) throw new ManageEngineAppInputError("Say which app to remove.");

  const { assetTag, deviceName } = await resolveDevice(deviceId, fetchImpl, env);

  await callManageEngine(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}/apps`,
    { body: JSON.stringify({ app_ids: [appId] }), method: "DELETE" },
    fetchImpl,
    env,
  );

  const subject = assetTag ?? deviceName;
  const appLabel = input.appName?.trim() || "the app";
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: deviceId,
    entityType: "manageengine_device_app",
    newValues: { appId, appName: input.appName ?? null, assetTag, change: "REMOVE", deviceName },
    oldValues: null,
    summary: `Removed ${appLabel} from ${subject}`,
  });

  return { message: `${appLabel} is being removed from ${subject}.` };
}

/**
 * Ask the tablet to report its app list again.
 *
 * A read of a read — it changes nothing on the tablet and writes no audit row, the same standing as
 * pressing Locate.
 */
export async function refreshManageEngineAppStatus(
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppChangeResult> {
  const trimmed = deviceId.trim();
  if (!trimmed) throw new ManageEngineAppInputError("Say which tablet to refresh.");
  await callManageEngine(
    `/api/v1/mdm/devices/${encodeURIComponent(trimmed)}/apps/refreshstatus`,
    { body: "{}", method: "POST" },
    fetchImpl,
    env,
  );
  return { message: "Asked the tablet for its app list. It updates once the tablet reports in." };
}
