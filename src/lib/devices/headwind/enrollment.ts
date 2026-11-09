/**
 * Enrolling a rep tablet onto the company's own Headwind server — the QR a factory-fresh tablet scans.
 *
 * 🔴 PHOENIX CANNOT MINT THIS CODE, AND THE REASON IS NOT A MISSING ENDPOINT. The provisioning payload
 * pins the agent APK by its SIGNATURE CHECKSUM, and the APK is the one the Headwind box itself serves.
 * A payload Phoenix invented would carry either no checksum — which a factory-fresh tablet refuses —
 * or a checksum for a file it has never seen. So the owner copies each code out of the Headwind console
 * once, and Phoenix redraws it for every tablet from then on.
 *
 * 🔴 ONE CODE PER SET OF RULES, NEVER ONE FOR THE FLEET (9 Nov 2026). Each line has its own copy of
 * "Rep tablets" (docs/devices/headwind-rustdesk.md §8.17), and each copy has its own QR key in
 * Headwind: a tablet enrolled with another line's code lands on that line's rules and never gets its
 * own line app. So every saved code belongs to one configuration (`configuration_id`), is revealed and
 * audited for that configuration alone, and is refused when the configuration its payload names is a
 * different one. The single code saved before then (row id 1, no configuration) is still read: it is
 * attributed to the set of rules its own payload names, and never offered for scanning otherwise.
 *
 * 🔴 THE PAYLOAD IS A CREDENTIAL. Anyone who scans it puts a tablet into the company's fleet with the
 * agent as device owner. It lives in service-role-only rows; it is never logged, never included in the
 * ordinary read the page does on load, and never written into an audit row.
 * `revealHeadwindEnrollmentQr` is the one function that returns it, it writes the audit row for the
 * look before it does, and the page calls it only when a person asks to see the code.
 *
 * 🔴 A CODE IS CHECKED BEFORE IT IS SAVED AND AGAIN BEFORE IT IS SHOWN. Both its addresses must be
 * `https://`, it must not pin one device number for every tablet, and the agent download link must
 * answer 200 ITSELF — with redirects not followed, because a tablet does not follow one (§8.18), and a
 * first run that stalls on a download never sends the hardware report "Add to custody" needs.
 *
 * NOTHING IS ADDED TO THE PAYLOAD. The `com.hmdm.*` extras are the agent's own — `BASE_URL`,
 * `SERVER_PROJECT`, `DEVICE_ID`, `CONFIG`, `GROUP`, `SKIP_INTRO`, `OPEN_WIFI`. A key added to that
 * bundle is a key the agent did not expect, so Phoenix passes it through byte-for-byte and matches the
 * tablet to the custody register afterwards, by serial and IMEI.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { deviceActorNames, type DeviceActorNamer } from "@/lib/devices/actor-names";
import {
  listHeadwindConfigurations,
  type HeadwindConfigurationSummary,
} from "@/lib/devices/headwind/configurations";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TABLE = "headwind_enrollment_template";
const COLUMNS = "id, configuration_id, configuration_name, template_name, qr_payload, updated_by, updated_at";

/** Android's own provisioning keys. `PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME` is the load-bearing one. */
const COMPONENT_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME";
const DOWNLOAD_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION";
const CHECKSUM_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM";
const WIFI_SSID_KEY = "android.app.extra.PROVISIONING_WIFI_SSID";
const EXTRAS_KEY = "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE";

/** The agent's own keys inside the extras bundle, as the Headwind console writes them. */
const BASE_URL_KEY = "com.hmdm.BASE_URL";
const CONFIG_KEY = "com.hmdm.CONFIG";
const DEVICE_ID_KEY = "com.hmdm.DEVICE_ID";

/** The sets of rules a rep tablet can be enrolled onto are the copies of "Rep tablets" (§8.17). */
const REP_RULES_PREFIX = /^rep tablets/i;

/** How long the download-link check waits for the agent's host before it calls the link unreachable. */
export const AGENT_DOWNLOAD_CHECK_TIMEOUT_MS = 15_000;

/** Statuses a server answers when it will not take a HEAD — the check then asks for one byte instead. */
const HEAD_REFUSED = new Set([403, 405, 501]);

export class HeadwindEnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindEnrollmentError";
  }
}

/** What the page may show about a code WITHOUT showing the code. */
export type HeadwindEnrollmentSummary = {
  saved: boolean;
  templateName: string | null;
  /** The agent package the tablet will install, read out of the component name. */
  agentPackage: string | null;
  /** Where the agent is downloaded from — the host, never the full URL with its query. */
  downloadHost: string | null;
  /** …and the file's path on that host, so a wrong file is visible without revealing the code. */
  downloadPath: string | null;
  /** The Headwind server the tablet will report to — the host only. */
  serverHost: string | null;
  /** Which set of tablet rules the payload itself names, if it names one. */
  configurationName: string | null;
  /** 🔴 A code with no checksum is refused by a factory-fresh tablet. Worth saying on the page. */
  hasChecksum: boolean;
  joinsWifi: boolean;
  /** Why the saved code would be refused if it were pasted today — null when it would be accepted. */
  problem: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type HeadwindTemplateFacts = Omit<
  HeadwindEnrollmentSummary,
  "saved" | "templateName" | "problem" | "updatedAt" | "updatedBy"
>;

/** One set of rules and the code that enrolls a tablet onto it. */
export type HeadwindEnrollmentCard = {
  configurationId: number;
  configurationName: string;
  /** False when a code was saved for a set of rules that is no longer on the tablet server. */
  onServer: boolean;
  /** True when the code shown is the single pre-9-Nov code, attributed by the rules its payload names. */
  legacy: boolean;
  summary: HeadwindEnrollmentSummary;
};

export type HeadwindEnrollmentState = {
  cards: HeadwindEnrollmentCard[];
  /**
   * The pre-9-Nov code when its payload names no set of rules on the server. Shown so it is not lost
   * from sight, never offered for scanning: nobody can say which rules a tablet would land on.
   */
  unassigned: HeadwindEnrollmentSummary | null;
};

export type HeadwindRevealedCode = {
  payload: string;
  templateName: string | null;
  configurationName: string;
};

/** A stored code, as the table holds it. */
export type HeadwindEnrollmentRow = {
  id: number;
  configuration_id: number | null;
  configuration_name: string | null;
  template_name: string | null;
  qr_payload: string;
  updated_by: string;
  updated_at: string;
};

const EMPTY_FACTS: HeadwindTemplateFacts = {
  agentPackage: null,
  configurationName: null,
  downloadHost: null,
  downloadPath: null,
  hasChecksum: false,
  joinsWifi: false,
  serverHost: null,
};

const UNSAVED_SUMMARY: HeadwindEnrollmentSummary = {
  ...EMPTY_FACTS,
  problem: null,
  saved: false,
  templateName: null,
  updatedAt: null,
  updatedBy: null,
};

function urlOf(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function hostOf(value: unknown): string | null {
  return urlOf(value)?.host || null;
}

/** The path only — a query string can carry a token, and it is never shown or audited. */
function pathOf(value: unknown): string | null {
  const url = urlOf(value);
  return url && url.host ? url.pathname || "/" : null;
}

function isHttps(value: unknown): boolean {
  return urlOf(value)?.protocol === "https:";
}

/** `com.hmdm.launcher/.AdminReceiver` → `com.hmdm.launcher`. */
function packageOf(component: unknown): string | null {
  if (typeof component !== "string") return null;
  return component.split("/")[0]?.trim() || null;
}

function extrasOf(record: Record<string, unknown>): Record<string, unknown> {
  const bundle = record[EXTRAS_KEY];
  return bundle && typeof bundle === "object" && !Array.isArray(bundle)
    ? (bundle as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** What a payload says about itself, without judging it. */
function factsOf(record: Record<string, unknown>): HeadwindTemplateFacts {
  const extras = extrasOf(record);
  return {
    agentPackage: packageOf(record[COMPONENT_KEY]),
    configurationName: textOf(extras[CONFIG_KEY]),
    downloadHost: hostOf(record[DOWNLOAD_KEY]),
    downloadPath: pathOf(record[DOWNLOAD_KEY]),
    hasChecksum: typeof record[CHECKSUM_KEY] === "string" && record[CHECKSUM_KEY].trim().length > 0,
    joinsWifi: typeof record[WIFI_SSID_KEY] === "string" && record[WIFI_SSID_KEY].trim().length > 0,
    serverHost: hostOf(extras[BASE_URL_KEY]),
  };
}

function recordOf(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A device number is "carried" when it has a value; an empty one claims nothing. */
function carriesDeviceNumber(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return String(value).trim().length > 0;
}

/**
 * Read what a person pasted, and refuse it in words if it is not a Headwind provisioning payload a
 * factory-fresh tablet can actually finish enrolling with.
 *
 * `expected.configurationName` is the set of rules the code is being saved for: when the payload names
 * a configuration, it must be that one.
 *
 * Returns the payload RE-SERIALISED — same keys, same values, normalised whitespace — so what is
 * stored is known-parseable JSON rather than whatever the clipboard carried. The extras bundle inside
 * is copied through untouched.
 */
export function parseHeadwindEnrollmentTemplate(
  raw: string,
  expected: { configurationName?: string | null } = {},
): {
  payload: string;
  facts: HeadwindTemplateFacts;
  /** The agent download link itself, for the reachability check — never shown, never audited. */
  downloadUrl: string;
} {
  const text = raw.trim();
  if (!text) {
    throw new HeadwindEnrollmentError("Paste the enrollment code from the Headwind console.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HeadwindEnrollmentError(
      "That is not the enrollment code. Copy the whole JSON text Headwind shows under the QR, starting with { and ending with }.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HeadwindEnrollmentError("The enrollment code must be a single JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const component = record[COMPONENT_KEY];
  if (typeof component !== "string" || !component.includes("/")) {
    throw new HeadwindEnrollmentError(
      `This code has no ${COMPONENT_KEY}, so no tablet would know what to install. It is not an Android provisioning QR.`,
    );
  }
  if (typeof record[DOWNLOAD_KEY] !== "string" || !hostOf(record[DOWNLOAD_KEY])) {
    throw new HeadwindEnrollmentError(
      "This code names no download location for the Headwind agent, so a factory-fresh tablet would have nothing to fetch.",
    );
  }

  const extras = extrasOf(record);
  if (!hostOf(extras[BASE_URL_KEY])) {
    throw new HeadwindEnrollmentError(
      `This code carries no ${BASE_URL_KEY}, so an enrolled tablet would not know which server to report to. ` +
        "That is a ManageEngine or Google code, not a Headwind one.",
    );
  }

  const facts = factsOf(record);
  // 🔴 PLAIN http IS A REDIRECT, AND A TABLET DOES NOT FOLLOW ONE (§8.18). The tablet server answers
  // http with a 301 to https; the agent counts that as a failed download, and a status report sent to
  // an http address is redirected into a bodyless GET and lost.
  if (!isHttps(record[DOWNLOAD_KEY])) {
    throw new HeadwindEnrollmentError(
      `The agent download link in this code (${facts.downloadHost}${facts.downloadPath ?? ""}) is not https://. ` +
        "The tablet server answers a plain http link with a redirect, and a tablet does not follow a redirect, " +
        "so it would never fetch the agent. Copy the code again from the Headwind console; if it still says " +
        "http://, the server's own address has to be made https first.",
    );
  }
  if (!isHttps(extras[BASE_URL_KEY])) {
    throw new HeadwindEnrollmentError(
      `The server address in this code (${facts.serverHost}) is not https://. Every report a tablet sends to a ` +
        "plain http address is redirected and lost, so it would enrol and then never be heard from. Copy the " +
        "code again from the Headwind console once the server's own address is https.",
    );
  }
  // 🔴 A FIXED DEVICE NUMBER MAKES EVERY TABLET THE SAME TABLET. Headwind puts one in only when the QR
  // is made for a single device; every tablet that scanned this code would claim that number and
  // overwrite the others on the server.
  if (carriesDeviceNumber(extras[DEVICE_ID_KEY])) {
    throw new HeadwindEnrollmentError(
      `This code was made for one device number (${DEVICE_ID_KEY}), so every tablet that scans it would claim ` +
        "that same number and they would overwrite each other on the server. In the Headwind console, open the " +
        "set of rules and copy its QR without a device number.",
    );
  }
  const wanted = textOf(expected.configurationName);
  if (wanted && facts.configurationName && facts.configurationName !== wanted) {
    throw new HeadwindEnrollmentError(
      `This code is for "${facts.configurationName}", not "${wanted}". A tablet enrolled with it would land on ` +
        `"${facts.configurationName}" and never get the apps of "${wanted}". Open "${wanted}" in the Headwind ` +
        "console and copy its own QR.",
    );
  }

  return { downloadUrl: String(record[DOWNLOAD_KEY]).trim(), facts, payload: JSON.stringify(record) };
}

/** Why a stored code would be refused today, in the refusal's own words — or null if it would pass. */
function problemWith(payload: string, configurationName: string): string | null {
  try {
    parseHeadwindEnrollmentTemplate(payload, { configurationName });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "The saved code can no longer be read.";
  }
}

/** The link as a person reads it: host and path, never the query. */
function linkLabel(url: string): string {
  const parsed = urlOf(url);
  return parsed ? `${parsed.host}${parsed.pathname}` : "the download link";
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `it did not answer within ${AGENT_DOWNLOAD_CHECK_TIMEOUT_MS / 1000} seconds`;
  }
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (cause && typeof cause.code === "string") return cause.code;
  return error instanceof Error && error.message ? error.message : "the request failed";
}

/**
 * 🔴 THE AGENT DOWNLOAD LINK MUST ANSWER 200 ITSELF. A tablet does not follow a redirect (§8.18) and a
 * dead link stalls the first run before the hardware report (§8.16), so a link is accepted only when a
 * HEAD with redirects NOT followed answers exactly 200. A host that will not take a HEAD is asked for
 * its first byte instead, where 206 (or a 200 that ignored the range) is the same answer.
 */
export async function checkHeadwindAgentDownload(url: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const where = linkLabel(url);
  let status: number;
  try {
    const head = await fetchImpl(url, {
      cache: "no-store",
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(AGENT_DOWNLOAD_CHECK_TIMEOUT_MS),
    });
    status = head.status;
    if (HEAD_REFUSED.has(status)) {
      const ranged = await fetchImpl(url, {
        cache: "no-store",
        headers: { range: "bytes=0-0" },
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(AGENT_DOWNLOAD_CHECK_TIMEOUT_MS),
      });
      await ranged.body?.cancel().catch(() => undefined);
      status = ranged.status === 206 ? 200 : ranged.status;
    }
  } catch (error) {
    throw new HeadwindEnrollmentError(
      `The agent download link (${where}) could not be reached from Phoenix: ${reasonOf(error)}. ` +
        "A tablet scanning this code would stall on the same download, so it has not been accepted. Check the " +
        "tablet server is up and try again.",
    );
  }
  if (status === 200) return;
  if (status >= 300 && status < 400) {
    throw new HeadwindEnrollmentError(
      `The agent download link (${where}) answers ${status}, a redirect. A tablet does not follow a redirect, ` +
        "so it would never fetch the agent. The link in the code must answer by itself: copy the code again " +
        "from the Headwind console once the server's address is https.",
    );
  }
  throw new HeadwindEnrollmentError(
    `The agent download link (${where}) answers ${status} instead of the file. A tablet scanning this code would ` +
      "stall on that download and never finish enrolling. Put the agent file back on the tablet server, then try again.",
  );
}

/** A configuration id from a browser: a positive whole number, or a sentence saying what is missing. */
export function enrollmentConfigurationId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HeadwindEnrollmentError("Choose which set of tablet rules this code is for.");
  }
  return id;
}

/** The row a set of rules enrolls with: its own, or the pre-9-Nov one when that names these rules. */
export function pickEnrollmentRow(
  configuration: { id: number; name: string },
  rows: readonly HeadwindEnrollmentRow[],
): { row: HeadwindEnrollmentRow; legacy: boolean } | null {
  const own = rows.find((row) => row.configuration_id === configuration.id);
  if (own) return { legacy: false, row: own };
  const old = rows.find((row) => row.configuration_id === null);
  if (!old) return null;
  const record = recordOf(old.qr_payload);
  const names = record ? factsOf(record).configurationName : null;
  return names !== null && names === configuration.name.trim() ? { legacy: true, row: old } : null;
}

type PlannedCard = Omit<HeadwindEnrollmentCard, "summary"> & { row: HeadwindEnrollmentRow | null };

/**
 * Which cards the page shows, and which stored code each one carries. Pure, so it is tested whole.
 *
 * A card for every copy of "Rep tablets" on the server, for every other set of rules a code was saved
 * for, and for a saved code whose rules are gone (so it is not silently forgotten). The pre-9-Nov code
 * goes on the card of the rules its payload names when that card has no code of its own; otherwise,
 * if it names no rules on the server, it is returned as `unassigned`.
 */
export function planHeadwindEnrollmentCards(
  configurations: readonly { id: number; name: string }[],
  rows: readonly HeadwindEnrollmentRow[],
): { cards: PlannedCard[]; unassigned: HeadwindEnrollmentRow | null } {
  const savedFor = new Set(rows.map((row) => row.configuration_id).filter((id): id is number => id !== null));
  const cards: PlannedCard[] = [];
  let legacyPlaced = false;

  for (const configuration of configurations) {
    const picked = pickEnrollmentRow(configuration, rows);
    const wanted = REP_RULES_PREFIX.test(configuration.name.trim()) || savedFor.has(configuration.id) || picked !== null;
    if (!wanted) continue;
    if (picked?.legacy) legacyPlaced = true;
    cards.push({
      configurationId: configuration.id,
      configurationName: configuration.name,
      legacy: picked?.legacy ?? false,
      onServer: true,
      row: picked?.row ?? null,
    });
  }

  const onServer = new Set(configurations.map((configuration) => configuration.id));
  for (const row of rows) {
    if (row.configuration_id === null || onServer.has(row.configuration_id)) continue;
    cards.push({
      configurationId: row.configuration_id,
      configurationName: row.configuration_name ?? "A set of rules no longer on the tablet server",
      legacy: false,
      onServer: false,
      row,
    });
  }
  cards.sort((a, b) => a.configurationId - b.configurationId);

  const old = rows.find((row) => row.configuration_id === null) ?? null;
  const oldRecord = old ? recordOf(old.qr_payload) : null;
  const oldNames = oldRecord ? factsOf(oldRecord).configurationName : null;
  // Superseded when the rules it names already have their own code; unassigned only when it names none.
  const namesRulesOnServer = oldNames !== null && configurations.some((configuration) => configuration.name.trim() === oldNames);
  const unassigned = old && !legacyPlaced && !namesRulesOnServer ? old : null;
  return { cards, unassigned };
}

async function readRows(): Promise<HeadwindEnrollmentRow[]> {
  const { data, error } = await getSupabaseAdmin().from(TABLE).select(COLUMNS).order("id", { ascending: true });
  if (error) throw new Error(`The saved Headwind enrollment codes could not be read: ${error.message}`);
  return (data as HeadwindEnrollmentRow[] | null) ?? [];
}

/** The sets of rules on the server. A failed read throws — it is never an empty list of rules. */
async function readConfigurations(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<HeadwindConfigurationSummary[]> {
  return (await listHeadwindConfigurations(fetchImpl, env)).configurations;
}

async function findConfiguration(
  configurationId: number,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<HeadwindConfigurationSummary> {
  const found = (await readConfigurations(fetchImpl, env)).find((entry) => entry.id === configurationId);
  if (!found) {
    throw new HeadwindEnrollmentError(
      "That set of tablet rules is not on the tablet server any more. Reload the page and pick one from the list.",
    );
  }
  return found;
}

function summaryOf(
  row: HeadwindEnrollmentRow,
  problem: string | null,
  name: DeviceActorNamer,
): HeadwindEnrollmentSummary {
  const record = recordOf(row.qr_payload);
  return {
    ...(record ? factsOf(record) : EMPTY_FACTS),
    problem,
    saved: true,
    templateName: row.template_name,
    updatedAt: row.updated_at,
    // A name, never the HR id the row was saved under — see `deviceActorNames`.
    updatedBy: name(row.updated_by),
  };
}

/**
 * What the page loads: every set of rules a rep tablet can be enrolled onto, and everything about each
 * one's code except the code. A failed read of the rules or of the codes throws: it is never shown as
 * "no code saved", which would invite pasting over a code that is there.
 */
export async function getHeadwindEnrollmentState(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindEnrollmentState> {
  const [rows, configurations] = await Promise.all([readRows(), readConfigurations(fetchImpl, env)]);
  const { cards, unassigned } = planHeadwindEnrollmentCards(configurations, rows);
  const namer = await deviceActorNames(rows.map((row) => row.updated_by));

  return {
    cards: cards.map(({ row, ...card }) => ({
      ...card,
      summary: row
        ? summaryOf(
            row,
            // A saved code that would be refused today is still shown — the row is the only copy, and the
            // fix is a fresh paste — but the page says why, instead of offering a code a tablet cannot use.
            card.onServer
              ? problemWith(row.qr_payload, card.configurationName)
              : "This set of rules is no longer on the tablet server, so no tablet can be enrolled onto it.",
            namer,
          )
        : UNSAVED_SUMMARY,
    })),
    unassigned: unassigned
      ? summaryOf(
          unassigned,
          "This code was saved before each line had its own rules, and it does not name a set of rules on the " +
            "tablet server, so nobody can say where a tablet would land. It is not offered for scanning: paste each " +
            "line's own code on its card.",
          namer,
        )
      : null,
  };
}

/**
 * Save the enrollment code for one set of rules, replacing that set's earlier one.
 *
 * The audit row records the set of rules, the code's NAME, the agent package, the download host and
 * path, the server host and whether it replaced an earlier one — never the payload, which is the
 * credential this whole module is careful with.
 */
export async function saveHeadwindEnrollmentTemplate(
  input: { raw: string; templateName?: string | null; configurationId: number },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindEnrollmentCard> {
  const configuration = await findConfiguration(input.configurationId, fetchImpl, env);
  const { payload, facts, downloadUrl } = parseHeadwindEnrollmentTemplate(input.raw, {
    configurationName: configuration.name,
  });
  await checkHeadwindAgentDownload(downloadUrl, fetchImpl);

  const templateName = input.templateName?.trim() || null;
  // The saver's name depends only on `actor`, so it is read beside the save rather than after it; it
  // never rejects (`deviceActorNames` swallows a failed lookup).
  const namer = deviceActorNames([actor]);
  const previous = (await readRows()).find((row) => row.configuration_id === configuration.id) ?? null;
  const updatedAt = new Date().toISOString();

  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(
      {
        configuration_id: configuration.id,
        configuration_name: configuration.name,
        qr_payload: payload,
        template_name: templateName,
        updated_at: updatedAt,
        updated_by: actor,
      },
      { onConflict: "configuration_id" },
    );
  if (error) throw new Error(`The Headwind enrollment code could not be saved: ${error.message}`);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: `headwind-enrollment-template:${configuration.id}`,
    entityType: "headwind_enrollment",
    newValues: {
      agentPackage: facts.agentPackage,
      configurationId: configuration.id,
      configurationName: configuration.name,
      downloadHost: facts.downloadHost,
      downloadPath: facts.downloadPath,
      hasChecksum: facts.hasChecksum,
      serverHost: facts.serverHost,
      templateName,
    },
    oldValues: previous
      ? { templateName: previous.template_name, updatedAt: previous.updated_at, updatedBy: previous.updated_by }
      : null,
    summary: `${previous ? "Replaced" : "Saved"} the Headwind enrollment code for ${configuration.name}${
      templateName ? ` (${templateName})` : ""
    }`,
  });

  return {
    configurationId: configuration.id,
    configurationName: configuration.name,
    legacy: false,
    onServer: true,
    summary: {
      ...facts,
      problem: null,
      saved: true,
      templateName,
      updatedAt,
      updatedBy: (await namer)(actor),
    },
  };
}

/**
 * Someone asked to see one set of rules' code. The code is checked again first — the download link can
 * have died since it was saved — and the looking is itself worth a row, written BEFORE the code is
 * handed back.
 *
 * 🔴 Everything that calls this is handing a credential to a browser. It is called from the route
 * behind `company_devices:approve`, on an explicit request, and the page drops it on "Hide".
 */
export async function revealHeadwindEnrollmentQr(
  configurationId: number,
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindRevealedCode> {
  const configuration = await findConfiguration(configurationId, fetchImpl, env);
  const picked = pickEnrollmentRow(configuration, await readRows());
  if (!picked) {
    throw new HeadwindEnrollmentError(
      `No enrollment code is saved for ${configuration.name} yet. Paste its code from the Headwind console first.`,
    );
  }
  let checked: { downloadUrl: string };
  try {
    checked = parseHeadwindEnrollmentTemplate(picked.row.qr_payload, { configurationName: configuration.name });
  } catch (error) {
    throw new HeadwindEnrollmentError(
      `The saved code for ${configuration.name} cannot be used as it is: ${
        error instanceof Error ? error.message : "it can no longer be read."
      } Paste it again from the Headwind console.`,
    );
  }
  await checkHeadwindAgentDownload(checked.downloadUrl, fetchImpl);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: `headwind-enrollment-template:${configuration.id}`,
    entityType: "headwind_enrollment",
    // 🔴 THE FACT OF THE LOOK, NEVER THE PAYLOAD.
    newValues: {
      configurationId: configuration.id,
      configurationName: configuration.name,
      legacy: picked.legacy,
      revealed: true,
      templateName: picked.row.template_name,
    },
    oldValues: null,
    summary: `Displayed the Headwind enrollment code for ${configuration.name}`,
  });
  return {
    configurationName: configuration.name,
    payload: picked.row.qr_payload,
    templateName: picked.row.template_name,
  };
}
