import {
  parsePermissionActionStrict,
  parsePermissionResourceStrict,
  parseRoleStrict,
  type BusinessScope,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { validationError } from "@/lib/http/api-errors";

const businessScopes: BusinessScope[] = ["SELF", "TEAM", "HIERARCHY", "LINE", "COMPANY", "NONE"];
const phoenixLines = ["CNS", "Pedia", "Anti Infective", "Office", "Other"] as const;

export type GovernanceRequest = {
  governanceReason?: string | null;
};

export type AccessUserRequest = GovernanceRequest & {
  email: string | null;
  hrId: string | null;
  isActive?: boolean;
  line: string | null;
  loginId: string;
  managerHrId: string | null;
  name: string | null;
  role: PhoenixRole;
  salesScopeOverride: BusinessScope | null;
};

export type AccessUserStatusRequest = GovernanceRequest & {
  isActive: boolean;
  loginId: string;
};

export type PermissionOverrideRequest = GovernanceRequest & {
  action: PermissionAction;
  isAllowed: boolean;
  resource: PermissionResource;
  role: PhoenixRole;
};

export type PasswordSetupRequest = GovernanceRequest & {
  deliveryMode: "copy" | "email" | "whatsapp";
  loginId: string;
  purpose: "reset" | "setup";
};

export type BulkPasswordSetupRequest = GovernanceRequest & {
  deliveryMode: "copy" | "email";
  loginIds: string[];
  // Optional: when omitted each user's link purpose is derived per-user from
  // their current force_password_reset state (setup vs reset).
  purpose: "reset" | "setup" | null;
};

// Hard ceiling on how many login ids a single bulk request may carry. This is a
// payload-shape guard only; the route applies a smaller, delivery-specific
// processing cap (e.g. to respect the email provider's daily budget).
const bulkPasswordSetupMaxLoginIds = 500;

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function optionalTrimmedString(value: unknown, field: string) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw validationError(`${field} must be a string.`);
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function requiredTrimmedString(value: unknown, field: string) {
  const normalized = optionalTrimmedString(value, field);
  if (!normalized) {
    throw validationError(`${field} is required.`);
  }
  return normalized;
}

function optionalReason(value: unknown) {
  const reason = optionalTrimmedString(value, "governanceReason");
  if (reason && reason.length > 500) {
    throw validationError("governanceReason must be 500 characters or fewer.");
  }
  return reason;
}

function optionalBusinessScope(value: unknown) {
  const raw = optionalTrimmedString(value, "salesScopeOverride");
  if (!raw) return null;
  const normalized = raw.toUpperCase();
  if (!businessScopes.includes(normalized as BusinessScope)) {
    throw validationError("salesScopeOverride is invalid.");
  }
  return normalized as BusinessScope;
}

function optionalLine(value: unknown) {
  const raw = optionalTrimmedString(value, "line");
  if (!raw) return null;
  const matched = phoenixLines.find((line) => line.toLowerCase() === raw.toLowerCase());
  if (!matched) {
    throw validationError(`line must be one of: ${phoenixLines.join(", ")}.`);
  }
  return matched;
}

export function parseAccessUserRequest(body: unknown): AccessUserRequest {
  const payload = asRecord(body);
  const isActive = payload.isActive;
  if (typeof isActive !== "undefined" && typeof isActive !== "boolean") {
    throw validationError("isActive must be a boolean when provided.", "invalid_is_active");
  }

  return {
    email: optionalTrimmedString(payload.email, "email")?.toLowerCase() ?? null,
    governanceReason: optionalReason(payload.governanceReason),
    hrId: optionalTrimmedString(payload.hrId, "hrId"),
    isActive: typeof isActive === "boolean" ? isActive : undefined,
    line: optionalLine(payload.line),
    loginId: requiredTrimmedString(payload.loginId ?? payload.hrId, "loginId"),
    managerHrId: optionalTrimmedString(payload.managerHrId, "managerHrId"),
    name: optionalTrimmedString(payload.name, "name"),
    role: parseRoleStrict(requiredTrimmedString(payload.role, "role")),
    salesScopeOverride: optionalBusinessScope(payload.salesScopeOverride),
  };
}

export function parseAccessUserStatusRequest(body: unknown): AccessUserStatusRequest {
  const payload = asRecord(body);
  if (typeof payload.isActive !== "boolean") {
    throw validationError("isActive must be a boolean.", "invalid_is_active");
  }

  return {
    governanceReason: optionalReason(payload.governanceReason),
    isActive: payload.isActive,
    loginId: requiredTrimmedString(payload.loginId, "loginId"),
  };
}

export function parsePermissionOverrideRequest(body: unknown): PermissionOverrideRequest {
  const payload = asRecord(body);
  if (typeof payload.isAllowed !== "boolean") {
    throw validationError("isAllowed must be a boolean.", "invalid_is_allowed");
  }

  return {
    action: parsePermissionActionStrict(requiredTrimmedString(payload.action, "action").toLowerCase()),
    governanceReason: optionalReason(payload.governanceReason),
    isAllowed: payload.isAllowed,
    resource: parsePermissionResourceStrict(requiredTrimmedString(payload.resource, "resource")),
    role: parseRoleStrict(requiredTrimmedString(payload.role, "role")),
  };
}

export function parsePasswordSetupRequest(body: unknown): PasswordSetupRequest {
  const payload = asRecord(body);
  const deliveryMode = requiredTrimmedString(payload.deliveryMode ?? "email", "deliveryMode");
  const purpose = requiredTrimmedString(payload.purpose ?? "reset", "purpose");
  // 'whatsapp' prepares a wa.me link for the admin to press; it is accepted here and NOT in the bulk
  // parser below, because wa.me addresses exactly one chat — see the note there.
  if (deliveryMode !== "copy" && deliveryMode !== "email" && deliveryMode !== "whatsapp") {
    throw validationError("deliveryMode must be 'copy', 'email' or 'whatsapp'.");
  }
  if (purpose !== "setup" && purpose !== "reset") {
    throw validationError("purpose must be 'setup' or 'reset'.");
  }

  return {
    deliveryMode,
    governanceReason: optionalReason(payload.governanceReason),
    loginId: requiredTrimmedString(payload.loginId, "loginId"),
    purpose,
  };
}

export function parseBulkPasswordSetupRequest(body: unknown): BulkPasswordSetupRequest {
  const payload = asRecord(body);
  const deliveryMode = requiredTrimmedString(payload.deliveryMode ?? "email", "deliveryMode");
  // 🔴 NO 'whatsapp' IN BULK, AND IT IS NOT AN OVERSIGHT. A wa.me link opens ONE chat: a batch of them
  // would be a queue of browser tabs the admin has to press in turn, and nothing in WhatsApp can
  // address several chats or a group at once. WhatsApp stays a per-person button on the row.
  if (deliveryMode !== "copy" && deliveryMode !== "email") {
    throw validationError("deliveryMode must be 'copy' or 'email'.");
  }

  if (!Array.isArray(payload.loginIds)) {
    throw validationError("loginIds must be an array.");
  }
  const loginIds = Array.from(
    new Set(
      payload.loginIds
        .map((value) => optionalTrimmedString(value, "loginId"))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (loginIds.length === 0) {
    throw validationError("loginIds must contain at least one non-empty value.");
  }
  if (loginIds.length > bulkPasswordSetupMaxLoginIds) {
    throw validationError(`loginIds cannot contain more than ${bulkPasswordSetupMaxLoginIds} entries.`);
  }

  let purpose: "reset" | "setup" | null = null;
  const rawPurpose = optionalTrimmedString(payload.purpose, "purpose");
  if (rawPurpose) {
    if (rawPurpose !== "setup" && rawPurpose !== "reset") {
      throw validationError("purpose must be 'setup' or 'reset'.");
    }
    purpose = rawPurpose;
  }

  return {
    deliveryMode,
    governanceReason: optionalReason(payload.governanceReason),
    loginIds,
    purpose,
  };
}
