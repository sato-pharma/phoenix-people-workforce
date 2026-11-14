import type { FullConfig } from "@playwright/test";

const PRODUCTION_HOST = "phoenix-hr.satopharma.com";

/**
 * Runs once before any journey opens a browser. Aborts the whole run with a
 * plain-English error instead of letting Playwright fail confusingly deep
 * inside a test — this is the production/mutation safety gate for the
 * synthetic journeys suite.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env.SYNTHETIC_BASE_URL;
  if (!baseURL) {
    throw new Error(
      "Missing required env var SYNTHETIC_BASE_URL. Set it to the URL of the environment to test " +
        "(e.g. http://localhost:3000) and re-run. See tests/synthetic/README.md.",
    );
  }

  let host: string;
  try {
    host = new URL(baseURL).host;
  } catch {
    throw new Error(`SYNTHETIC_BASE_URL is not a valid URL: "${baseURL}"`);
  }

  const allowProduction = process.env.SYNTHETIC_ALLOW_PRODUCTION === "true";
  if (host === PRODUCTION_HOST && !allowProduction) {
    throw new Error(
      `SYNTHETIC_BASE_URL points at production (${PRODUCTION_HOST}). Refusing to run. ` +
        "Set SYNTHETIC_ALLOW_PRODUCTION=true only if you explicitly intend to run these " +
        "read-only smoke journeys against production.",
    );
  }

  if (!process.env.SYNTHETIC_ADMIN_HR_ID || !process.env.SYNTHETIC_ADMIN_PASSWORD || !process.env.SYNTHETIC_ADMIN_TOTP_SECRET) {
    throw new Error(
      "Missing SYNTHETIC_ADMIN_HR_ID, SYNTHETIC_ADMIN_PASSWORD and/or SYNTHETIC_ADMIN_TOTP_SECRET. These must be set to a " +
        "Super Admin test account's credentials for the target environment, including its authenticator key " +
        "(a Super Admin's password sign-in also asks for a code). See tests/synthetic/README.md.",
    );
  }
}
