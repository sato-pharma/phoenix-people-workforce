/**
 * Server-only configuration for the iReports360 Reporting API integration.
 *
 * This is the canonical home for the CRM connection config. Values are read from
 * environment variables and MUST NOT be exposed to the browser (no `NEXT_PUBLIC_`
 * prefix). They are consumed only by the CRM module's server-side pull code
 * (`src/lib/crm/*`).
 */

const DEFAULT_TIMEOUT_MS = 30000;

export type IReports360Config = {
  baseUrl: string;
  password: string;
  timeoutMs: number;
  username: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required for the iReports360 integration.`);
  }
  return value.trim();
}

/** Returns true when all iReports360 secrets are present (used to gate UI/affordances). */
export function isIReports360Configured(): boolean {
  return Boolean(
    process.env.IREPORTS360_BASE_URL &&
      process.env.IREPORTS360_USERNAME &&
      process.env.IREPORTS360_PASSWORD,
  );
}

/** Reads and validates the iReports360 connection config. Throws if a secret is missing. */
export function getIReports360Config(): IReports360Config {
  const rawTimeout = Number(process.env.IREPORTS360_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return {
    baseUrl: requiredEnv("IREPORTS360_BASE_URL").replace(/\/+$/, ""),
    password: requiredEnv("IREPORTS360_PASSWORD"),
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS,
    username: requiredEnv("IREPORTS360_USERNAME"),
  };
}
