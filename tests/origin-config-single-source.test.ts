import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { systemDeployment } from "../src/config/system-settings.ts";
import { isAllowedPhoenixOrigin } from "../src/lib/security/origins.ts";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/**
 * Architecture cleanup (Finding 5): the production URL must have a single edit point.
 *
 * The security CSRF/CORS allowlist (`src/lib/security/origins.ts`) used to hardcode
 * `https://phoenix-workforce.vercel.app` separately from `systemDeployment.productionUrl`,
 * so a domain change needed two edits and could silently drift. These tests pin the
 * allowlist to the deploy config so the two can never diverge again.
 */
export function runOriginConfigSingleSourceTests() {
  const origins = source("../src/lib/security/origins.ts");

  // The allowlist must DERIVE the production + working-preview origins from system-settings.
  assert.match(
    origins,
    /systemDeployment\.productionUrl/,
    "origins.ts must derive the production origin from systemDeployment.productionUrl",
  );
  assert.match(
    origins,
    /systemDeployment\.workingPreviewUrl/,
    "origins.ts must derive the working-preview origin from systemDeployment.workingPreviewUrl",
  );

  // ...and must NOT re-hardcode the production URL literal.
  assert.doesNotMatch(
    origins,
    /const productionOrigin\s*=\s*"https/,
    "origins.ts must not re-hardcode the production URL literal — derive it from systemDeployment",
  );

  // Behavioural guard: whatever the configured production/working URLs are, the CSRF/CORS
  // allowlist must accept them as trusted Phoenix origins.
  assert.equal(
    isAllowedPhoenixOrigin(systemDeployment.productionUrl),
    true,
    "the configured production URL must be an allowed Phoenix origin",
  );
  assert.equal(
    isAllowedPhoenixOrigin(systemDeployment.workingPreviewUrl),
    true,
    "the configured working-preview URL must be an allowed Phoenix origin",
  );
}
