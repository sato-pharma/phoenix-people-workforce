// Master Map — the thin Google Sheets client.
//
// Deliberately NOT the `googleapis` package: this feature makes two kinds of call (write values,
// apply formatting) and that dependency is tens of megabytes for the privilege. Node's own crypto
// signs the RS256 assertion, and fetch does the rest.
//
// AUTH IS PLUGGABLE ON PURPOSE. The org policy on the owner's Google Cloud org
// (constraints/iam.disableServiceAccountKeyCreation) blocks long-lived service-account keys, and
// the decision on how to authenticate in production is still open. Everything above this file is
// written against `GoogleTokenProvider`, so whichever route is chosen — a key, impersonation, or
// workload identity federation — nothing else has to change.

import { createSign } from "node:crypto";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export type GoogleTokenProvider = () => Promise<string>;

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
};

function base64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Exchange a service-account key for an access token (the standard JWT bearer flow).
 * `nowSeconds` is injectable so the assertion can be tested without freezing the clock globally.
 */
export async function mintServiceAccountToken(
  key: ServiceAccountKey,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      aud: TOKEN_ENDPOINT,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
      iss: key.client_email,
      scope: SHEETS_SCOPE,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${base64Url(signer.sign(key.private_key))}`;

  const response = await fetch(TOKEN_ENDPOINT, {
    body: new URLSearchParams({
      assertion,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    // The sign-in exchange is one small request; fifteen seconds is generous (integration audit, 13 Nov 2026, ISS-011).
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Google token exchange returned no access_token");
  return payload.access_token;
}

/**
 * The provider Phoenix uses at runtime.
 *
 * MASTER_MAP_GOOGLE_ACCESS_TOKEN wins when set — that is the local/impersonated path, used to
 * develop and verify against the real sheet without any key existing anywhere.
 * MASTER_MAP_GOOGLE_KEY holds the service-account JSON, base64-encoded. Base64 is not decoration:
 * the key is multi-line and Railway's variable paste has silently eaten the following KEY=VALUE
 * when given raw newlines, and `--stdin` prepends a BOM that makes the JSON unparseable.
 */
export function environmentTokenProvider(env: NodeJS.ProcessEnv = process.env): GoogleTokenProvider {
  return async () => {
    const direct = env.MASTER_MAP_GOOGLE_ACCESS_TOKEN?.trim();
    if (direct) return direct;

    const encoded = env.MASTER_MAP_GOOGLE_KEY?.trim();
    if (!encoded) {
      throw new Error(
        "No Google credential: set MASTER_MAP_GOOGLE_KEY (base64 service-account JSON) or MASTER_MAP_GOOGLE_ACCESS_TOKEN.",
      );
    }
    const raw = encoded.startsWith("{")
      ? encoded
      : Buffer.from(encoded, "base64").toString("utf8");
    // A leading BOM survives several copy paths and makes JSON.parse fail with a message that
    // points at character 0 and explains nothing. Strip it rather than debug it again.
    const key = JSON.parse(raw.replace(/^﻿/, "")) as ServiceAccountKey;
    return mintServiceAccountToken(key);
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Google allows 60 write requests per minute per user, and a full workbook sync sits right on
 * that line. A 429 here is normal operation, not a failure — back off and continue, otherwise a
 * sync that is 90% finished throws away everything it has done.
 * 5xx is retried on the same reasoning.
 */
async function callSheets(
  token: string,
  path: string,
  init: { body?: unknown; method: string; query?: Record<string, string> },
  attempt = 0,
): Promise<unknown> {
  const url = new URL(`${SHEETS_API}${path}`);
  for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);

  const response = await fetch(url, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: init.method,
    // A sheet write can be large, so a minute a try; without it one stalled connection held the
    // whole push with the retry ladder below never reached (integration audit, 13 Nov 2026, ISS-011).
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status === 429 || response.status >= 500) {
    if (attempt >= 5) {
      throw new Error(
        `Sheets ${init.method} ${path} still failing after ${attempt} retries (${response.status}): ${await response.text()}`,
      );
    }
    // 2s, 4s, 8s, 16s, 32s — comfortably past the one-minute quota window.
    await sleep(2000 * 2 ** attempt);
    return callSheets(token, path, init, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Sheets ${init.method} ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

export type SheetTabInfo = { sheetId: number; title: string };

export async function getSpreadsheet(
  token: string,
  spreadsheetId: string,
): Promise<{ tabs: SheetTabInfo[]; title: string }> {
  const payload = (await callSheets(token, `/${spreadsheetId}`, {
    method: "GET",
    query: { fields: "properties.title,sheets.properties(sheetId,title)" },
  })) as {
    properties: { title: string };
    sheets: Array<{ properties: { sheetId: number; title: string } }>;
  };
  return {
    tabs: payload.sheets.map((sheet) => ({
      sheetId: sheet.properties.sheetId,
      title: sheet.properties.title,
    })),
    title: payload.properties.title,
  };
}

/**
 * Run a batch of structural/formatting requests.
 *
 * Chunked because the API rejects an oversized request outright, and a 50,000-row sheet produces
 * far more merge and format requests than one call can carry.
 */
export async function batchUpdate(
  token: string,
  spreadsheetId: string,
  requests: readonly unknown[],
  chunkSize = 500,
): Promise<void> {
  for (let index = 0; index < requests.length; index += chunkSize) {
    const slice = requests.slice(index, index + chunkSize);
    if (slice.length === 0) continue;
    await callSheets(token, `/${spreadsheetId}:batchUpdate`, {
      body: { requests: slice },
      method: "POST",
    });
  }
}

/** Write a rectangle of text starting at A1 of the named tab. */
export async function writeValues(
  token: string,
  spreadsheetId: string,
  tabTitle: string,
  values: readonly (readonly string[])[],
  chunkRows = 5000,
): Promise<void> {
  for (let start = 0; start < values.length; start += chunkRows) {
    const slice = values.slice(start, start + chunkRows);
    const range = `'${tabTitle.replace(/'/g, "''")}'!A${start + 1}`;
    await callSheets(token, `/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
      body: { values: slice },
      method: "PUT",
      query: { valueInputOption: "RAW" },
    });
  }
}
