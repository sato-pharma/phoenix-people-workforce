/**
 * Console logins on the company's own Headwind server.
 *
 * WHY THIS IS WORTH A SCREEN. The system this replaces priced technicians: the trial allowed ONE, and
 * a second seat was part of what made the paid tier $3,000–5,000 a year. On our own Headwind server
 * there is no such limit — the only caps anywhere in `hmdm-server`'s licensing are device count and
 * disk space, and neither touches users. So "unlimited technicians" is simply true here, and adding a
 * colleague is a form rather than a purchase.
 *
 * 🔴 THE WIRE CONTRACT IS THE ONE `scripts/headwind-bootstrap.mjs` MEASURED, NOT THE ONE THIS FILE
 * GUESSED (9 Nov 2026 audit, F14). That script created a console user against the live server and
 * proved it signs in; this file disagreed with it on every point, and so told the owner "can now sign
 * in" about a login that could not:
 *   · roles are `GET /rest/private/users/roles` — `/rest/private/roles` is not a path on this server;
 *   · the list is `GET /rest/private/users/all` — `/users/search/` is not the list;
 *   · the password goes up as UPPER-CASE MD5 in `newPassword` (and `confirmModal`), exactly as the
 *     console's own `users.controller.js` sends it. The server runs `getHashFromMd5` over whatever
 *     arrives, and the sign-in sends the MD5 too — so a plain-text password is stored as the hash of
 *     the wrong thing, and every sign-in with the right password is refused;
 *   · the role is `userRole: { id }`. `User` has no `userRoleId` field and ignores unknown ones, so
 *     that key was dropped on the floor;
 *   · removal is `DELETE /rest/private/users/other/{id}` (upstream `UserResource`). There is no
 *     DELETE on `/users/{id}`, so every removal failed.
 * 🔴 AND A SUCCESS ENVELOPE IS NOT TAKEN AS PROOF. Both writes are read back from `/users/all`: a
 * create is reported only once the login is there with the role asked for, a removal only once it is
 * gone. This server has answered `OK` to a write it did not make before (remote-screen-id.ts).
 *
 * 🔴 A PASSWORD IS WRITTEN AND NEVER READ BACK. Its hash goes up over HTTPS and nothing in this module
 * returns, logs or audits the password or the hash. The list read carries logins and roles only. If a
 * password is lost, it is replaced, not recovered.
 *
 * 🔴 AND THE REAL POINT, WHICH IS NOT OBVIOUS FROM THE FORM: anyone who can sign in to this console
 * can reach every tablet — lock them, wipe them, watch them. Phoenix's own permission matrix does not
 * reach across into a second system. That is why this route sits on `company_devices:approve`, Super
 * Admin only, and why every add and every removal writes a required audit row naming the login and the
 * role it was given.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { headwindPasswordHash } from "@/lib/devices/headwind/auth";
import { callHeadwind, HeadwindRequestError } from "@/lib/devices/headwind/client";

export class HeadwindUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindUserError";
  }
}

/** The audit writer — a parameter only so a test can read the row without a database. */
type AuditWriter = typeof writeRequiredAuditLog;

export const HEADWIND_ROLES_PATH = "/rest/private/users/roles";
export const HEADWIND_USERS_PATH = "/rest/private/users/all";

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

function roleOf(row: Record<string, unknown>): { id: number | null; name: string | null } {
  // The server's shape is `userRole: { id, name, … }`; a bare `userRoleId` is read only as a fallback.
  const role = row.userRole && typeof row.userRole === "object" ? (row.userRole as Record<string, unknown>) : null;
  const nested = role ? role.id : undefined;
  const flat = row.userRoleId;
  const id = typeof nested === "number" ? nested : typeof flat === "number" ? flat : null;
  return { id, name: asText(role ? role.name : null) };
}

export function consoleUsersFrom(raw: unknown, roles: readonly HeadwindConsoleRole[]): HeadwindConsoleUser[] {
  const rows = Array.isArray(raw) ? raw : [];
  const users: HeadwindConsoleUser[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (typeof row?.id !== "number") continue;
    const login = asText(row.login);
    if (!login) continue;
    const role = roleOf(row);
    users.push({
      email: asText(row.email),
      // `enabled` is absent on older rows; absent means in use, not switched off.
      enabled: row.enabled !== false,
      id: row.id,
      login,
      name: asText(row.name),
      roleId: role.id,
      // The server's list of roles names it; a role id it did not list stays unknown, never guessed.
      roleName: roles.find((entry) => entry.id === role.id)?.name ?? null,
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

async function readRoles(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv): Promise<HeadwindConsoleRole[]> {
  return consoleRolesFrom(await callHeadwind<unknown>(HEADWIND_ROLES_PATH, { method: "GET" }, fetchImpl, env));
}

async function readUserRows(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv): Promise<Array<Record<string, unknown>>> {
  const raw = await callHeadwind<unknown>(HEADWIND_USERS_PATH, { method: "GET" }, fetchImpl, env);
  return (Array.isArray(raw) ? raw : []).filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
  );
}

/** Who can sign in to the console, and what roles exist to give them. */
export async function getHeadwindConsoleUsers(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ users: HeadwindConsoleUser[]; roles: HeadwindConsoleRole[]; note: string }> {
  const [roles, rawUsers] = await Promise.all([readRoles(fetchImpl, env), readUserRows(fetchImpl, env)]);
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
 * The body the console itself sends for a NEW user — the shape `scripts/headwind-bootstrap.mjs`
 * measured against the live server. No `id`, so the server creates rather than updates.
 *
 * 🔴 THE PASSWORD GOES UP ONLY AS ITS UPPER-CASE MD5, in both `newPassword` and `confirmModal`, the
 * way `users.controller.js` sends it. Never the password itself.
 */
export function consoleUserCreateBody(input: {
  login: string;
  name: string;
  email: string | null;
  roleId: number;
  password: string;
}) {
  const wire = headwindPasswordHash(input.password);
  return {
    allConfigAvailable: true,
    allDevicesAvailable: true,
    configurations: null,
    confirmModal: wire,
    ...(input.email ? { email: input.email } : {}),
    groups: null,
    login: input.login,
    name: input.name,
    newPassword: wire,
    userRole: { id: input.roleId },
  };
}

/** The server's refusal keys for a create, in words a person can act on. */
function createRefusal(error: unknown, login: string): Error {
  if (error instanceof HeadwindRequestError) {
    if (/error\.duplicate\.login/i.test(error.message)) {
      return new HeadwindUserError(`A login named ${login} is already on the tablet server. Choose another name.`);
    }
    if (/error\.duplicate\.email/i.test(error.message)) {
      return new HeadwindUserError("That email is already on another login on the tablet server. Use another, or leave it blank.");
    }
  }
  return error instanceof Error ? error : new HeadwindRequestError(502, "The tablet server refused the new login.");
}

/**
 * Add a console login.
 *
 * Order: check the input, check the role against the server's own list, refuse a login that is already
 * there, create, READ IT BACK, then audit what the server now holds. Nothing claims "it is there" until
 * the read-back saw it with the role asked for.
 *
 * 🔴 THE PASSWORD IS NEVER PUT IN THE AUDIT ROW, THE RETURN VALUE OR ANY MESSAGE — nor is its hash.
 */
export async function createHeadwindConsoleUser(
  input: HeadwindUserInput,
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: AuditWriter = writeRequiredAuditLog,
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
  const name = input.name?.trim() || login;
  const email = input.email?.trim() || null;

  const [roles, before] = await Promise.all([readRoles(fetchImpl, env), readUserRows(fetchImpl, env)]);
  const role = roles.find((entry) => entry.id === input.roleId);
  if (!role) {
    throw new HeadwindUserError("That role is not one the tablet server has. Reload the page and choose again.");
  }
  if (before.some((row) => asText(row.login) === login)) {
    throw new HeadwindUserError(`A login named ${login} is already on the tablet server. Choose another name.`);
  }

  try {
    await callHeadwind(
      "/rest/private/users",
      { body: JSON.stringify(consoleUserCreateBody({ email, login, name, password: input.password, roleId: role.id })), method: "PUT" },
      fetchImpl,
      env,
    );
  } catch (error) {
    throw createRefusal(error, login);
  }

  // 🔴 THE READ-BACK. An OK envelope is not the login.
  const saved = (await readUserRows(fetchImpl, env)).find((row) => asText(row.login) === login) ?? null;
  const savedRole = saved ? roleOf(saved) : null;
  const confirmed = saved !== null && savedRole?.id === role.id;
  const mustChangePassword = saved?.passwordReset === true;
  const savedRoleName = roles.find((entry) => entry.id === savedRole?.id)?.name ?? null;
  const savedIdValue = saved ? saved.id : null;
  const savedId = typeof savedIdValue === "number" ? savedIdValue : null;

  // Audited whatever the read-back found: the server accepted a create, so a login may exist.
  await audit({
    actorLoginId: actor,
    entityId: login,
    entityType: "headwind_user",
    // 🔴 NO PASSWORD FIELD HERE, EVER — not the password, not its hash.
    newValues: {
      confirmedOnServer: confirmed,
      login,
      name,
      roleId: role.id,
      roleName: role.name,
      serverRoleId: savedRole?.id ?? null,
      serverUserId: savedId,
    },
    oldValues: null,
    summary: confirmed
      ? `Added the Headwind console login ${login} as ${role.name}`
      : saved
        ? `Asked for the Headwind console login ${login} as ${role.name}; the server holds it as ${savedRoleName ?? "an unknown role"}`
        : `Asked for the Headwind console login ${login}; the server answered OK but the login is not on it`,
  });

  if (!saved) {
    throw new HeadwindRequestError(
      502,
      `The tablet server answered OK, but no login named ${login} is on it when Phoenix reads the list back — ` +
        "so nothing was created. Try again, or add it in the tablet server's own console.",
    );
  }
  if (!confirmed) {
    throw new HeadwindRequestError(
      502,
      `${login} is on the tablet server, but as ${savedRoleName ?? "a role the server did not name"}, not ${role.name}. ` +
        "Remove it here and add it again, or change its role in the tablet server's own console.",
    );
  }

  return {
    login,
    message:
      `${login} is on the tablet server as ${role.name}` +
      (mustChangePassword
        ? ". The server will ask them to choose a new password the first time they sign in."
        : ", with the password you set.") +
      " Give them the password in person or over a private channel — it is not stored here and cannot be read back.",
  };
}

/**
 * Take a console login away.
 *
 * 🔴 THE LOGIN PHOENIX ITSELF SIGNS IN WITH IS NEVER REMOVED HERE. Upstream `deleteUser` has no
 * self-deletion check, and the list offered a Remove button beside every row — including the bridge's
 * own login, whose removal cuts Phoenix off from every tablet with no way back from this screen. The
 * server marks the caller's own row `editable: false`; that, or the login in `HEADWIND_MDM_LOGIN`, is
 * refused before anything is sent.
 *
 * The login named in the audit row and the reply is the SERVER's, read by id — never the one the
 * browser sent, which could name anyone.
 */
export async function removeHeadwindConsoleUser(
  input: { userId: number; login: string },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: AuditWriter = writeRequiredAuditLog,
): Promise<{ message: string }> {
  if (!Number.isInteger(input.userId)) throw new HeadwindUserError("Say which login to remove.");

  const row = (await readUserRows(fetchImpl, env)).find((candidate) => candidate.id === input.userId) ?? null;
  if (!row) {
    throw new HeadwindUserError("That login is not on the tablet server any more. Reload the page — nothing was removed.");
  }
  const login = asText(row.login) ?? String(input.userId);
  const bridgeLogin = env.HEADWIND_MDM_LOGIN?.trim() || null;
  if (row.editable === false || (bridgeLogin !== null && login === bridgeLogin)) {
    throw new HeadwindUserError(
      `${login} is the login Phoenix itself signs in to the tablet server with. Removing it would cut Phoenix ` +
        "off from every tablet, so it is not removed from here.",
    );
  }

  await callHeadwind(`/rest/private/users/other/${input.userId}`, { method: "DELETE" }, fetchImpl, env);

  // 🔴 THE READ-BACK. Gone means gone from the list, not an OK envelope.
  const stillThere = (await readUserRows(fetchImpl, env)).some((candidate) => candidate.id === input.userId);
  const role = roleOf(row);

  await audit({
    actorLoginId: actor,
    entityId: login,
    entityType: "headwind_user",
    newValues: stillThere ? { stillOnServer: true } : null,
    oldValues: { login, roleId: role.id, userId: input.userId },
    summary: stillThere
      ? `Asked to remove the Headwind console login ${login}; the server answered OK and still lists it`
      : `Removed the Headwind console login ${login}`,
  });

  if (stillThere) {
    throw new HeadwindRequestError(
      502,
      `The tablet server answered OK, but ${login} is still on its list when Phoenix reads it back — it can still sign in. ` +
        "Remove it in the tablet server's own console.",
    );
  }
  return { message: `${login} is no longer on the tablet server's list of logins.` };
}
