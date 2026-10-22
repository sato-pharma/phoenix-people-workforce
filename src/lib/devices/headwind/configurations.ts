/**
 * The tablet CONFIGURATIONS on the company's own Headwind server — the rules a tablet follows.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Headwind has no "install this app" command and no "send this
 * file" command. An app is on a tablet because it is in that tablet's configuration; a file is on a
 * tablet because it is in that configuration's file list; the tablet's home screen looks the way it
 * does because of fields on the configuration. So almost everything that is not a one-off action goes
 * through this module.
 *
 * 🔴 THREE THINGS ABOUT WRITING A CONFIGURATION, ALL READ FROM `hmdm-server` SOURCE, ALL CAPABLE OF
 * LOSING DATA IF GUESSED AT.
 *
 * 1. **A PUT REPLACES THE LISTS.** `ConfigurationResource.updateConfiguration` deletes and re-inserts
 *    the configuration's `applications`, `applicationSettings` and `files`. Sending back an object you
 *    assembled yourself — rather than the one the server handed you — silently empties whichever list
 *    you left out. Every whole-object write here is therefore an OPAQUE ROUND-TRIP: read the server's
 *    own JSON, change exactly one field on it, put the same object back — WITH the app links read from
 *    their own endpoint, because the by-id read never carries them (`configurationWriteBody`).
 * 2. **A CONFIGURATION CARRIES A PLAINTEXT PASSWORD.** `Configuration.password` is the tablet's admin
 *    password in clear text — the Swagger annotation calling it an MD5 hash is wrong; the hash is
 *    computed at sync time from a plaintext column. The round-trip carries it through untouched, and
 *    nothing in this module ever logs, audits, returns or narrows a configuration object.
 * 3. **ATTACHING ONE APP OR ONE FILE DOES NOT NEED A PUT AT ALL.** There are surgical endpoints —
 *    `POST /rest/private/applications/configurations` and `POST /rest/private/web-ui-files/configurations`
 *    — that rewrite only the link rows. They are what Phases 3 and 4 use, so the common case never
 *    risks the round-trip above.
 *
 * WIRE FACTS THAT WOULD BE GUESSED WRONG. `kioskMode`, not `kiosk`. `mainAppId` is an INTEGER
 * application id, not a package name (`mainApp`, a package string, exists only on the device-facing
 * sync response and is derived server-side). `contentAppId`, not `contentAppPackage`. The on-screen
 * title is `desktopHeader` plus `desktopHeaderTemplate`; there is no `brandName`. An application link
 * installs with `action: 1`, hides with `0` and removes with `2` — the boolean `remove` beside it is
 * deprecated and overwritten server-side, so writing it does nothing.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { deviceRecordsFromSearch, deviceWriteBody } from "@/lib/devices/headwind/devices";

export class HeadwindConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindConfigurationError";
  }
}

/**
 * A configuration as the server hands it back.
 *
 * 🔴 IT IS DELIBERATELY AN OPEN RECORD. Narrowing it to the fields Phoenix knows about would mean
 * re-serialising only those fields on the way back, and the PUT above would then empty everything
 * else. The named fields are for reading; the index signature is what keeps the round-trip whole.
 */
export type HeadwindConfiguration = {
  id: number;
  name: string;
  description?: string | null;
  kioskMode?: boolean | null;
  mainAppId?: number | null;
  contentAppId?: number | null;
  desktopHeader?: string | null;
  desktopHeaderTemplate?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  backgroundImageUrl?: string | null;
  iconSize?: string | null;
  [field: string]: unknown;
};

/** What the console shows in a list — the facts, never the object. */
export type HeadwindConfigurationSummary = {
  id: number;
  name: string;
  description: string | null;
  kioskMode: boolean;
  deviceCount: number | null;
};

export type HeadwindConfigurationBranding = {
  desktopHeader: string | null;
  desktopHeaderTemplate: string | null;
  backgroundColor: string | null;
  textColor: string | null;
  backgroundImageUrl: string | null;
  iconSize: string | null;
  mainAppId: number | null;
  kioskMode: boolean;
};

/** The three sizes the agent's launcher understands. Anything else is ignored on the tablet. */
export const HEADWIND_ICON_SIZES = ["SMALL", "MEDIUM", "LARGE"] as const;
export type HeadwindIconSize = (typeof HEADWIND_ICON_SIZES)[number];

/**
 * What the title across the top of the company home screen SHOWS — Headwind's `DesktopHeader` enum,
 * read from its own source (hmdm-server, `persistence/domain/DesktopHeader.java`) on 2026-10-22.
 *
 * 🔴 IT IS NOT A POSITION. The console's field read "Where the title sits" with a placeholder of
 * "TOP", so the obvious entry wrote a value the server's enum cannot hold. The three `CUSTOM` kinds
 * print a device's custom fields, and `CUSTOM1` is where the remote screen ID lives, so they are
 * left out of what Phoenix offers rather than printing that number across a rep's screen.
 */
export const HEADWIND_DESKTOP_HEADERS = ["NO_HEADER", "DEVICE_ID", "DESCRIPTION", "TEMPLATE"] as const;
export type HeadwindDesktopHeader = (typeof HEADWIND_DESKTOP_HEADERS)[number];

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function configurationSummary(raw: HeadwindConfiguration): HeadwindConfigurationSummary {
  return {
    description: asText(raw.description),
    deviceCount: asCount(raw.devicesCount) ?? asCount(raw.deviceCount),
    id: raw.id,
    kioskMode: raw.kioskMode === true,
    name: asText(raw.name) ?? `Configuration ${raw.id}`,
  };
}

export function configurationBranding(raw: HeadwindConfiguration): HeadwindConfigurationBranding {
  return {
    backgroundColor: asText(raw.backgroundColor),
    backgroundImageUrl: asText(raw.backgroundImageUrl),
    desktopHeader: asText(raw.desktopHeader),
    desktopHeaderTemplate: asText(raw.desktopHeaderTemplate),
    iconSize: asText(raw.iconSize),
    kioskMode: raw.kioskMode === true,
    mainAppId: asCount(raw.mainAppId),
    textColor: asText(raw.textColor),
  };
}

/** Every configuration on the server, as facts for a list. */
export async function listHeadwindConfigurations(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ configurations: HeadwindConfigurationSummary[] }> {
  const raw = await callHeadwind<HeadwindConfiguration[]>(
    "/rest/private/configurations/search/",
    { method: "GET" },
    fetchImpl,
    env,
  );
  const configurations = Array.isArray(raw) ? raw.filter((entry) => typeof entry?.id === "number") : [];
  return { configurations: configurations.map(configurationSummary) };
}

/**
 * Read one configuration whole, exactly as the server holds it.
 *
 * 🔴 NOT FOR RETURNING TO A BROWSER. The object carries the tablet's plaintext admin password. This is
 * the read half of the round-trip, and its only callers are inside this module.
 */
async function readHeadwindConfiguration(
  configurationId: number,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<HeadwindConfiguration> {
  const raw = await callHeadwind<HeadwindConfiguration>(
    `/rest/private/configurations/${configurationId}`,
    { method: "GET" },
    fetchImpl,
    env,
  );
  if (!raw || typeof raw.id !== "number") {
    throw new HeadwindConfigurationError(
      "That set of tablet rules is not on the Headwind server any more. Reload the page and pick one from the list.",
    );
  }
  return raw;
}

/** The safe read for a browser: the branding fields and the facts, with nothing secret in them. */
export async function getHeadwindConfiguration(
  configurationId: number,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ configuration: HeadwindConfigurationSummary; branding: HeadwindConfigurationBranding }> {
  const raw = await readHeadwindConfiguration(configurationId, fetchImpl, env);
  return { branding: configurationBranding(raw), configuration: configurationSummary(raw) };
}

/** One file carried by a set of rules — never the whole configuration object it sits inside. */
export type HeadwindConfigurationFile = {
  /** The server-side file id — what a remove or a re-link is addressed to. Null reads as "cannot act on it". */
  fileId: number | null;
  /** What a person calls the file: its path on the tablet, else its description, else its stored name. */
  name: string;
  description: string | null;
  /** Where the file is downloaded from, only where the server gives a URL — never a guessed path. */
  url: string | null;
};

/**
 * The files a configuration pushes, projected to the four fields a browser may see.
 *
 * 🔴 THE FILE LIST IS ON THE BY-ID READ, THE APP LINKS ARE NOT (see `configurationWriteBody`).
 * `getConfigurationByIdFull` fills `files`, so the list comes straight off the read here — unlike the
 * app links, which need their own endpoint. Each entry is read from a candidate list of keys rather
 * than one pinned spelling, the same defensive reading the device blob gets, so a server upgrade that
 * renames a field blanks nothing silently. A file with no id and no name at all is dropped — there is
 * nothing a person could do with it and nothing to label it.
 */
export function configurationFiles(raw: HeadwindConfiguration): HeadwindConfigurationFile[] {
  const list = Array.isArray(raw.files) ? raw.files : [];
  const files: HeadwindConfigurationFile[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const fileId = asCount(record.fileId) ?? asCount(record.id);
    const name =
      asText(record.path) ??
      asText(record.description) ??
      asText(record.filePath) ??
      (fileId !== null ? `File ${fileId}` : null);
    if (!name) continue;
    files.push({
      // `externalUrl` is a boolean flag on some builds and a string URL on others; `asText` keeps only a string.
      description: asText(record.description),
      fileId,
      name,
      url: asText(record.url) ?? asText(record.externalUrl),
    });
  }
  return files;
}

/** The safe read for a browser: the files a set of rules pushes, with nothing secret in them. */
export async function getHeadwindConfigurationFiles(
  configurationId: number,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ configuration: HeadwindConfigurationSummary; files: HeadwindConfigurationFile[] }> {
  const raw = await readHeadwindConfiguration(configurationId, fetchImpl, env);
  return { configuration: configurationSummary(raw), files: configurationFiles(raw) };
}

/**
 * The body a whole-configuration PUT sends: the server's own object, the patch over it, and the app
 * links put back — the same body the Headwind console's own save sends.
 *
 * 🔴 THE BY-ID READ NEVER CARRIES THE APP LINKS (read from `hmdm-server` and on production,
 * 2026-10-22). `getConfigurationByIdFull` fills `applicationSettings`, `applicationUsageParameters` and
 * `files`, but `applications` always comes back `[]`; the links live behind
 * `GET /rest/private/configurations/applications/{id}`, and the PUT deletes every link and re-inserts
 * only the ones it is sent. A round-trip of the by-id read alone would therefore take EVERY app off
 * every tablet on those rules — and the server then re-checks `mainAppId` against the emptied list, so
 * the home-screen app goes with them. The console sends `allApplications.filter(app => app.action != 0)`;
 * so does this. `action` 0 is "not on this configuration", 1 is install, 2 is remove.
 */
export function configurationWriteBody(
  current: HeadwindConfiguration,
  links: unknown,
  patch: Record<string, unknown>,
): HeadwindConfiguration {
  if (!Array.isArray(links)) {
    throw new HeadwindConfigurationError(
      "The Headwind server did not say which apps are on those tablet rules, so nothing was changed — saving now would take every app off those tablets. Try again in a minute.",
    );
  }
  const applications = links.filter((link): link is Record<string, unknown> => {
    if (typeof link !== "object" || link === null) return false;
    const { action, id } = link as { action?: unknown; id?: unknown };
    return typeof id === "number" && action !== 0;
  });
  return { ...current, ...patch, applications };
}

/**
 * Change named fields on a configuration and put the whole object back.
 *
 * 🔴 THE ROUND-TRIP IS THE POINT. `patch` is spread over the object the SERVER just handed us, and
 * that object — not a reconstruction of it — is what goes back, so the settings and file lists the
 * PUT re-inserts are the ones that were already there. The app links come from their own read
 * (`configurationWriteBody`), because the by-id read never carries them.
 */
async function patchHeadwindConfiguration(
  configurationId: number,
  patch: Record<string, unknown>,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<HeadwindConfiguration> {
  const current = await readHeadwindConfiguration(configurationId, fetchImpl, env);
  const links = await callHeadwind<unknown>(
    `/rest/private/configurations/applications/${configurationId}`,
    { method: "GET" },
    fetchImpl,
    env,
  );
  const next = configurationWriteBody(current, links, patch);
  await callHeadwind(
    "/rest/private/configurations",
    { body: JSON.stringify(next), method: "PUT" },
    fetchImpl,
    env,
  );
  return next;
}

export type HeadwindBrandingInput = {
  configurationId: number;
  desktopHeader?: string | null;
  desktopHeaderTemplate?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  backgroundImageUrl?: string | null;
  iconSize?: string | null;
};

const COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * Phase 4 — write the look of the tablet's home screen.
 *
 * 🔴 WHAT THIS IS, SAID HONESTLY ON THE PAGE AS WELL AS HERE. It is a managed home screen, not a
 * sealed cage. `kioskMode` puts the agent's own launcher in front and the tablet shows only the apps
 * the configuration allows — but TRUE pinning (`startCosuKioskMode`) is a `ProUtils` stub in the free
 * agent, so a determined person can still reach Android's own settings. Saying "kiosk" and meaning
 * "locked down" is how a tablet gets handed out believing it is sealed when it is not.
 */
export async function setHeadwindBranding(
  input: HeadwindBrandingInput,
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ branding: HeadwindConfigurationBranding; message: string }> {
  if (!Number.isInteger(input.configurationId)) {
    throw new HeadwindConfigurationError("Say which set of tablet rules to change the look of.");
  }
  for (const [label, value] of [
    ["The background colour", input.backgroundColor],
    ["The text colour", input.textColor],
  ] as const) {
    if (value && !COLOUR.test(value)) {
      throw new HeadwindConfigurationError(`${label} has to be a six-digit hex colour like #0A527D.`);
    }
  }
  if (input.desktopHeader && !HEADWIND_DESKTOP_HEADERS.includes(input.desktopHeader as HeadwindDesktopHeader)) {
    throw new HeadwindConfigurationError(
      "Choose what the title shows: no title, the tablet's number, its description, or the title typed beside it.",
    );
  }
  if (input.iconSize && !HEADWIND_ICON_SIZES.includes(input.iconSize as HeadwindIconSize)) {
    throw new HeadwindConfigurationError(
      `The icon size has to be one of ${HEADWIND_ICON_SIZES.join(", ")} — the three the tablet's launcher understands.`,
    );
  }

  const patch: Record<string, unknown> = {};
  for (const field of [
    "backgroundColor",
    "backgroundImageUrl",
    "desktopHeader",
    "desktopHeaderTemplate",
    "iconSize",
    "textColor",
  ] as const) {
    // 🔴 `undefined` MEANS "LEAVE IT", `null` MEANS "CLEAR IT". Testing `field in input` instead would
    // read every key the caller merely mentioned — and a form that sends its whole shape with blanks
    // would then wipe the fields it was not editing.
    if (input[field] !== undefined) patch[field] = input[field] ?? null;
  }
  if (!Object.keys(patch).length) {
    throw new HeadwindConfigurationError("Nothing was changed, so nothing was sent to the tablets.");
  }

  const next = await patchHeadwindConfiguration(input.configurationId, patch, fetchImpl, env);
  const branding = configurationBranding(next);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(input.configurationId),
    entityType: "headwind_configuration",
    // 🔴 THE CHANGED FIELDS ONLY — never `next`, which carries the plaintext device password.
    newValues: { branding, change: "branding", name: asText(next.name) },
    oldValues: null,
    summary: `Changed the home-screen look of ${asText(next.name) ?? `configuration ${input.configurationId}`}`,
  });

  return {
    branding,
    message:
      `The home screen of ${asText(next.name) ?? `configuration ${input.configurationId}`} has been changed. ` +
      "Every tablet on that set of rules picks it up at its next check-in. This is a managed home " +
      "screen, not a sealed cage — the free agent's true pinning is not built, so Android's own " +
      "settings can still be reached by someone determined.",
  };
}

/**
 * Attach an app already on the server to a configuration, or take it off — WITHOUT rewriting the
 * configuration.
 *
 * `action` is the authoritative field: `1` installs, `0` hides the icon while leaving the app, `2`
 * removes it. The deprecated `remove` boolean beside it is overwritten server-side and is not sent.
 */
export async function linkHeadwindApp(
  input: { applicationId: number; configurationId: number; action: 0 | 1 | 2; showIcon?: boolean },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ message: string }> {
  if (!Number.isInteger(input.applicationId)) throw new HeadwindConfigurationError("Say which app.");
  if (!Number.isInteger(input.configurationId)) {
    throw new HeadwindConfigurationError("Say which set of tablet rules to put the app on.");
  }
  if (![0, 1, 2].includes(input.action)) {
    throw new HeadwindConfigurationError("An app is either installed, hidden or removed — nothing else.");
  }

  // 🔴 `showIcon` AND `remove` ARE REQUIRED IN EACH ENTRY, AND OMITTING THEM IS A 200 TOO. Headwind
  // dereferences both while building the link row, so a minimal entry throws a bare
  // `java.lang.NullPointerException` and the server answers `error.internal.server` under an HTTP
  // **200** — measured on production 2026-09-28 linking the Phoenix app to configuration 3, where the
  // same call succeeded the instant these two fields were added. `applicationId` inside the entry is
  // NOT enough on its own; it was tried and failed identically.
  //
  // 🔴 `showIcon` HERE IS THE LINK'S OWN, not the application's. The app row carries one as well and
  // they are separate rows in Headwind — this is whether the icon shows for tablets on THIS
  // configuration, which is why it travels with the link and defaults to the app's own setting.
  await callHeadwind(
    "/rest/private/applications/configurations",
    {
      body: JSON.stringify({
        applicationId: input.applicationId,
        configurations: [
          {
            action: input.action,
            applicationId: input.applicationId,
            configurationId: input.configurationId,
            remove: false,
            showIcon: input.showIcon !== false,
          },
        ],
      }),
      method: "POST",
    },
    fetchImpl,
    env,
  );

  const verb = input.action === 1 ? "installed on" : input.action === 2 ? "removed from" : "hidden on";
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(input.configurationId),
    entityType: "headwind_configuration",
    newValues: { action: input.action, applicationId: input.applicationId, change: "application" },
    oldValues: null,
    summary: `App ${input.applicationId} ${verb} configuration ${input.configurationId}`,
  });

  return {
    message:
      `The app is now ${verb} that set of rules. It reaches each tablet at its next check-in — there is ` +
      "no separate install command in Headwind; being in the rules is what installs it.",
  };
}

/** The same, for a file the tablets should hold. */
export async function linkHeadwindFile(
  input: { fileId: number; configurationId: number; remove?: boolean },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ message: string }> {
  if (!Number.isInteger(input.fileId)) throw new HeadwindConfigurationError("Say which file.");
  if (!Number.isInteger(input.configurationId)) {
    throw new HeadwindConfigurationError("Say which set of tablet rules to send the file to.");
  }

  await callHeadwind(
    "/rest/private/web-ui-files/configurations",
    {
      body: JSON.stringify({
        configurations: [{ configurationId: input.configurationId, remove: input.remove === true }],
        fileId: input.fileId,
      }),
      method: "POST",
    },
    fetchImpl,
    env,
  );

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(input.configurationId),
    entityType: "headwind_configuration",
    newValues: { change: "file", fileId: input.fileId, removed: input.remove === true },
    oldValues: null,
    summary: `File ${input.fileId} ${input.remove ? "taken off" : "sent to"} configuration ${input.configurationId}`,
  });

  return {
    message: input.remove
      ? "The file will be deleted from each tablet at its next check-in."
      : "The file will be on each tablet at its next check-in.",
  };
}

/**
 * Move one tablet onto a different set of rules.
 *
 * 🔴 AN OPAQUE ROUND-TRIP FOR THE SAME REASON AS A CONFIGURATION, PLUS ONE OF ITS OWN: a
 * `PUT /rest/private/devices` REPLACES the device's group list wholesale, so a hand-built body drops
 * every group the tablet was in. The server fires its own notification to the tablet when
 * `configurationId` changes, which is why nothing is pushed here afterwards.
 */
export async function moveHeadwindDeviceToConfiguration(
  input: { deviceNumber: string; configurationId: number },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ message: string }> {
  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindConfigurationError("Say which tablet to move.");
  if (!Number.isInteger(input.configurationId)) {
    throw new HeadwindConfigurationError("Say which set of rules to move the tablet onto.");
  }

  const found = await callHeadwind<unknown>(
    "/rest/private/devices/search",
    { body: JSON.stringify({ pageNum: 1, pageSize: 1000, value: deviceNumber }), method: "POST" },
    fetchImpl,
    env,
  );
  // 🔴 THE SAME UNWRAPPER AS THE FLEET, BECAUSE THE LIVE REPLY NESTS THE PAGE UNDER `devices` — see
  // `deviceRecordsFromSearch`. Reading `found.items` made this refuse EVERY move with "that tablet is
  // not in the Headwind fleet any more", which reads as a deleted device rather than an unread reply.
  const device = deviceRecordsFromSearch(found).find((entry) => entry.number === deviceNumber);
  if (!device) {
    throw new HeadwindConfigurationError(
      "That tablet is not in the Headwind fleet any more. Reload the page and try again from its row.",
    );
  }

  await callHeadwind(
    "/rest/private/devices",
    { body: JSON.stringify(deviceWriteBody(device, { configurationId: input.configurationId })), method: "PUT" },
    fetchImpl,
    env,
  );

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: deviceNumber,
    entityType: "headwind_configuration",
    newValues: { change: "device-configuration", configurationId: input.configurationId, deviceNumber },
    oldValues: { configurationId: asCount(device.configurationId) },
    summary: `Moved ${deviceNumber} onto configuration ${input.configurationId}`,
  });

  return {
    message:
      "That tablet is now on the new set of rules. The Headwind server tells the tablet itself, so it " +
      "does not wait for the next check-in.",
  };
}
