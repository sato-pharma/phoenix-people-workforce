/**
 * Enrolling a rep tablet onto the company's own Headwind server — the QR a factory-fresh tablet scans.
 *
 * 🔴 PHOENIX CANNOT MINT THIS CODE, AND THE REASON IS NOT A MISSING ENDPOINT. The provisioning payload
 * pins the agent APK by its SIGNATURE CHECKSUM, and the APK is the one the Headwind box itself serves.
 * A payload Phoenix invented would carry either no checksum — which a factory-fresh tablet refuses —
 * or a checksum for a file it has never seen. So the owner copies the code out of the Headwind console
 * once, and Phoenix redraws it for every tablet from then on. That is the same bargain the ManageEngine
 * card already makes, for a different reason, and the two modules are deliberately the same shape.
 *
 * 🔴 THE PAYLOAD IS A CREDENTIAL. Anyone who scans it puts a tablet into the company's fleet with the
 * agent as device owner. It lives in one service-role-only row; it is never logged, never included in
 * the ordinary read the page does on load, and never written into an audit row. `readHeadwindEnrollmentQr`
 * is the one function that returns it, and the page calls it only when a person asks to see the code.
 *
 * NOTHING IS ADDED TO THE PAYLOAD. The `com.hmdm.*` extras are the agent's own — `BASE_URL`,
 * `SERVER_PROJECT`, `DEVICE_ID`, `CONFIG`, `GROUP`, `SKIP_INTRO`, `OPEN_WIFI`. A key added to that
 * bundle is a key the agent did not expect, so Phoenix passes it through byte-for-byte and matches the
 * tablet to the custody register afterwards, by serial and IMEI.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { deviceActorNames } from "@/lib/devices/actor-names";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TABLE = "headwind_enrollment_template";

/** Android's own provisioning keys. `PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME` is the load-bearing one. */
const COMPONENT_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME";
const DOWNLOAD_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION";
const CHECKSUM_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM";
const WIFI_SSID_KEY = "android.app.extra.PROVISIONING_WIFI_SSID";
const EXTRAS_KEY = "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE";

/** The agent's own keys inside the extras bundle, as the Headwind console writes them. */
const BASE_URL_KEY = "com.hmdm.BASE_URL";
const CONFIG_KEY = "com.hmdm.CONFIG";

export class HeadwindEnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindEnrollmentError";
  }
}

/** What the page may show about the code WITHOUT showing the code. */
export type HeadwindEnrollmentSummary = {
  saved: boolean;
  templateName: string | null;
  /** The agent package the tablet will install, read out of the component name. */
  agentPackage: string | null;
  /** Where the agent is downloaded from — the host only, never the full URL with its query. */
  downloadHost: string | null;
  /** The Headwind server the tablet will report to — the host only. */
  serverHost: string | null;
  /** Which set of tablet rules a newly enrolled tablet lands on, if the code names one. */
  configurationName: string | null;
  /** 🔴 A code with no checksum is refused by a factory-fresh tablet. Worth saying on the page. */
  hasChecksum: boolean;
  joinsWifi: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type HeadwindTemplateFacts = Omit<
  HeadwindEnrollmentSummary,
  "saved" | "templateName" | "updatedAt" | "updatedBy"
>;

const EMPTY_FACTS: HeadwindTemplateFacts = {
  agentPackage: null,
  configurationName: null,
  downloadHost: null,
  hasChecksum: false,
  joinsWifi: false,
  serverHost: null,
};

const EMPTY_SUMMARY: HeadwindEnrollmentSummary = {
  ...EMPTY_FACTS,
  saved: false,
  templateName: null,
  updatedAt: null,
  updatedBy: null,
};

function hostOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value.trim()).host || null;
  } catch {
    return null;
  }
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

/**
 * Read what a person pasted, and refuse it in words if it is not a Headwind provisioning payload.
 *
 * Returns the payload RE-SERIALISED — same keys, same values, normalised whitespace — so what is
 * stored is known-parseable JSON rather than whatever the clipboard carried. The extras bundle inside
 * is copied through untouched.
 */
export function parseHeadwindEnrollmentTemplate(raw: string): {
  payload: string;
  facts: HeadwindTemplateFacts;
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

  return {
    facts: {
      agentPackage: packageOf(component),
      configurationName: typeof extras[CONFIG_KEY] === "string" ? String(extras[CONFIG_KEY]) : null,
      downloadHost: hostOf(record[DOWNLOAD_KEY]),
      hasChecksum: typeof record[CHECKSUM_KEY] === "string" && record[CHECKSUM_KEY].trim().length > 0,
      joinsWifi: typeof record[WIFI_SSID_KEY] === "string" && record[WIFI_SSID_KEY].trim().length > 0,
      serverHost: hostOf(extras[BASE_URL_KEY]),
    },
    payload: JSON.stringify(record),
  };
}

type TemplateRow = {
  template_name: string | null;
  qr_payload: string;
  updated_by: string;
  updated_at: string;
};

async function readRow(): Promise<TemplateRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("template_name, qr_payload, updated_by, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`The saved Headwind enrollment code could not be read: ${error.message}`);
  return (data as TemplateRow | null) ?? null;
}

/**
 * What the page loads: everything about the code except the code.
 *
 * A payload that no longer parses is reported as saved-but-unreadable rather than thrown away — the
 * row is the only copy, and the fix is a fresh paste, not a silent deletion.
 */
export async function getHeadwindEnrollmentSummary(): Promise<HeadwindEnrollmentSummary> {
  const row = await readRow();
  if (!row) return EMPTY_SUMMARY;

  let facts: HeadwindTemplateFacts = EMPTY_FACTS;
  try {
    facts = parseHeadwindEnrollmentTemplate(row.qr_payload).facts;
  } catch {
    // Saved before a validation rule existed, or hand-edited. Still saved; still shown.
  }

  return {
    ...facts,
    saved: true,
    templateName: row.template_name,
    updatedAt: row.updated_at,
    // A name, never the HR id the row was saved under — see `deviceActorNames`.
    updatedBy: (await deviceActorNames([row.updated_by]))(row.updated_by),
  };
}

/**
 * The payload itself, for the one moment the page draws the QR.
 *
 * 🔴 Everything that calls this is handing a credential to a browser. It is called from the route
 * behind `company_devices:approve`, on an explicit request, and the page drops it on "Hide".
 */
export async function readHeadwindEnrollmentQr(): Promise<{
  payload: string;
  templateName: string | null;
}> {
  const row = await readRow();
  if (!row) {
    throw new HeadwindEnrollmentError(
      "No enrollment code is saved yet. Paste the code from the Headwind console first.",
    );
  }
  return { payload: row.qr_payload, templateName: row.template_name };
}

/**
 * Save an enrollment code, replacing whatever was there.
 *
 * The audit row records the code's NAME, the agent package, the server host and whether it replaced an
 * earlier one — never the payload, which is the credential this whole module is careful with.
 */
export async function saveHeadwindEnrollmentTemplate(
  input: { raw: string; templateName?: string | null },
  actor: string,
): Promise<HeadwindEnrollmentSummary> {
  const { payload, facts } = parseHeadwindEnrollmentTemplate(input.raw);
  const templateName = input.templateName?.trim() || null;
  const previous = await readRow();
  const updatedAt = new Date().toISOString();

  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(
      { id: 1, qr_payload: payload, template_name: templateName, updated_at: updatedAt, updated_by: actor },
      { onConflict: "id" },
    );
  if (error) throw new Error(`The Headwind enrollment code could not be saved: ${error.message}`);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: "headwind-enrollment-template",
    entityType: "headwind_enrollment",
    newValues: {
      agentPackage: facts.agentPackage,
      configurationName: facts.configurationName,
      downloadHost: facts.downloadHost,
      hasChecksum: facts.hasChecksum,
      serverHost: facts.serverHost,
      templateName,
    },
    oldValues: previous ? { templateName: previous.template_name, updatedBy: previous.updated_by } : null,
    summary: previous
      ? `Replaced the Headwind enrollment code${templateName ? ` with ${templateName}` : ""}`
      : `Saved the Headwind enrollment code${templateName ? ` (${templateName})` : ""}`,
  });

  return { ...facts, saved: true, templateName, updatedAt, updatedBy: (await deviceActorNames([actor]))(actor) };
}

/** Someone asked to see the code. The looking is itself worth a row. */
export async function revealHeadwindEnrollmentQr(
  actor: string,
): Promise<{ payload: string; templateName: string | null }> {
  const result = await readHeadwindEnrollmentQr();
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: "headwind-enrollment-template",
    entityType: "headwind_enrollment",
    // 🔴 THE FACT OF THE LOOK, NEVER THE PAYLOAD.
    newValues: { revealed: true, templateName: result.templateName },
    oldValues: null,
    summary: "Displayed the Headwind enrollment code",
  });
  return result;
}
