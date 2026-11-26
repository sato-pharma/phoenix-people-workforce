/**
 * Keeping an app's Headwind version row level with the file it points at.
 *
 * 🔴 THE VERSION ROW IS THE TRIGGER, NOT THE FILE. A rep tablet's launcher compares what is installed
 * against the row's `versionCode`; it never looks at the bytes. So a row that disagrees with its own
 * file is a loop, not a cosmetic drift: the tablet downloads the file, installs a build whose code is
 * not the one the row asks for, finds itself still "wrong" at the next check-in and downloads it
 * again — for ever, at the file's full size. Measured on production 26 Nov 2026: row 10079 asked for
 * Telegram 13.1.0 / 72299 while `/files/Telegram.apk`, which it points at, had become 13.3.1 / 73469
 * (81,653,599 bytes) under it.
 *
 * 🔴 AND THE FILE NOW MOVES BY ITSELF. `phoenix-entrypoint.sh` re-fetches a floating app whenever its
 * publisher serves a different `content-length` (26 Nov 2026), so every tablet-server deploy can shift
 * a file under its row. That made "type the numbers out of the APK by hand" a step that has to run
 * after a deploy nobody watched — which is this function.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { type ApkBuild, readApkBuild } from "@/lib/devices/headwind/apk-build";
import { callHeadwind } from "@/lib/devices/headwind/client";
import type { HeadwindAuditWriter } from "@/lib/devices/headwind/configurations";

export class HeadwindVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindVersionError";
  }
}

export type VersionRowMatch = {
  /** The version row's own id — what the PUT keeps so the row is edited, never duplicated. */
  versionId: number;
  url: string;
  was: { version: string | null; versionCode: number | null };
  now: { version: string | null; versionCode: number | null };
  /** True when the row already agreed with its file and nothing was sent. */
  level: boolean;
};

const rows = (value: unknown, what: string): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) {
    throw new HeadwindVersionError(
      `The tablet server did not list ${what}, so nothing was read and no version row was changed. Try again in a minute.`,
    );
  }
  return value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** One app row as the server holds it, by id. */
export async function readHeadwindApplicationRow(
  applicationId: number,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const list = await callHeadwind<unknown>("/rest/private/applications/search", { method: "GET" }, fetchImpl, env);
  const found = rows(list, "the apps it holds").find((row) => row.id === applicationId) ?? null;
  if (!found) {
    throw new HeadwindVersionError(`The tablet server has no app numbered ${applicationId}, so nothing was changed.`);
  }
  return found;
}

/**
 * Read the APK each of an app's version rows points at, and put any row that disagrees with its own
 * file back in place with the file's real build.
 *
 * 🔴 THE PACKAGE NAME IS CHECKED FIRST. A row pointing at the wrong file is the one case where
 * writing the file's numbers would be actively wrong — it would hand the fleet another app under this
 * app's name — so a mismatch refuses and changes nothing.
 *
 * 🔴 THE ROW IS READ BACK. This endpoint has answered OK while storing nothing before (runbook, "A PUT
 * that reports success and changes nothing"), and a row believed level is exactly the state that
 * leaves the fleet in the loop.
 *
 * 🔴 `proveStored: false` IS FOR A CALLER WHOSE WRITES WERE ANSWERED AND NEVER SENT, AND NOTHING ELSE.
 * Only `scripts/owner-ops.ts`'s dry run passes it: there the PUT is answered by the dry-run fence, so
 * the read-back correctly finds the row unchanged and refuses — a refusal about a write nobody made,
 * which is the kind of false alarm that teaches a reader to ignore the real one. A caller that
 * actually sends the PUT must leave it alone; the default proves, and a missing read-back is reported
 * by the caller as a proof NOT done, never as a pass.
 */
export async function matchHeadwindVersionsToFiles(
  input: { applicationId: number; proveStored?: boolean },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: HeadwindAuditWriter = writeRequiredAuditLog,
  readBuild: (url: string) => Promise<ApkBuild> = (url) => readApkBuild(url, fetchImpl),
): Promise<{ changed: VersionRowMatch[]; level: VersionRowMatch[]; message: string; packageName: string | null }> {
  if (!Number.isInteger(input.applicationId)) {
    throw new HeadwindVersionError("Say which app's version rows to read.");
  }
  const app = await readHeadwindApplicationRow(input.applicationId, fetchImpl, env);
  const packageName = text(app.pkg);
  const label = text(app.name) ?? packageName ?? `app ${input.applicationId}`;

  const read = async () =>
    rows(
      await callHeadwind<unknown>(`/rest/private/applications/${input.applicationId}/versions`, { method: "GET" }, fetchImpl, env),
      `the download links of ${label}`,
    );

  const changed: VersionRowMatch[] = [];
  const level: VersionRowMatch[] = [];
  for (const row of await read()) {
    const versionId = count(row.id);
    const url = text(row.url);
    if (versionId === null || !url) continue;
    const build = await readBuild(url);
    if (packageName && build.packageName && build.packageName !== packageName) {
      throw new HeadwindVersionError(
        `${label}'s version ${versionId} points at ${url}, and that file is ${build.packageName}, not ${packageName}. ` +
          "Nothing was changed: writing that file's version here would hand the tablets a different app under this name.",
      );
    }
    if (build.version === null || build.versionCode === null) {
      throw new HeadwindVersionError(
        `${url} declares no version of its own, so there is nothing to put on ${label}'s version ${versionId}. Nothing was changed.`,
      );
    }
    const was = { version: text(row.version), versionCode: count(row.versionCode) };
    const now = { version: build.version, versionCode: build.versionCode };
    if (was.version === now.version && was.versionCode === now.versionCode) {
      level.push({ level: true, now, url, versionId, was });
      continue;
    }
    // 🔴 THE ROW GOES BACK WHOLE, WITH ITS `id`. A partial body is how a second version row appears
    // beside the old one, and then two rows claim the same app.
    await callHeadwind(
      "/rest/private/applications/versions",
      { body: JSON.stringify({ ...row, version: now.version, versionCode: now.versionCode }), method: "PUT" },
      fetchImpl,
      env,
    );
    changed.push({ level: false, now, url, versionId, was });
  }

  if (changed.length) {
    if (input.proveStored !== false) {
      const after = await read();
      for (const match of changed) {
        const stored = after.find((row) => count(row.id) === match.versionId) ?? null;
        if (!stored || text(stored.version) !== match.now.version || count(stored.versionCode) !== match.now.versionCode) {
          throw new HeadwindVersionError(
            `The tablet server took ${label}'s version ${match.versionId} and did NOT store ${match.now.version} / ` +
              `${match.now.versionCode}. The row still asks for a build its own file is not, so every tablet will keep ` +
              "re-downloading it. Read the app in the console.",
          );
        }
      }
    }

    // The app row carries its own copy of the pair, which is what the console shows. Moved only when
    // it was pointing at the build we just corrected, and only through a whole-row PUT.
    const newest = changed[changed.length - 1]!;
    if (count(app.versionCode) !== newest.now.versionCode) {
      await callHeadwind(
        "/rest/private/applications/android",
        { body: JSON.stringify({ ...app, version: newest.now.version, versionCode: newest.now.versionCode }), method: "PUT" },
        fetchImpl,
        env,
      );
    }

    await audit({
      actorLoginId: actor,
      entityId: packageName ?? String(input.applicationId),
      entityType: "headwind_configuration",
      newValues: { change: "version-row-matched-to-file", rows: changed },
      oldValues: { version: text(app.version), versionCode: count(app.versionCode) },
      summary: `Put ${label}'s version row${changed.length > 1 ? "s" : ""} level with the file${
        changed.length > 1 ? "s" : ""
      } it points at (${changed.map((match) => `${match.was.version ?? "?"} → ${match.now.version}`).join(", ")})`,
    });
  }

  return {
    changed,
    level,
    message: changed.length
      ? `${label}: ${changed
          .map((match) => `version ${match.versionId} now asks for ${match.now.version} / ${match.now.versionCode}`)
          .join("; ")}. Every tablet holding an older build installs it once at its next check-in, and then stops asking.`
      : `${label} already asks for exactly what its file is. Nothing was sent to any tablet.`,
    packageName,
  };
}
