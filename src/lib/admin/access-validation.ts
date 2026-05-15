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
const phoenixLines = ["CNS", "Pedia", "Anti-Infective", "Office", "Other"] as const;

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
  deliveryMode: "copy" | "email";
  loginId: string;
  purpose: "reset" | "setup";
};

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
  if (deliveryMode !== "copy" && deliveryMode !== "email") {
    throw validationError("deliveryMode must be 'copy' or 'email'.");
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
