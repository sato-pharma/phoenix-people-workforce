/**
 * Console logins on the company's own Headwind server.
 *
 * WHY THIS IS WORTH A SCREEN. The system this replaces priced technicians: the trial allowed ONE, and
 * a second seat was part of what made the paid tier $3,000–5,000 a year. On our own Headwind server
 * there is no such limit — the only caps anywhere in `hmdm-server`'s licensing are device count and
 * disk space, and neither touches users. So "unlimited technicians" is simply true here, and adding a
 * colleague is a form rather than a purchase.
 *
 * 🔴 A PASSWORD IS WRITTEN AND NEVER READ BACK. `newPassword` goes up in plain text over HTTPS — that
 * is the server's own contract, not a choice made here — and nothing in this module returns, logs or
 * audits it. The list read carries logins and roles only. If a password is lost, it is replaced, not
 * recovered.
 *
 * 🔴 AND THE REAL POINT, WHICH IS NOT OBVIOUS FROM THE FORM: anyone who can sign in to this console
 * can reach every tablet — lock them, wipe them, watch them. Phoenix's own permission matrix does not
 * reach across into a second system. That is why this route sits on `company_devices:approve`, Super
 * Admin only, and why every add and every removal writes a required audit row naming the login and the
 * role it was given.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";

export class HeadwindUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindUserError";
  }
}

export type HeadwindConsoleUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  roleId: number | null;
  roleName: string | null;
  /** The server's own flag. A user kept but switched off reads as false. */
  enabled: boolean;
};

export type HeadwindConsoleRole = { id: number; name: string };

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function consoleUsersFrom(raw: unknown, roles: readonly HeadwindConsoleRole[]): HeadwindConsoleUser[] {
  const rows = Array.isArray(raw) ? raw : [];
  const users: HeadwindConsoleUser[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (typeof row?.id !== "number") continue;
    const login = asText(row.login);
    if (!login) continue;
    const roleId = typeof row.userRoleId === "number" ? row.userRoleId : null;
    users.push({
      email: asText(row.email),
      // `enabled` is absent on older rows; absent means in use, not switched off.
      enabled: row.enabled !== false,
      id: row.id,
      login,
      name: asText(row.name),
      roleId,
      roleName: roles.find((role) => role.id === roleId)?.name ?? null,
    });
  }
  return users.sort((a, b) => a.login.localeCompare(b.login));
}

export function consoleRolesFrom(raw: unknown): HeadwindConsoleRole[] {
  const rows = Array.isArray(raw) ? raw : [];
  const roles: HeadwindConsoleRole[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const name = asText(row?.name);
    if (typeof row?.id === "number" && name) roles.push({ id: row.id, name });
  }
  return roles.sort((a, b) => a.name.localeCompare(b.name));
}

/** Who can sign in to the console, and what roles exist to give them. */
export async function getHeadwindConsoleUsers(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ users: HeadwindConsoleUser[]; roles: HeadwindConsoleRole[]; note: string }> {
  const [rawRoles, rawUsers] = await Promise.all([
    callHeadwind<unknown>("/rest/private/roles", { method: "GET" }, fetchImpl, env),
    callHeadwind<unknown>("/rest/private/users/search/", { method: "GET" }, fetchImpl, env),
  ]);
  const roles = consoleRolesFrom(rawRoles);
  return {
    note:
      "There is no limit on how many people can sign in to this server — the only limits it has are " +
      "on tablets and disk space. 🔴 Anyone here can reach every tablet, whatever their Phoenix role " +
      "says, because this is a separate system.",
    roles,
    users: consoleUsersFrom(rawUsers, roles),
  };
}

/** Minimum length for a console password, since this login can wipe a tablet. */
export const HEADWIND_MIN_PASSWORD = 12;

export type HeadwindUserInput = {
  login: string;
  name?: string | null;
  email?: string | null;
  roleId: number;
  password: string;
};

/**
 * Add a console login.
 *
 * 🔴 THE PASSWORD IS NEVER PUT IN THE AUDIT ROW, THE RETURN VALUE OR ANY MESSAGE. It is read from the
 * request, sent to Headwind, and dropped.
 */
export async function createHeadwindConsoleUser(
  input: HeadwindUserInput,
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ login: string; message: string }> {
  const login = input.login.trim();
  if (!login) throw new HeadwindUserError("Give the new login a name to sign in with.");
  if (!/^[a-zA-Z0-9._-]+$/.test(login)) {
    throw new HeadwindUserError(
      "A login can only have letters, numbers, a dot, an underscore or a dash — no spaces and no accents.",
    );
  }
  if (!Number.isInteger(input.roleId)) throw new HeadwindUserError("Choose what this person can do.");
  if ((input.password ?? "").length < HEADWIND_MIN_PASSWORD) {
    throw new HeadwindUserError(
      `The password has to be at least ${HEADWIND_MIN_PASSWORD} characters. This login can lock and erase ` +
        "every tablet in the fleet.",
    );
  }

  await callHeadwind(
    "/rest/private/users",
    {
      body: JSON.stringify({
        email: input.email?.trim() || null,
        enabled: true,
        login,
        name: input.name?.trim() || login,
        newPassword: input.password,
        userRoleId: input.roleId,
      }),
      method: "PUT",
    },
    fetchImpl,
    env,
  );

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: login,
    entityType: "headwind_user",
    // 🔴 NO PASSWORD FIELD HERE, EVER.
    newValues: { login, name: input.name?.trim() || login, roleId: input.roleId },
    oldValues: null,
    summary: `Added the Headwind console login ${login}`,
  });

  return {
    login,
    message:
      `${login} can now sign in to the tablet server. Give them the password in person or over a private ` +
      "channel — it is not stored here and cannot be read back.",
  };
}

/** Take a console login away. */
export async function removeHeadwindConsoleUser(
  input: { userId: number; login: string },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ message: string }> {
  if (!Number.isInteger(input.userId)) throw new HeadwindUserError("Say which login to remove.");

  await callHeadwind(
    `/rest/private/users/${input.userId}`,
    { method: "DELETE" },
    fetchImpl,
    env,
  );

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: input.login || String(input.userId),
    entityType: "headwind_user",
    newValues: null,
    oldValues: { login: input.login || null, userId: input.userId },
    summary: `Removed the Headwind console login ${input.login || input.userId}`,
  });

  return {
    message: `${input.login || "That login"} can no longer sign in to the tablet server. Any session it already has ends at its next request.`,
  };
}
