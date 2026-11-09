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
 * installs with `action: 1` and removes with `2`. 🔴 THERE IS NO "HIDE" ACTION: `0` means "not on these
 * rules", and sent with a link's `id` it DELETES the link (runbook §8.15) — while the agent reads only
 * `remove` and would still install an app linked with 0 (§8.14). Hiding an app is installing it with
 * the link's `showIcon: false`. The boolean `remove` is overwritten server-side from `action`.
 *
 * 🔴 THE REP TABLETS FOLLOW SEVERAL SETS OF RULES, NOT ONE. "Rep tablets" and each line's copy of it
 * ("Rep tablets — Anti Infective", "Rep tablets — Pedia", runbook §8.17) are found by that name prefix
 * (`REP_RULES_PREFIX`), never by a hard-coded id, and a change meant for every rep tablet is made on
 * each of them (`resolveHeadwindRules(..., "rep")`).
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind, HeadwindRequestError } from "@/lib/devices/headwind/client";
import { deviceWriteBody, searchHeadwindDevices } from "@/lib/devices/headwind/devices";

/** Writes a REQUIRED audit row. A parameter only so a test can watch the rows without a database. */
export type HeadwindAuditWriter = (input: Parameters<typeof writeRequiredAuditLog>[0]) => Promise<void>;

/**
 * The name every rep set of rules starts with — "Rep tablets" itself and each line's copy of it.
 * 🔴 Found by name, never by id: the ids (3, 4, 5 on 9 Nov 2026) are the server's, and CNS gets the
 * next copy the day a CNS rep holds a tablet.
 */
export const REP_RULES_PREFIX = "Rep tablets";

/** Which sets of rules a write reaches: named ones, or `"rep"` — every rep set of rules. */
export type HeadwindRulesTarget = readonly number[] | "rep";

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

/**
 * Every value the enum can HOLD — what the server accepts back. The `CUSTOM` kinds are not offered,
 * but a set of rules may already carry one from the Headwind console, and the branding form sends its
 * whole shape: refusing them would refuse every save of those rules over a title nobody changed.
 */
export const HEADWIND_DESKTOP_HEADER_VALUES: readonly string[] = [
  ...HEADWIND_DESKTOP_HEADERS,
  "CUSTOM1",
  "CUSTOM2",
  "CUSTOM3",
];

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
  // 🔴 A REPLY THAT IS NOT A LIST IS NOT "NO SETS OF RULES". Read as `[]`, the page said "the server
  // holds no sets of rules yet" and the push script said there was no configuration 3 — about a server
  // that holds several, whose answer simply was not read.
  if (!Array.isArray(raw)) {
    throw new HeadwindRequestError(
      502,
      "The company tablet server answered the list of tablet rules in a shape Phoenix cannot read, so Phoenix stopped rather than reading it as no rules at all. Try again in a minute; if it keeps happening, the server was probably upgraded.",
    );
  }
  const configurations = raw.filter((entry) => typeof entry?.id === "number");
  return { configurations: configurations.map(configurationSummary) };
}

/** True for "Rep tablets" and every line's copy of it. */
export function isRepRules(configuration: { name: string }): boolean {
  return configuration.name.startsWith(REP_RULES_PREFIX);
}

/**
 * The sets of rules a write is aimed at, named, read from the live server BEFORE anything is sent — so
 * an upload never leaves its bytes on the server aimed at rules that turn out not to exist.
 */
export async function resolveHeadwindRules(
  target: HeadwindRulesTarget,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindConfigurationSummary[]> {
  const { configurations } = await listHeadwindConfigurations(fetchImpl, env);
  if (target === "rep") {
    const rep = configurations.filter(isRepRules);
    if (!rep.length) {
      throw new HeadwindConfigurationError(
        `The tablet server holds no set of rules whose name starts "${REP_RULES_PREFIX}", so nothing was sent to any rep tablet.`,
      );
    }
    return rep;
  }
  if (!target.length || !target.every((id) => Number.isInteger(id))) {
    throw new HeadwindConfigurationError("Say which set of tablet rules to use.");
  }
  const picked: HeadwindConfigurationSummary[] = [];
  for (const id of new Set(target)) {
    const found = configurations.find((entry) => entry.id === id);
    if (!found) {
      throw new HeadwindConfigurationError(
        `One of the sets of tablet rules named is not on the tablet server, so nothing was sent. It holds: ${
          configurations.map((entry) => entry.name).join(", ") || "no sets of rules"
        }.`,
      );
    }
    picked.push(found);
  }
  return picked;
}

/**
 * Every app the server knows, each with what THIS set of rules does with it — the list the console's
 * own app tab reads (`action` 1 install, 2 remove, 0 not on these rules; `url`, `showIcon`, `name`,
 * `pkg`, `version` of the version the rules hand out).
 *
 * 🔴 A REPLY THAT IS NOT A LIST REFUSES, because every caller decides something from it: a save would
 * send it back (`configurationWriteBody`), a link check would read it as "no links to check", and a
 * removal would read it as "not on the rules".
 */
export async function readHeadwindConfigurationApplications(
  configurationId: number,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<Record<string, unknown>>> {
  const links = await callHeadwind<unknown>(
    `/rest/private/configurations/applications/${configurationId}`,
    { method: "GET" },
    fetchImpl,
    env,
  );
  if (!Array.isArray(links)) {
    throw new HeadwindConfigurationError(
      "The Headwind server did not say which apps are on those tablet rules, so nothing was checked or changed. Try again in a minute.",
    );
  }
  return links.filter((link): link is Record<string, unknown> => typeof link === "object" && link !== null);
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
  if (input.desktopHeader && !HEADWIND_DESKTOP_HEADER_VALUES.includes(input.desktopHeader)) {
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

/** One entry of `POST /rest/private/applications/configurations` — a link row to write. */
export type HeadwindAppLinkEntry = {
  id?: number;
  action: 0 | 1 | 2;
  applicationId: number;
  configurationId: number;
  remove: false;
  showIcon: boolean;
};

/**
 * The entries that put ONE app on ONE configuration, given the app's links as the server holds them.
 *
 * 🔴 AN ENTRY WITH NO `id` IS A NEW LINK ROW, EVEN WHEN THE APP IS ALREADY ON THOSE RULES. Headwind
 * inserts it beside the old one, so the configuration then carries the app twice with two different
 * actions. Measured on production 2026-10-23: setting Telegram, WPS Office and WhatsApp to install on
 * "Rep tablets" left each with its old remove link (1002, 1003, 1004) AND a new install link (1012,
 * 1013, 1014). So the existing link's `id` is sent and the row is updated in place; when the pair
 * already carries more than one link, the lowest id is kept and every other one is sent with
 * `action: 0`, which is how this endpoint deletes a link. Only a pair with no link at all goes without
 * an id. `links` is the `data` of `GET /rest/private/applications/configurations/{applicationId}`.
 */
export function applicationLinkEntries(
  input: { applicationId: number; configurationId: number; action: 0 | 1 | 2; showIcon?: boolean },
  links: unknown,
): HeadwindAppLinkEntry[] {
  if (!Array.isArray(links)) {
    throw new HeadwindConfigurationError(
      "The Headwind server did not say which tablet rules this app is already on, so nothing was changed — sending it now could put the app on those rules twice. Try again in a minute.",
    );
  }
  const existing = links
    .filter((link): link is { id: number } => {
      if (typeof link !== "object" || link === null) return false;
      const { configurationId, id } = link as { configurationId?: unknown; id?: unknown };
      return Number.isInteger(id) && configurationId === input.configurationId;
    })
    .map((link) => link.id)
    .sort((a, b) => a - b);

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
  const entry: HeadwindAppLinkEntry = {
    action: input.action,
    applicationId: input.applicationId,
    configurationId: input.configurationId,
    remove: false,
    showIcon: input.showIcon !== false,
  };
  const [kept, ...duplicates] = existing;
  if (kept === undefined) return [entry];
  return [
    { ...entry, id: kept },
    ...duplicates.map((id) => ({ ...entry, action: 0 as const, id })),
  ];
}

/**
 * Read the app's links, then write the one for this configuration — updating the link that is
 * already there rather than adding a second (`applicationLinkEntries`). Returns the link id that was
 * updated (null for a new link) and the duplicate link ids that were deleted.
 */
export async function writeHeadwindAppLink(
  input: { applicationId: number; configurationId: number; action: 0 | 1 | 2; showIcon?: boolean },
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ linkId: number | null; removedDuplicateIds: number[] }> {
  const links = await callHeadwind<unknown>(
    `/rest/private/applications/configurations/${input.applicationId}`,
    { method: "GET" },
    fetchImpl,
    env,
  );
  const configurations = applicationLinkEntries(input, links);
  await callHeadwind(
    "/rest/private/applications/configurations",
    {
      body: JSON.stringify({ applicationId: input.applicationId, configurations }),
      method: "POST",
    },
    fetchImpl,
    env,
  );
  const [first, ...rest] = configurations;
  return {
    linkId: first.id ?? null,
    removedDuplicateIds: rest.map((entry) => entry.id as number),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * Install links — what a tablet actually downloads.
 * ───────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * What one install link answered, in the terms a tablet experiences it.
 *
 * 🔴 A TABLET WILL NOT FOLLOW A REDIRECT, AND ONE DEAD LINK STOPS ITS WHOLE UPDATE RUN AT THAT APP
 * (runbook §8.16, §8.18). So only `ok` — `https://`, answering 200 itself — is a working link; a 301 is
 * as dead to the tablet as a 404, and the launcher listed after it never arrives.
 */
export type HeadwindInstallLinkVerdict =
  | "ok"
  | "redirect"
  | "missing"
  | "server-error"
  | "not-https"
  | "refused"
  | "unreachable"
  | "no-link";

const INSTALL_LINK_LABELS: Record<HeadwindInstallLinkVerdict, string> = {
  "missing": "Missing — the file is not there",
  "no-link": "No download link — the server gives none for an app these rules install",
  "not-https": "Not https — a tablet will not follow the redirect to https",
  "ok": "OK",
  "redirect": "Redirects — a tablet will not follow it",
  "refused": "Refused by the file server",
  "server-error": "Server error on the file server",
  "unreachable": "Could not be reached",
};

export function installLinkLabel(verdict: HeadwindInstallLinkVerdict): string {
  return INSTALL_LINK_LABELS[verdict];
}

/** How long one link is given to answer — the tablet's own downloader is not more patient. */
export const INSTALL_LINK_TIMEOUT_MS = 20_000;

export type HeadwindInstallLinkProbe = {
  status: number | null;
  verdict: HeadwindInstallLinkVerdict;
  redirectsTo: string | null;
};

function verdictForStatus(status: number): HeadwindInstallLinkVerdict {
  if (status === 200) return "ok";
  if (status >= 300 && status < 400) return "redirect";
  if (status === 404 || status === 410) return "missing";
  if (status >= 500) return "server-error";
  return "refused";
}

/**
 * Ask one install link what a tablet would be told — WITHOUT following a redirect.
 *
 * 🔴 `redirect: "manual"` IS THE WHOLE CHECK. The check before 9 Nov 2026 followed redirects and called
 * the http links healthy because the https page behind the 301 answered 200 (§8.18). A server that
 * refuses HEAD (405 or 501) is asked again with a one-byte ranged GET, where 206 is the same proof
 * that the file is there. No credential goes with it: the tablet sends none either.
 */
export async function probeInstallLink(url: string, fetchImpl: typeof fetch = fetch): Promise<HeadwindInstallLinkProbe> {
  if (!url.startsWith("https://")) return { redirectsTo: null, status: null, verdict: "not-https" };
  try {
    let response = await fetchImpl(url, {
      cache: "no-store",
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(INSTALL_LINK_TIMEOUT_MS),
    });
    let ranged = false;
    if (response.status === 405 || response.status === 501) {
      response = await fetchImpl(url, {
        cache: "no-store",
        headers: { range: "bytes=0-0" },
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(INSTALL_LINK_TIMEOUT_MS),
      });
      ranged = true;
      await response.body?.cancel().catch(() => undefined);
    }
    const status = response.type === "opaqueredirect" ? 0 : response.status;
    const verdict = response.type === "opaqueredirect" ? "redirect" : ranged && status === 206 ? "ok" : verdictForStatus(status);
    const location = response.headers?.get?.("location") ?? null;
    return { redirectsTo: verdict === "redirect" ? location : null, status, verdict };
  } catch {
    return { redirectsTo: null, status: null, verdict: "unreachable" };
  }
}

/** The three places a version keeps a download link: the plain APK and the two split architectures. */
const LINK_FIELDS = ["url", "urlArmeabi", "urlArm64"] as const;

function linksOf(record: Record<string, unknown>): string[] {
  const links: string[] = [];
  for (const field of LINK_FIELDS) {
    const value = asText(record[field]);
    if (value && !links.includes(value)) links.push(value);
  }
  return links;
}

/**
 * True for an app these rules INSTALL from a download — `action` 1, an Android app (not a web link or
 * an intent, which the agent never downloads), not a system app already on the tablet.
 */
function installsFromDownload(app: Record<string, unknown>): boolean {
  if (app.action !== 1) return false;
  const type = asText(app.type)?.toLowerCase();
  if (type && type !== "app") return false;
  return app.system !== true;
}

function appName(app: Record<string, unknown>): string {
  return asText(app.name) ?? asText(app.pkg) ?? "An app with no name";
}

export type HeadwindInstallLink = {
  applicationId: number | null;
  name: string;
  version: string | null;
  /** Null only for an installed app the server gives no link for — which is itself the fault. */
  url: string | null;
  status: number | null;
  verdict: HeadwindInstallLinkVerdict;
  label: string;
  redirectsTo: string | null;
};

export type HeadwindInstallLinkReport = {
  configurationId: number;
  name: string;
  links: HeadwindInstallLink[];
  broken: number;
};

/** Every install link of one app as these rules hand it out, each probed (one probe per distinct URL). */
async function probeAppLinks(
  app: Record<string, unknown>,
  probe: (url: string) => Promise<HeadwindInstallLinkProbe>,
  fallbackLinks: string[] = [],
): Promise<HeadwindInstallLink[]> {
  const own = linksOf(app);
  const urls = own.length ? own : fallbackLinks;
  const base = { applicationId: asCount(app.id), name: appName(app), version: asText(app.version) };
  if (!urls.length) {
    return [{ ...base, label: installLinkLabel("no-link"), redirectsTo: null, status: null, url: null, verdict: "no-link" }];
  }
  return Promise.all(
    urls.map(async (url) => {
      const result = await probe(url);
      return { ...base, ...result, label: installLinkLabel(result.verdict), url };
    }),
  );
}

/**
 * Check every install link on these sets of rules the way a tablet meets it — named by id, or `"rep"`
 * for every rep set of rules.
 *
 * For each set: its app list (`readHeadwindConfigurationApplications`), the apps it installs from a
 * download, and each of their links probed with redirects NOT followed (`probeInstallLink`). A link
 * shared by several sets is asked once. The broken links come first, so a page reading it top-down
 * sees the one that stops the run before the ten that work.
 */
export async function checkHeadwindInstallLinks(
  configurationIds: HeadwindRulesTarget,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ checkedAt: string; configurations: HeadwindInstallLinkReport[] }> {
  const rules = await resolveHeadwindRules(configurationIds, fetchImpl, env);
  const asked = new Map<string, Promise<HeadwindInstallLinkProbe>>();
  const probe = (url: string) => {
    let pending = asked.get(url);
    if (!pending) {
      pending = probeInstallLink(url, fetchImpl);
      asked.set(url, pending);
    }
    return pending;
  };

  const configurations: HeadwindInstallLinkReport[] = [];
  for (const set of rules) {
    const apps = await readHeadwindConfigurationApplications(set.id, fetchImpl, env);
    const links = (await Promise.all(apps.filter(installsFromDownload).map((app) => probeAppLinks(app, probe)))).flat();
    links.sort((left, right) => {
      const broken = Number(right.verdict !== "ok") - Number(left.verdict !== "ok");
      return broken || left.name.localeCompare(right.name);
    });
    configurations.push({
      broken: links.filter((link) => link.verdict !== "ok").length,
      configurationId: set.id,
      links,
      name: set.name,
    });
  }
  return { checkedAt: new Date().toISOString(), configurations };
}

/** One sentence per broken link — what is wrong with it, said so a person can fix it. */
function brokenLinkSentence(link: HeadwindInstallLink): string {
  if (!link.url) return link.label;
  const status = link.status !== null && link.status !== 0 ? ` (HTTP ${link.status})` : "";
  const target = link.redirectsTo ? `, to ${link.redirectsTo}` : "";
  return `${link.url}: ${link.label}${status}${target}`;
}

/**
 * The download link a tablet can actually follow.
 *
 * 🔴 THE SERVER WRITES AN UPLOADED APP'S LINK AS `http://`, AND A TABLET WILL NOT FOLLOW THE REDIRECT.
 * Headwind builds the link from its own base address, which is plain http behind Railway's TLS, so a
 * fresh upload is registered as `http://mdm.satopharma.com/files/<name>`. That address answers 301 to
 * https, and the agent treats the 301 as a failed download ("Bad server response … 301"). One dead link
 * stops the tablet's whole update run, so every app listed after it — the launcher included — never
 * arrives. Measured on production, 9 Nov 2026: both line apps were registered on http, PHX-TAB-0007
 * stopped at the Pedia app on every check-in and stayed on launcher 6.39, which sends no location.
 * The https twin is the same file on the same server.
 */
export function tabletFollowableUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith("http://")) return null;
  return `https://${url.slice("http://".length)}`;
}

/** The version the tablets get: the highest version code, else the newest row. */
function latestVersionOf(versions: Array<Record<string, unknown>>): Record<string, unknown> | null {
  let latest: Record<string, unknown> | null = null;
  for (const version of versions) {
    if (!latest) {
      latest = version;
      continue;
    }
    const code = asCount(version.versionCode);
    const best = asCount(latest.versionCode);
    if (code !== null && best !== null ? code > best : (asCount(version.id) ?? 0) > (asCount(latest.id) ?? 0)) {
      latest = version;
    }
  }
  return latest;
}

/**
 * Move an app's download links onto `https://` — and REFUSE while the one the tablets get is not.
 *
 * Each version row whose link is `http://` is put back whole with only the link changed (its id kept,
 * so the server edits the row in place — never a second version), and only once its https twin has
 * answered 200 on its own: a link is never rewritten to one that is dead.
 *
 * 🔴 IT USED TO BE ABLE TO DO NOTHING AND REPORT SUCCESS. A version read that was not a list became
 * `[]`, and the server has before answered a link PUT with OK while keeping the http value (RustDesk's
 * `urlArm64`, 26 Sep 2026, runbook "A PUT that reports success and changes nothing"). So a non-list
 * read refuses, every changed row is read BACK, and the caller is refused while the newest version or
 * any row just changed still carries a link that is not https.
 */
export async function secureHeadwindVersionLinks(
  applicationId: number,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ changed: number; latest: Record<string, unknown> | null }> {
  const read = async () => {
    const versions = await callHeadwind<unknown>(
      `/rest/private/applications/${applicationId}/versions`,
      { method: "GET" },
      fetchImpl,
      env,
    );
    if (!Array.isArray(versions)) {
      throw new HeadwindConfigurationError(
        "The Headwind server did not list this app's download links, so Phoenix could not check they are https and put the app on no tablet rules. Try again in a minute.",
      );
    }
    return versions.filter((version): version is Record<string, unknown> => typeof version === "object" && version !== null);
  };

  const versions = await read();
  const changed = new Set<unknown>();
  const leftAsItWas = new Map<string, HeadwindInstallLinkProbe>();
  for (const version of versions) {
    const patch: Record<string, string> = {};
    for (const field of LINK_FIELDS) {
      const twin = tabletFollowableUrl(version[field]);
      if (!twin) continue;
      const answer = await probeInstallLink(twin, fetchImpl);
      if (answer.verdict === "ok") patch[field] = twin;
      else leftAsItWas.set(String(version[field]), answer);
    }
    if (!Object.keys(patch).length) continue;
    await callHeadwind(
      "/rest/private/applications/versions",
      { body: JSON.stringify({ ...version, ...patch }), method: "PUT" },
      fetchImpl,
      env,
    );
    changed.add(version.id);
  }

  const final = changed.size ? await read() : versions;
  const latest = latestVersionOf(final);
  for (const version of final) {
    if (version !== latest && !changed.has(version.id)) continue;
    for (const link of linksOf(version)) {
      if (link.startsWith("https://")) continue;
      const twin = leftAsItWas.get(link);
      throw new HeadwindConfigurationError(
        twin
          ? `The app's download link ${link} is not https, and its https twin answered "${installLinkLabel(twin.verdict)}"${
              twin.status ? ` (HTTP ${twin.status})` : ""
            }, so the link was left as it was and the app was put on no tablet rules — a tablet will not follow the redirect from http. Put the file on the tablet server's own disk and try again.`
          : `The app's download link ${link} is still not https after Phoenix asked the server to change it, so the app was put on no tablet rules — a tablet will not follow the redirect from http. Change the link in the Headwind console, then try again.`,
      );
    }
  }
  return { changed: changed.size, latest };
}

/** 1 installs, 2 removes; 0 is refused with the reason (see `linkHeadwindApp`); nothing else exists. */
function assertLinkAction(action: unknown): asserts action is 1 | 2 {
  if (action === 0) {
    throw new HeadwindConfigurationError(
      "Hiding an app is installing it with its icon off — the old hide sent a code that deletes the app's link from the rules, and the tablet still installs it. Choose hide, which does it properly, or remove.",
    );
  }
  if (action !== 1 && action !== 2) {
    throw new HeadwindConfigurationError("An app is either installed, hidden or removed — nothing else.");
  }
}

/**
 * Attach an app already on the server to a configuration, or take it off — WITHOUT rewriting the
 * configuration.
 *
 * `action` 1 installs and 2 removes. `showIcon: false` with 1 is HIDING: the app is installed and its
 * icon left off the tablet's screen.
 *
 * 🔴 0 IS REFUSED, BECAUSE IT DOES NOT HIDE. Sent with the existing link's id, 0 deletes the link
 * (§8.15) — and a new link sent with 0 still installs, because the agent reads only `remove` (§8.14).
 * This function used to send it and audit and answer "hidden".
 *
 * 🔴 AN INSTALL IS REFUSED WHILE ITS DOWNLOAD LINK WOULD STOP A TABLET. Before the link is written, the
 * app's version links are moved onto https (`secureHeadwindVersionLinks`) and the links these rules
 * would hand out are probed with redirects not followed; anything but "OK" refuses the write. A dead
 * link put on the rules stops every tablet's update run at that app, and the launcher after it with it.
 */
export async function linkHeadwindApp(
  input: { applicationId: number; configurationId: number; action: 0 | 1 | 2; showIcon?: boolean },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: HeadwindAuditWriter = writeRequiredAuditLog,
): Promise<{ message: string; applicationName: string; configurationName: string }> {
  if (!Number.isInteger(input.applicationId)) throw new HeadwindConfigurationError("Say which app.");
  if (!Number.isInteger(input.configurationId)) {
    throw new HeadwindConfigurationError("Say which set of tablet rules to put the app on.");
  }
  assertLinkAction(input.action);

  const configurationName = asText((await readHeadwindConfiguration(input.configurationId, fetchImpl, env)).name) ??
    "a set of tablet rules with no name";
  const findApp = async () => {
    const apps = await readHeadwindConfigurationApplications(input.configurationId, fetchImpl, env);
    const found = apps.find((entry) => entry.id === input.applicationId);
    if (!found) {
      throw new HeadwindConfigurationError(
        "That app is not in the tablet server's app list any more, so nothing was changed. Reload the page and pick it again.",
      );
    }
    return found;
  };
  let app = await findApp();
  const applicationName = appName(app);

  // A system app, a web link or an intent is not downloaded, so it has no install link to check.
  if (input.action === 1 && installsFromDownload({ ...app, action: 1 })) {
    const secured = await secureHeadwindVersionLinks(input.applicationId, fetchImpl, env);
    // The list read above still carries the links as they were before any of them moved to https.
    if (secured.changed) app = await findApp();
    const links = await probeAppLinks(app, (url) => probeInstallLink(url, fetchImpl), secured.latest ? linksOf(secured.latest) : []);
    const broken = links.filter((link) => link.verdict !== "ok");
    if (broken.length) {
      throw new HeadwindConfigurationError(
        `${applicationName} was not put on ${configurationName}: ${broken.map(brokenLinkSentence).join("; ")}. ` +
          "A tablet that meets a dead link stops its whole update run there, so nothing after it — the launcher included — would arrive. Fix the link first.",
      );
    }
  }

  const { linkId, removedDuplicateIds } = await writeHeadwindAppLink(input, fetchImpl, env);

  const hidden = input.action === 1 && input.showIcon === false;
  const verb = input.action === 2 ? "removed from" : hidden ? "installed, with its icon hidden, on" : "installed on";
  await audit({
    actorLoginId: actor,
    entityId: String(input.configurationId),
    entityType: "headwind_configuration",
    newValues: {
      action: input.action,
      applicationId: input.applicationId,
      applicationName,
      change: "application",
      configurationName,
      linkId,
      removedDuplicateLinkIds: removedDuplicateIds,
      showIcon: input.showIcon !== false,
    },
    oldValues: { action: asCount(app.action), showIcon: typeof app.showIcon === "boolean" ? app.showIcon : null },
    summary: `${applicationName} ${verb} ${configurationName}`,
  });

  return {
    applicationName,
    configurationName,
    message:
      `${applicationName} is now ${verb} ${configurationName}. It reaches each tablet at its next check-in — there is ` +
      "no separate install command in Headwind; being in the rules is what installs it.",
  };
}

/**
 * Do one thing on each set of rules in turn, and say plainly which ones it reached.
 *
 * 🔴 A HALF-DONE SPREAD IS NEVER REPORTED AS DONE. Each set gets its own write and its own audit row;
 * if one fails, the others are still tried, and the caller is refused with the names it reached and
 * the ones it did not, each with its reason.
 */
export async function applyToEachRules(
  rules: readonly HeadwindConfigurationSummary[],
  act: (set: HeadwindConfigurationSummary) => Promise<unknown>,
  what: string,
): Promise<string[]> {
  const reached: string[] = [];
  const missed: string[] = [];
  for (const set of rules) {
    try {
      await act(set);
      reached.push(set.name);
    } catch (error) {
      missed.push(`${set.name} (${error instanceof Error ? error.message : "it failed"})`);
    }
  }
  if (missed.length) {
    throw new HeadwindConfigurationError(
      `${what}: done on ${reached.length ? reached.join(", ") : "no set of rules"}; NOT done on ${missed.join("; ")}. Fix that and send it again to the ones it missed.`,
    );
  }
  return reached;
}

/**
 * Link one app on several sets of rules — `"rep"` meaning every rep set (`REP_RULES_PREFIX`) — with
 * one write and one audit row per set.
 */
export async function linkHeadwindAppToRules(
  input: { applicationId: number; target: HeadwindRulesTarget; action: 0 | 1 | 2; showIcon?: boolean },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: HeadwindAuditWriter = writeRequiredAuditLog,
): Promise<{ message: string; configurations: string[] }> {
  if (!Number.isInteger(input.applicationId)) throw new HeadwindConfigurationError("Say which app.");
  assertLinkAction(input.action);
  const rules = await resolveHeadwindRules(input.target, fetchImpl, env);
  let applicationName = "The app";
  const configurations = await applyToEachRules(
    rules,
    async (set) => {
      const done = await linkHeadwindApp(
        { action: input.action, applicationId: input.applicationId, configurationId: set.id, showIcon: input.showIcon },
        actor,
        fetchImpl,
        env,
        audit,
      );
      applicationName = done.applicationName;
    },
    "The change",
  );
  return {
    configurations,
    message:
      `${applicationName} is now ${input.action === 2 ? "removed from" : "installed on"} ${configurations.join(", ")}. ` +
      "Each tablet on those rules picks it up at its next check-in.",
  };
}

/** The same, for a file the tablets should hold. */
export async function linkHeadwindFile(
  input: { fileId: number; configurationId: number; remove?: boolean },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: HeadwindAuditWriter = writeRequiredAuditLog,
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

  await audit({
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

  // 🔴 THE SAME SEARCH AS THE FLEET, BECAUSE THE LIVE REPLY NESTS THE PAGE UNDER `devices` — see
  // `deviceRecordsFromSearch`, which `searchHeadwindDevices` reads every page through. Reading
  // `found.items` made this refuse EVERY move with "that tablet is not in the Headwind fleet any more",
  // which reads as a deleted device rather than an unread reply.
  const { records } = await searchHeadwindDevices(deviceNumber, fetchImpl, env);
  const device = records.find((entry) => entry.number === deviceNumber);
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
