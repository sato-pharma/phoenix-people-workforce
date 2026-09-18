/**
 * Enrolling a company tablet — the enrollment token and the QR code a factory-fresh tablet scans.
 *
 * HOW A TABLET JOINS THE FLEET. A tablet straight out of the box (or factory-reset) is tapped six
 * times on its welcome screen, which opens a QR reader. It scans the code built here, connects to
 * Wi-Fi, downloads Android Device Policy and enrolls itself as a FULLY MANAGED company device on the
 * `rep-tablet` policy. The fallback when the camera will not read the code: type `afw#setup` where
 * the tablet asks for a Google account, and enter the enrollment code when asked.
 *
 * ALWAYS COMPANY-OWNED, NEVER A WORK PROFILE. `allowPersonalUsage` is pinned to
 * PERSONAL_USAGE_DISALLOWED: these are company tablets handed to reps under a custody receipt, not
 * the reps' own devices.
 *
 * A CODE MADE FOR ONE TABLET WORKS ONCE, AND SAYS WHICH TABLET IT WAS FOR. A token minted against a
 * register entry is one-time-only and carries that entry's id in `additionalData`, which Google
 * hands back on the enrolled device as `enrollmentTokenData`. That is how the enrolled-tablets list
 * knows which asset tag a tablet is — without anybody typing a serial number — and how it can tell
 * the wrong tablet was enrolled with a code (the serial will not match the register). A code for
 * "any tablet" is reusable until it expires, for enrolling a batch.
 *
 * 🔴 THE TOKEN VALUE AND THE QR PAYLOAD ARE CREDENTIALS. Anyone holding either can enrol a device
 * into the company's fleet until the token expires. They go to the browser that asked and nowhere
 * else: never logged, never written to the audit row, never put in a URL. The token's resource
 * name is not needed after creation and is dropped here rather than carried around.
 */

import { AndroidManagementRequestError, callAndroidManagement } from "@/lib/devices/android-web-app";
import { repTabletPolicyName } from "@/lib/devices/tablet-policy";

/** How long a new code stays usable. Google's own default is one hour; Phoenix defaults to a day. */
export type EnrollmentValidity = "1h" | "24h" | "7d";

export const ENROLLMENT_VALIDITY: Record<EnrollmentValidity, { seconds: number; label: string }> = {
  "1h": { label: "1 hour", seconds: 3_600 },
  "24h": { label: "24 hours", seconds: 86_400 },
  "7d": { label: "7 days", seconds: 604_800 },
};

export const DEFAULT_ENROLLMENT_VALIDITY: EnrollmentValidity = "24h";

export function isEnrollmentValidity(value: unknown): value is EnrollmentValidity {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ENROLLMENT_VALIDITY, value);
}

/** Google's ceiling on `additionalData`. */
export const ENROLLMENT_DATA_MAX_CHARS = 1_024;

/**
 * The provisioning extra that stops Android disabling the tablet's built-in apps.
 *
 * Fully managed provisioning switches off every system app Android does not consider essential,
 * and the camera app is usually one of them. Phoenix's invoice capture (`capture="environment"`)
 * hands off to that camera app, so without this extra the photo button on a rep's tablet opens
 * nothing. Google's enrollment docs invite adding provisioning extras to the QR payload; this one is
 * `DevicePolicyManager.EXTRA_PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED`.
 */
export const LEAVE_ALL_SYSTEM_APPS_ENABLED = "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED";

/** What a register-tied code records about its tablet, echoed back on the enrolled device. */
export type EnrollmentTokenData = {
  v: 1;
  registerDeviceId: string;
  assetTag: string;
};

export type EnrollmentTarget = { registerDeviceId: string; assetTag: string };

export function serializeEnrollmentTokenData(target: EnrollmentTarget): string {
  const data: EnrollmentTokenData = { assetTag: target.assetTag, registerDeviceId: target.registerDeviceId, v: 1 };
  const serialized = JSON.stringify(data);
  if (serialized.length > ENROLLMENT_DATA_MAX_CHARS) {
    throw new Error(
      `The tablet's register details come to ${serialized.length} characters; Google keeps at most ${ENROLLMENT_DATA_MAX_CHARS}.`,
    );
  }
  return serialized;
}

/** Tolerant: a device enrolled some other way carries nothing, or something that is not ours. */
export function parseEnrollmentTokenData(raw: string | null | undefined): EnrollmentTokenData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EnrollmentTokenData> | null;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    if (typeof parsed.registerDeviceId !== "string" || !parsed.registerDeviceId) return null;
    return {
      assetTag: typeof parsed.assetTag === "string" ? parsed.assetTag : "",
      registerDeviceId: parsed.registerDeviceId,
      v: 1,
    };
  } catch {
    return null;
  }
}

/** The request body `enrollmentTokens.create` takes. */
export type EnrollmentTokenRequest = {
  policyName: string;
  duration: string;
  allowPersonalUsage: "PERSONAL_USAGE_DISALLOWED";
  oneTimeOnly: boolean;
  additionalData?: string;
};

export function buildEnrollmentTokenRequest(options: {
  enterpriseName: string;
  validFor: EnrollmentValidity;
  target: EnrollmentTarget | null;
}): EnrollmentTokenRequest {
  if (!isEnrollmentValidity(options.validFor)) {
    throw new Error(`'${String(options.validFor)}' is not one of the offered validity periods.`);
  }
  const request: EnrollmentTokenRequest = {
    allowPersonalUsage: "PERSONAL_USAGE_DISALLOWED",
    duration: `${ENROLLMENT_VALIDITY[options.validFor].seconds}s`,
    oneTimeOnly: options.target !== null,
    policyName: repTabletPolicyName(options.enterpriseName),
  };
  if (options.target) request.additionalData = serializeEnrollmentTokenData(options.target);
  return request;
}

/**
 * Add the keep-built-in-apps extra to Google's QR payload.
 *
 * Google's JSON is otherwise passed through untouched — the admin component, its checksum, the
 * download location and the token bundle are Google's to define, and editing them would break
 * provisioning in ways only a tablet in the field would reveal.
 */
export function withBuiltInAppsKept(qrCode: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(qrCode);
  } catch {
    throw new AndroidManagementRequestError("Google returned an enrollment QR payload that is not JSON.", 200);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AndroidManagementRequestError("Google returned an enrollment QR payload that is not a JSON object.", 200);
  }
  return JSON.stringify({ ...(parsed as Record<string, unknown>), [LEAVE_ALL_SYSTEM_APPS_ENABLED]: true });
}

export type CreatedEnrollment = {
  /** The typed fallback for `afw#setup`. A credential — never log it. */
  enrollmentCode: string;
  /** The JSON a tablet scans, already carrying the keep-built-in-apps extra. A credential. */
  qrPayload: string;
  expiresAt: string | null;
  oneTimeOnly: boolean;
};

export async function createEnrollmentToken(
  options: { token: string; enterpriseName: string; request: EnrollmentTokenRequest },
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedEnrollment> {
  const payload = (await callAndroidManagement(
    options.token,
    `/${options.enterpriseName.trim()}/enrollmentTokens`,
    { body: JSON.stringify(options.request), method: "POST" },
    fetchImpl,
  )) as { value?: unknown; qrCode?: unknown; expirationTimestamp?: unknown; oneTimeOnly?: unknown };

  const enrollmentCode = typeof payload.value === "string" ? payload.value.trim() : "";
  const qrCode = typeof payload.qrCode === "string" ? payload.qrCode.trim() : "";
  if (!enrollmentCode || !qrCode) {
    // A 200 without these would reach the page as an empty code and a blank square, and the rep's
    // tablet would be blamed for not scanning it.
    throw new AndroidManagementRequestError(
      "Google created the enrollment token but returned no QR code or no enrollment code, so there is nothing a tablet could scan.",
      200,
    );
  }

  return {
    enrollmentCode,
    expiresAt: typeof payload.expirationTimestamp === "string" ? payload.expirationTimestamp : null,
    oneTimeOnly: payload.oneTimeOnly === true,
    qrPayload: withBuiltInAppsKept(qrCode),
  };
}
