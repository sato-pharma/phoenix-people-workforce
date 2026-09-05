import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { systemDeployment } from "../src/config/system-settings.ts";
import { trustedOriginForRedirect } from "../src/lib/security/origins.ts";

/**
 * The premium Monthly Closing workbook's Export PDF hyperlink must carry a PUBLIC origin.
 *
 * A `.xlsx` cannot hold code, so Export PDF ships as a `HYPERLINK()` to the PDF renderer and the
 * origin is baked into the file at export time. It first shipped as `new URL(request.url).origin`,
 * which behind Railway's proxy is the container's own bind address: every link came out as
 * `https://0.0.0.0:8080/…` and opened nothing. The same defect had already been found and fixed
 * twice, in the CV-lifecycle and marketing-request share feeds.
 *
 * Those two could hard-code the production URL because each has exactly one consumer. This one
 * cannot: a workbook exported from staging must keep pointing at staging, or its reader compares a
 * PDF against production numbers that are not the ones in their hands.
 */
export function runClosingWorkbookLinkOriginTests() {
  const canonical = systemDeployment.productionUrl;
  const savedAllowed = process.env.PHOENIX_ALLOWED_ORIGINS;

  // The Railway shape: the request URL is the container's internal listener, and the public host
  // arrives only on the forwarded header.
  const internalUrl = "https://0.0.0.0:8080/api/sales/monthly-closing/premium-export";

  try {
    process.env.PHOENIX_ALLOWED_ORIGINS = canonical;

    // THE HEADLINE. The bind address must never reach the workbook, with or without a forwarded
    // host — a reader who clicks Export PDF has to land on a host that answers.
    const proxied = new Request(internalUrl, {
      headers: { "x-forwarded-host": "phoenix-hr.satopharma.com", "x-forwarded-proto": "https" },
    });
    assert.equal(
      trustedOriginForRedirect(proxied),
      canonical,
      "behind the proxy the workbook link must resolve to the public domain, never the 0.0.0.0 bind address",
    );

    const bare = new Request(internalUrl);
    const bareOrigin = trustedOriginForRedirect(bare);
    assert.equal(
      bareOrigin,
      canonical,
      "with no forwarded host the link falls back to the production domain rather than to a dead one",
    );
    assert.doesNotMatch(
      bareOrigin,
      /0\.0\.0\.0/,
      "the container bind address must never be baked into an exported workbook",
    );

    // The reason this route cannot simply hard-code production, pinned so a later simplification
    // has to argue with a red test rather than with a comment: a staging export stays on staging.
    const staging = "https://phoenix-people-workforce-staging.up.railway.app";
    process.env.PHOENIX_ALLOWED_ORIGINS = staging;
    const stagingRequest = new Request(internalUrl, {
      headers: { "x-forwarded-host": "phoenix-people-workforce-staging.up.railway.app", "x-forwarded-proto": "https" },
    });
    assert.equal(
      trustedOriginForRedirect(stagingRequest),
      staging,
      "a workbook exported from staging must send its reader back to staging, never to production",
    );

    // A forged host is still refused here, exactly as it is for a password-setup link: the workbook
    // goes to the people who trust these numbers most, so its links are not caller-steerable.
    process.env.PHOENIX_ALLOWED_ORIGINS = canonical;
    const forged = new Request(internalUrl, {
      headers: { "x-forwarded-host": "evil.attacker.example", "x-forwarded-proto": "https" },
    });
    assert.equal(
      trustedOriginForRedirect(forged),
      canonical,
      "an unrecognised forwarded host cannot aim the workbook's links at a host we do not serve",
    );
  } finally {
    if (savedAllowed === undefined) delete process.env.PHOENIX_ALLOWED_ORIGINS;
    else process.env.PHOENIX_ALLOWED_ORIGINS = savedAllowed;
  }

  // And the route must actually use the validated helper. Asserted on the ASSIGNMENT, because the
  // rejected form is named in the comment above it and a bare substring sweep would match that.
  const routeSource = readFileSync(
    "app/api/sales/monthly-closing/premium-export/route.ts",
    "utf8",
  );
  assert.match(
    routeSource,
    /const origin = trustedOriginForRedirect\(request\);/,
    "the workbook's PDF link origin must come from the allow-list validated helper",
  );
  assert.doesNotMatch(
    routeSource,
    /const origin\s*=\s*\n?\s*new URL\(request\.url\)\.origin/,
    "the PDF link origin must not be rebuilt from the request URL, which is the container's bind address",
  );
}
