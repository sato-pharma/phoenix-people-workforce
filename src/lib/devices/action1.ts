/**
 * Action1 → the device custody register.
 *
 * WHAT THIS AUTOMATES, AND WHAT IT DELIBERATELY REFUSES TO. Action1 already knows every machine
 * that has its agent on it, down to the BIOS serial — which is the one field the custody receipt
 * exists to carry, and the one a person copying it off the underside of a laptop gets wrong. So
 * the REGISTRATION half is automated here: pull the fleet, map each endpoint onto an import row,
 * and hand it to the same pipeline the spreadsheet import uses.
 *
 * The HANDOVER half is not, and must not be. `heldBy` on every row this file produces is null, on
 * purpose. A custody record is what an employee signs for under البند (1)'s «قبلتها بحالتها», and
 * Action1's idea of who holds a machine is the account that last logged into it — a helpdesk
 * session, a shared login, somebody covering a desk. Opening a custody record from that would put
 * a name on a signed instrument that nobody put there, and البند (10) prices what that name owes.
 * The register lands the device in stock; a person then issues it, and that press is the act the
 * receipt records. `neverAssignsCustody` in the test pins this.
 *
 * NOTHING HERE OVERWRITES AN EXISTING ROW. The import preview already refuses a serial, an IMEI or
 * an asset tag the register holds, so a device that is registered comes back as a reported skip.
 * That is what makes this safe to run again on Tuesday: the sync is add-only by construction, not
 * by a flag somebody has to remember. A machine whose details CHANGED in Action1 is corrected by
 * hand in the register, where the change is audited against a person.
 *
 * ON THE FIELD NAMES BELOW. Action1's published documentation gives the auth flow and the paths but
 * does not list the JSON keys an endpoint record carries, and this was written without live
 * credentials to read them from. So every field is resolved through a CANDIDATE LIST against a
 * flattened, punctuation-insensitive view of the record rather than against one guessed spelling —
 * `serial_number`, `serialNumber` and a nested `hardware.serial` all answer the same question. The
 * dry run returns the keys it actually saw (`action1KeySample`), so the first real pull shows what
 * Action1 sends instead of leaving a blank column looking like a device with no serial. When that
 * pull happens, pin the real spellings at the top of each list — do not remove the others, because
 * a tenant on a different Action1 region or API version can still answer with them.
 */
import type { DeviceImportRow } from "./bulk-import";
import type { DeviceCategory } from "./types";

/** The US tenant. EU tenants are `https://app.eu.action1.com/api/3.0` — set the env var. */
export const ACTION1_DEFAULT_BASE_URL = "https://app.action1.com/api/3.0";

/**
 * Long enough for a fleet listing, short enough that a wedged tenant does not hold an admin's
 * browser open. The import routes are the only callers and both are interactive.
 */
const ACTION1_TIMEOUT_MS = 30_000;

/** Stops a paging bug turning into an unbounded loop against somebody else's API. */
const ACTION1_MAX_PAGES = 20;

export type Action1Record = Record<string, unknown>;

export type Action1Config = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Set explicitly when the tenant has more than one organization. */
  organizationId: string | null;
};

export type Action1Fetch = {
  organizationId: string;
  records: Action1Record[];
};

/**
 * Thrown when the credentials are absent — which is a SETUP state, not a failure, and reads as one.
 * The routes map it to 400 with this message rather than 500, because nothing is broken.
 */
export class Action1NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Action1NotConfiguredError";
  }
}

/** Thrown when Action1 answered, but not with what was asked for. Carries the status. */
export class Action1RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "Action1RequestError";
    this.status = status;
  }
}

export function isAction1Configured(): boolean {
  return Boolean(process.env.ACTION1_CLIENT_ID?.trim() && process.env.ACTION1_CLIENT_SECRET?.trim());
}

export function action1Config(): Action1Config {
  const clientId = process.env.ACTION1_CLIENT_ID?.trim();
  const clientSecret = process.env.ACTION1_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Action1NotConfiguredError(
      "Phoenix is not connected to Action1 yet. In Action1, open Configuration then Users & API " +
        "Credentials and create an API key, then set ACTION1_CLIENT_ID and ACTION1_CLIENT_SECRET.",
    );
  }
  return {
    baseUrl: (process.env.ACTION1_API_BASE_URL?.trim() || ACTION1_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    clientId,
    clientSecret,
    organizationId: process.env.ACTION1_ORG_ID?.trim() || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading a record
// ---------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Action1Record =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * `Serial Number`, `serial_number` and `serialNumber` are one key here.
 *
 * Case and punctuation are exactly the axis Action1 could differ from this code on without either
 * being wrong, so they are removed from the comparison rather than guessed at.
 */
export const normalizeAction1Key = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Every primitive in the record, by normalized key, SHALLOWEST WINS — under BOTH its own name and
 * its parent-qualified name.
 *
 * SHALLOWEST MATTERS because `?fields=*` nests hardware detail, and a top-level `name` is the
 * endpoint's own name while a nested one could be a disk's or a network adapter's. So the walk is
 * BREADTH-FIRST, not depth-first: every key at one level is recorded before any key below it. A
 * depth-first walk gets this right or wrong depending on the order the keys happen to appear in the
 * JSON, which is not a property to rest an asset register on — `{nic: {name}, name}` would file the
 * laptop under its wireless card.
 *
 * THE QUALIFIED NAME IS WHY BOTH ARE STORED. A nested `os: {name: "Windows 11 Pro"}` loses the bare
 * `name` to the endpoint's own hostname, correctly, and would then be unreachable — the operating
 * system would read as absent and the machine would be filed as `other`, printing the wrong custody
 * form. Recording it as `osname` too means the candidate list finds it where it would look anyway.
 */
export function flattenAction1Record(record: Action1Record): Map<string, string> {
  const flat = new Map<string, string>();
  const queue: Array<{ depth: number; prefix: string; value: unknown }> = [
    { depth: 0, prefix: "", value: record },
  ];

  while (queue.length > 0) {
    const { depth, prefix, value } = queue.shift()!;
    if (depth > 3 || !value || typeof value !== "object") continue;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === null || child === undefined) continue;
      const normalized = normalizeAction1Key(key);

      if (typeof child === "object") {
        if (normalized) queue.push({ depth: depth + 1, prefix: `${prefix}${normalized}`, value: child });
        continue;
      }

      const text = String(child).trim();
      if (!normalized || !text) continue;
      if (!flat.has(normalized)) flat.set(normalized, text);
      const qualified = `${prefix}${normalized}`;
      if (prefix && !flat.has(qualified)) flat.set(qualified, text);
    }
  }

  return flat;
}

const pick = (flat: Map<string, string>, candidates: readonly string[]): string | null => {
  for (const candidate of candidates) {
    const value = flat.get(normalizeAction1Key(candidate));
    if (value) return value;
  }
  return null;
};

/** Candidate spellings, most likely first. See the file header on why these are lists. */
export const ACTION1_KEYS = {
  endpointId: ["id", "endpoint_id", "device_id", "agent_id", "uuid"],
  hostname: ["name", "hostname", "computer_name", "endpoint_name", "device_name", "machine_name", "dns_name"],
  manufacturer: ["manufacturer", "system_manufacturer", "computer_manufacturer", "vendor", "make"],
  model: ["model", "system_model", "computer_model", "product_name", "system_product_name"],
  serialNumber: ["serial_number", "serial", "bios_serial_number", "system_serial_number", "service_tag", "asset_serial"],
  processor: ["cpu", "processor", "cpu_name", "processor_name", "cpu_model", "cpu_description"],
  installedRam: ["installed_ram", "ram", "memory", "total_memory", "physical_memory", "total_physical_memory", "memory_total", "ram_total"],
  systemType: ["system_type", "os_architecture", "architecture", "arch", "platform_architecture"],
  operatingSystem: ["os", "os_name", "operating_system", "platform", "os_version", "os_caption"],
  imei: ["imei", "imei_number"],
} as const;

/**
 * The distinct keys a pull actually contained, for the dry run to show.
 *
 * This is the file's answer to being written without live credentials: rather than a blank Serial
 * column that reads as "these machines have no serial", the first pull shows the vocabulary
 * Action1 really used, and the candidate lists above get pinned from it.
 */
export function action1KeySample(records: readonly Action1Record[], limit = 60): string[] {
  const seen = new Set<string>();
  for (const record of records.slice(0, 5)) {
    for (const key of flattenAction1Record(record).keys()) seen.add(key);
  }
  return [...seen].sort().slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Normalizing what it said into what the receipt prints
// ---------------------------------------------------------------------------------------------

/**
 * Windows "About" prints `16.0 GB`, and that is what the custody form's technical block shows, so
 * that is the shape stored. Action1 may answer with the same string or with a bare number in any
 * of three units, which is decided by MAGNITUDE — the only signal a unitless number carries.
 */
export function normalizeInstalledRam(raw: string | null): string | null {
  const text = raw?.trim();
  if (!text) return null;
  // Already carries a unit. Passed through rather than reformatted: it is a human-readable value
  // already, and re-deriving it could only lose precision.
  if (/[a-z]/i.test(text)) return text;

  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const gigabytes =
    numeric >= 1_000_000_000
      ? numeric / 1_073_741_824 // bytes
      : numeric >= 1_000_000
        ? numeric / 1_048_576 // kilobytes
        : numeric >= 1_024
          ? numeric / 1_024 // megabytes
          : numeric; // already gigabytes
  return `${gigabytes.toFixed(1)} GB`;
}

/** `x64` and `AMD64` both mean what Windows About calls a 64-bit operating system. */
export function normalizeSystemType(raw: string | null): string | null {
  const text = raw?.trim();
  if (!text) return null;
  if (/x86[_-]?64|x64|amd64|aarch64|arm64|64[\s-]?bit/i.test(text)) return "64-bit operating system";
  if (/x86|i[356]86|32[\s-]?bit/i.test(text)) return "32-bit operating system";
  return text;
}

/**
 * Which of the two numbered custody forms this machine will print on.
 *
 * THE CONSEQUENCE IS THE FORM, not a label in a list. The register prints نموذج رقم 1 for `laptop`
 * and نموذج رقم 2 for everything else, so this decides whether the technical block on the signed
 * page is Windows "About" fields or IMEI and SIM details.
 *
 * A Windows DESKTOP is therefore mapped to `laptop`, which reads wrong and is right: its technical
 * block is the Windows one, and there is no third form to send it to. Anything unrecognised stays
 * `other` rather than being guessed into `laptop`, because `other` prints the portable form with
 * ruled blanks a person completes at the desk, which is the recoverable mistake of the two.
 */
export function action1Category(operatingSystem: string | null, model: string | null): DeviceCategory {
  const text = `${operatingSystem ?? ""} ${model ?? ""}`;
  if (/ipad|tablet|galaxy tab|surface pro/i.test(text)) return "tablet";
  if (/android|ipados|iphone|\bios\b/i.test(text)) return "phone";
  if (/windows|mac ?os|macos|darwin|linux|ubuntu|debian|centos|fedora/i.test(text)) return "laptop";
  return "other";
}

/**
 * The register needs a unique human handle and Action1 has none, so the hostname becomes it.
 *
 * The hostname is the right choice over a generated code: it is what IT already calls the machine,
 * it is on the Action1 screen he is looking at, and it is stable across a re-enrolment. Uppercased
 * so `SATO-LAP-07` and `sato-lap-07` cannot enter the register as two devices.
 */
export function action1AssetTag(
  hostname: string | null,
  serialNumber: string | null,
  endpointId: string | null,
): string | null {
  const host = hostname?.trim();
  if (host) return host.toUpperCase();
  const serial = serialNumber?.trim();
  if (serial) return serial.toUpperCase();
  const id = endpointId?.trim();
  return id ? `A1-${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase()}` : null;
}

// ---------------------------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------------------------

/**
 * One Action1 endpoint as one import row.
 *
 * PURE, and that is deliberate: this is the half worth pinning, and the suite runs with production
 * credentials (AGENTS.md §2.1), so a test that needed a live tenant to check a unit conversion
 * would be reaching a real API to assert arithmetic.
 *
 * `rowNumber` is the position in the pull. The type calls it the row in the user's own file, which
 * there is not one of here — it is what a reported problem is identified by, so it stays 1-based.
 */
export function mapAction1Record(record: Action1Record, index: number, pulledOn: string): DeviceImportRow {
  const flat = flattenAction1Record(record);

  const endpointId = pick(flat, ACTION1_KEYS.endpointId);
  const hostname = pick(flat, ACTION1_KEYS.hostname);
  const serialNumber = pick(flat, ACTION1_KEYS.serialNumber);
  const model = pick(flat, ACTION1_KEYS.model);
  const operatingSystem = pick(flat, ACTION1_KEYS.operatingSystem);
  const category = action1Category(operatingSystem, model);

  // The Windows "About" block belongs to the laptop form only. Sending a processor string to a
  // phone's receipt would print it in a block the form does not have.
  const isWindowsClass = category === "laptop";

  return {
    assetTag: action1AssetTag(hostname, serialNumber, endpointId),
    category,
    declarationNo: null,
    deviceName: isWindowsClass ? hostname : null,
    estimatedValueEgp: null,
    handoverPlace: null,
    // NEVER FILLED HERE. See the file header: Action1's idea of who uses a machine is not who
    // signed for it, and a custody record opened from it would name somebody on a signed
    // instrument who never put their name there.
    heldBy: null,
    imei: pick(flat, ACTION1_KEYS.imei),
    installedRam: isWindowsClass ? normalizeInstalledRam(pick(flat, ACTION1_KEYS.installedRam)) : null,
    issuedOn: null,
    lineNumber: null,
    manufacturer: pick(flat, ACTION1_KEYS.manufacturer),
    model,
    note: endpointId
      ? `Registered from Action1 on ${pulledOn}. Action1 endpoint ${endpointId}.`
      : `Registered from Action1 on ${pulledOn}.`,
    processor: isWindowsClass ? pick(flat, ACTION1_KEYS.processor) : null,
    purchasedOn: null,
    rowNumber: index + 1,
    serialNumber,
    simNumber: null,
    systemType: isWindowsClass ? normalizeSystemType(pick(flat, ACTION1_KEYS.systemType)) : null,
    windowsDeviceId: null,
    // Action1 does not carry the Windows Product ID — it is a licensing field, not an inventory
    // one. Left blank rather than filled with something adjacent, so the form prints a rule for it.
    windowsProductId: null,
  };
}

export function mapAction1Records(records: readonly Action1Record[], pulledOn: string): DeviceImportRow[] {
  return records.map((record, index) => mapAction1Record(record, index, pulledOn));
}

// ---------------------------------------------------------------------------------------------
// Talking to Action1
// ---------------------------------------------------------------------------------------------

const describeFailure = async (response: Response, what: string): Promise<Action1RequestError> => {
  const body = await response.text().catch(() => "");
  const detail = body.trim().slice(0, 300);
  if (response.status === 401 || response.status === 403) {
    return new Action1RequestError(
      `Action1 refused the credentials (HTTP ${response.status}). Check ACTION1_CLIENT_ID and ` +
        `ACTION1_CLIENT_SECRET, and that the API key is still active in Action1.`,
      response.status,
    );
  }
  return new Action1RequestError(
    `Action1 could not ${what} (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    response.status,
  );
};

async function requestToken(config: Action1Config): Promise<string> {
  const response = await fetch(`${config.baseUrl}/oauth2/token`, {
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "client_credentials",
    }),
    cache: "no-store",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    signal: AbortSignal.timeout(ACTION1_TIMEOUT_MS),
  });

  if (!response.ok) throw await describeFailure(response, "issue an access token");

  const payload: unknown = await response.json().catch(() => null);
  const token = isRecord(payload)
    ? [payload.access_token, payload.token, payload.jwt].find(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  if (!token) {
    throw new Action1RequestError("Action1 answered the token request without an access token.", 502);
  }
  return token;
}

/** Every shape a list response has been seen to take, plus the two obvious siblings. */
const extractRecords = (payload: unknown): Action1Record[] => {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of ["items", "data", "endpoints", "results", "records"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
};

const nextPageUrl = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;
  for (const key of ["next_page", "nextPage", "next"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

async function getJson(url: string, token: string, what: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(ACTION1_TIMEOUT_MS),
  });
  if (!response.ok) throw await describeFailure(response, what);
  return response.json().catch(() => null);
}

/**
 * Which organization to read.
 *
 * A tenant with one organization needs no configuration, which is the common case and the one worth
 * being frictionless. A tenant with SEVERAL refuses and names them, rather than taking the first:
 * silently pulling the wrong company's fleet into a custody register is not a mistake that
 * announces itself, and the fix is one environment variable.
 */
async function resolveOrganizationId(config: Action1Config, token: string): Promise<string> {
  if (config.organizationId) return config.organizationId;

  const payload = await getJson(`${config.baseUrl}/organizations`, token, "list your organizations");
  const organizations = extractRecords(payload);
  const identified = organizations
    .map((organization) => {
      const flat = flattenAction1Record(organization);
      return { id: pick(flat, ["id", "organization_id"]), name: pick(flat, ["name", "title"]) };
    })
    .filter((organization): organization is { id: string; name: string | null } => Boolean(organization.id));

  if (identified.length === 0) {
    throw new Action1RequestError("Action1 returned no organizations for these credentials.", 404);
  }
  if (identified.length > 1) {
    const names = identified.map((organization) => `${organization.name ?? "unnamed"} (${organization.id})`);
    throw new Action1RequestError(
      `This Action1 account has ${identified.length} organizations, so Phoenix will not guess which ` +
        `fleet to register. Set ACTION1_ORG_ID to one of: ${names.join(", ")}.`,
      409,
    );
  }
  return identified[0]!.id;
}

/**
 * The managed endpoints, all pages of them.
 *
 * `?fields=*` is the documented way to get the extended detail — without it the response carries
 * the patching summary and not the hardware, and the hardware is the entire point here.
 */
export async function fetchAction1Endpoints(): Promise<Action1Fetch> {
  const config = action1Config();
  const token = await requestToken(config);
  const organizationId = await resolveOrganizationId(config, token);

  const records: Action1Record[] = [];
  let url: string | null = `${config.baseUrl}/endpoints/managed/${encodeURIComponent(organizationId)}?fields=*`;

  for (let page = 0; page < ACTION1_MAX_PAGES && url; page += 1) {
    const payload: unknown = await getJson(url, token, "list your managed endpoints");
    records.push(...extractRecords(payload));
    const next = nextPageUrl(payload);
    url = next ? new URL(next, `${config.baseUrl}/`).toString() : null;
  }
  // The guard tripped with a next page still on offer: refuse rather than register a part of the fleet.
  if (url) {
    throw new Action1RequestError(
      "Action1 is still listing endpoints after the page limit, so Phoenix stops here rather than show a partial fleet.",
      502,
    );
  }

  return { organizationId, records };
}

/** One message for every way this can fail, written to be read by the person who pressed the button. */
export function action1ErrorMessage(error: unknown): string {
  if (error instanceof Action1NotConfiguredError || error instanceof Action1RequestError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Action1 did not answer within 30 seconds. Try again in a moment.";
  }
  return error instanceof Error ? error.message : "Action1 could not be reached.";
}
