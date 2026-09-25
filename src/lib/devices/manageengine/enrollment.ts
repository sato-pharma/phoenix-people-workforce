/**
 * Enrolling a rep tablet through ManageEngine — the QR a factory-fresh tablet scans.
 *
 * 🔴 MANAGEENGINE HAS NO ENROLLMENT API. Their REST API covers Devices, Profiles, Apps, Actions,
 * Groups, Users and Enrollment SETTINGS — and nothing that mints an enrollment token or returns a
 * QR. The QR is generated in the ManageEngine console (Enrollment → Android → QR Code) as an
 * enrollment TEMPLATE, and it is the same payload for every tablet enrolled through that template.
 * So Phoenix cannot make one on demand the way it does for Google. It holds the template's payload
 * once and renders it, which is the whole difference between this module and `tablet-enrollment.ts`.
 *
 * WHY THIS IS THE PATH THAT WORKS. Google gives a new Cloud project a device quota of ZERO until it
 * approves an application, so the Google QR is refused on the tablet — "your organization has
 * reached its usage limits" — while the enterprise holds no devices at all. ManageEngine is an
 * approved EMM with its own allowance, and the tablets already in this fleet enrolled through it.
 *
 * 🔴 THE PAYLOAD IS A CREDENTIAL. Anyone who scans it puts a tablet into the company's fleet. It
 * lives in one service-role-only row, it is NEVER logged, it is NEVER included in the ordinary read
 * the page does on load, and the audit row records that it changed and who changed it — never the
 * payload itself. `readManageEngineEnrollmentQr` is the one function that returns it, and the page
 * calls it only when a person asks to see the code.
 *
 * NOTHING IS ADDED TO THE PAYLOAD. Google's token could carry the custody-register id, so a tablet
 * arrived already knowing which entry it belonged to. ManageEngine's admin extras bundle is
 * ManageEngine's own and a key added to it is a key their agent did not expect, so Phoenix passes it
 * through byte-for-byte and matches the tablet to the register afterwards, by serial and IMEI.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TABLE = "manageengine_enrollment_template";

/** Android's own provisioning keys. `PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME` is the load-bearing one. */
const COMPONENT_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME";
const DOWNLOAD_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION";
const CHECKSUM_KEY = "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM";
const WIFI_SSID_KEY = "android.app.extra.PROVISIONING_WIFI_SSID";

/** The template was pasted wrong. The message says which part, because "invalid" helps nobody. */
export class ManageEngineEnrollmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManageEngineEnrollmentInputError";
  }
}

/** What the page may show about the template WITHOUT showing the template. */
export type ManageEngineEnrollmentSummary = {
  saved: boolean;
  templateName: string | null;
  /** The agent package the tablet will install, read out of the component name. */
  agentPackage: string | null;
  /** Where the agent is downloaded from — the host only, never the full URL with its query. */
  downloadHost: string | null;
  /** Whether the template pins the agent's signature. A template without one is unusual. */
  hasChecksum: boolean;
  /** Whether the template joins a Wi-Fi network during setup. */
  joinsWifi: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** The half of the summary that is read out of the payload itself. */
export type ManageEngineTemplateFacts = Omit<
  ManageEngineEnrollmentSummary,
  "saved" | "templateName" | "updatedAt" | "updatedBy"
>;

const EMPTY_SUMMARY: ManageEngineEnrollmentSummary = {
  agentPackage: null,
  downloadHost: null,
  hasChecksum: false,
  joinsWifi: false,
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

/** `com.manageengine.mdm.android/.AgentDeviceAdminReceiver` → `com.manageengine.mdm.android`. */
function packageOf(component: unknown): string | null {
  if (typeof component !== "string") return null;
  const name = component.split("/")[0]?.trim();
  return name || null;
}

/**
 * Read what a person pasted, and refuse it in words if it is not a provisioning payload.
 *
 * Returns the payload RE-SERIALISED — same keys, same values, normalised whitespace — so what is
 * stored is known-parseable JSON rather than whatever the clipboard carried. The admin extras bundle
 * inside is copied through untouched.
 */
export function parseManageEngineEnrollmentTemplate(raw: string): { payload: string; facts: ManageEngineTemplateFacts } {
  const text = raw.trim();
  if (!text) throw new ManageEngineEnrollmentInputError("Paste the QR payload from the ManageEngine enrollment template.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ManageEngineEnrollmentInputError(
      "That is not the QR payload. Copy the whole JSON text ManageEngine shows under the QR code, starting with { and ending with }.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManageEngineEnrollmentInputError("The QR payload must be a single JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const component = record[COMPONENT_KEY];
  if (typeof component !== "string" || !component.includes("/")) {
    throw new ManageEngineEnrollmentInputError(
      `This payload has no ${COMPONENT_KEY}, so no tablet would know what to install. It is not an Android provisioning QR.`,
    );
  }
  if (typeof record[DOWNLOAD_KEY] !== "string" || !hostOf(record[DOWNLOAD_KEY])) {
    throw new ManageEngineEnrollmentInputError(
      "This payload names no download location for the ManageEngine agent, so a factory-fresh tablet would have nothing to fetch.",
    );
  }

  return {
    facts: {
      agentPackage: packageOf(component),
      downloadHost: hostOf(record[DOWNLOAD_KEY]),
      hasChecksum: typeof record[CHECKSUM_KEY] === "string" && record[CHECKSUM_KEY].trim().length > 0,
      joinsWifi: typeof record[WIFI_SSID_KEY] === "string" && record[WIFI_SSID_KEY].trim().length > 0,
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
  if (error) throw new Error(`The saved enrollment template could not be read: ${error.message}`);
  return (data as TemplateRow | null) ?? null;
}

/**
 * What the page loads: everything about the template except the template.
 *
 * A payload that no longer parses is reported as saved-but-unreadable rather than thrown away — the
 * row is the only copy, and the fix is a fresh paste, not a silent deletion.
 */
export async function getManageEngineEnrollmentSummary(): Promise<ManageEngineEnrollmentSummary> {
  const row = await readRow();
  if (!row) return EMPTY_SUMMARY;

  let facts: ManageEngineTemplateFacts = { agentPackage: null, downloadHost: null, hasChecksum: false, joinsWifi: false };
  try {
    facts = parseManageEngineEnrollmentTemplate(row.qr_payload).facts;
  } catch {
    // Saved before a validation rule existed, or hand-edited. Still saved; still shown.
  }

  return {
    ...facts,
    saved: true,
    templateName: row.template_name,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * The payload itself, for the one moment the page draws the QR.
 *
 * 🔴 Everything that calls this is handing a credential to a browser. It is called from the route
 * behind `company_devices:approve`, on an explicit request, and the page drops it on "Hide".
 */
export async function readManageEngineEnrollmentQr(): Promise<{ payload: string; templateName: string | null }> {
  const row = await readRow();
  if (!row) {
    throw new ManageEngineEnrollmentInputError(
      "No enrollment template is saved yet. Paste the QR payload from ManageEngine first.",
    );
  }
  return { payload: row.qr_payload, templateName: row.template_name };
}

/**
 * Save a template, replacing whatever was there.
 *
 * The audit row records the template's NAME, the agent package and whether it changed at all —
 * never the payload, which is the credential this whole module is careful with.
 */
export async function saveManageEngineEnrollmentTemplate(
  input: { raw: string; templateName?: string | null },
  actor: string,
): Promise<ManageEngineEnrollmentSummary> {
  const { payload, facts } = parseManageEngineEnrollmentTemplate(input.raw);
  const templateName = input.templateName?.trim() || null;
  const previous = await readRow();

  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(
      { id: 1, qr_payload: payload, template_name: templateName, updated_at: new Date().toISOString(), updated_by: actor },
      { onConflict: "id" },
    );
  if (error) throw new Error(`The enrollment template could not be saved: ${error.message}`);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: "manageengine-enrollment-template",
    entityType: "manageengine_enrollment_template",
    newValues: { agentPackage: facts.agentPackage, downloadHost: facts.downloadHost, templateName },
    oldValues: previous ? { templateName: previous.template_name, updatedBy: previous.updated_by } : null,
    summary: previous
      ? `Replaced the ManageEngine enrollment template${templateName ? ` with ${templateName}` : ""}`
      : `Saved the ManageEngine enrollment template${templateName ? ` (${templateName})` : ""}`,
  });

  return { ...facts, saved: true, templateName, updatedAt: new Date().toISOString(), updatedBy: actor };
}
