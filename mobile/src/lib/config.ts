import Constants from "expo-constants";

/**
 * Which Phoenix server this build talks to.
 *
 * Production by default, on purpose. A build handed to an employee must never need configuring, and
 * a forgotten environment variable should leave the app pointing at the live system rather than at
 * nothing. Development overrides it through `EXPO_PUBLIC_PHOENIX_API_URL` in `mobile/.env.local`.
 *
 * Reading `extra.phoenixApiUrl` first lets an EAS build profile pin a URL per channel (a staging
 * build, say) without touching the source. `Constants.expoConfig` is null in some bare/production
 * paths, hence the optional chaining rather than a non-null assertion.
 *
 * There are NO credentials here and there must never be any. A published app's bundle is readable
 * by anyone who installs it, so an API key shipped in it is an API key given away. Everything this
 * app can do, it does with the signed-in employee's own session and their own permissions — the
 * same permissions the server would enforce for them in a browser.
 */
const PRODUCTION_API_URL = "https://phoenix-hr.satopharma.com";

function resolveApiBaseUrl(): string {
  const fromExtra = Constants.expoConfig?.extra?.phoenixApiUrl;
  if (typeof fromExtra === "string" && fromExtra.trim().length > 0) {
    return fromExtra.trim().replace(/\/+$/, "");
  }

  const fromEnv = process.env.EXPO_PUBLIC_PHOENIX_API_URL;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim().replace(/\/+$/, "");
  }

  return PRODUCTION_API_URL;
}

export const apiBaseUrl = resolveApiBaseUrl();

/** True when this build talks to the live system — used to label non-production builds on screen. */
export const isProductionTarget = apiBaseUrl === PRODUCTION_API_URL;

/**
 * Value sent in the `x-phoenix-client` header. Its presence is what makes the login route return a
 * session token instead of relying on a cookie; the value itself is only ever read by humans in an
 * audit row, so it is descriptive rather than parsed.
 */
export const nativeClientId = "phoenix-android";
