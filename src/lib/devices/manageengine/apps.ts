/**
 * The apps on a rep's tablet — what is installed, what the company can send it, and the two changes
 * a Super Admin can make from Phoenix: put an app on, take an app off.
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
import { callManageEngine } from "@/lib/devices/manageengine/client";
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
