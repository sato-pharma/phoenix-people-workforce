import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { POST } from "../app/api/phoenix-crm/notices/seen/route.ts";
import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { markPhoenixCrmModuleNoticesRead } from "../src/lib/phoenix-crm/server/unread-notices.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A local preview never clears a person's Phoenix CRM "new" badge.
 *
 * Opening a module page mounts `PhoenixCrmNoticesSeen`, which POSTs /api/phoenix-crm/notices/seen when
 * the viewer has an unread notice. A local server's .env.local is the PRODUCTION database, so a driven
 * look under a real person's HR id (dev-auth, source "dev-header") marked that person's notices read
 * and the badge was gone before they ever saw it (noticed 1 Nov 2026).
 *
 * This drives the route itself with a real dev-header request, against a stand-in database that only
 * records what it is asked. The HR id belongs to nobody, and the stand-in answers every read with no
 * rows, so even with the guard removed this test cannot write anything to anyone.
 */

const STAND_IN_SETTINGS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://notices-seen-preview.invalid",
  NODE_ENV: "development",
  PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
  SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
};
const NOBODY = "PREVIEW-NOBODY";
const NOTIFICATION_TABLE = /\/rest\/v1\/notification_/;

/** Runs with the stand-in settings and a recording fetch, and puts the real ones back however it ends. */
async function withStandInDatabase(run: (asked: string[]) => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.keys(STAND_IN_SETTINGS).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  Object.assign(env, STAND_IN_SETTINGS);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(input instanceof Request ? input.url : String(input));
    return new Response("[]", { headers: { "content-type": "application/json" }, status: 200 });
  }) as typeof fetch;
  try {
    await run(asked);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

export async function runPhoenixCrmNoticesSeenPreviewTests() {
  await withStandInDatabase(async (asked) => {
    // The positive control: without it, a recording fetch that saw nothing could simply be a fetch the
    // writer never goes through, and the route's silence below would prove nothing.
    await markPhoenixCrmModuleNoticesRead(createAccessContext({ hrId: NOBODY, role: "Medical Rep", source: "dev-header" }), "plan");
    assert.ok(
      asked.some((url) => NOTIFICATION_TABLE.test(url)),
      `the writer reads the notification tables through this fetch, so this check can see it (asked: ${asked.join(", ") || "nothing"})`,
    );
    asked.length = 0;

    const response = await POST(
      new Request("http://localhost:3000/api/phoenix-crm/notices/seen", {
        body: JSON.stringify({ module: "plan" }),
        headers: {
          "content-type": "application/json",
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "x-phoenix-hr-id": NOBODY,
          "x-phoenix-role": "Medical Rep",
        },
        method: "POST",
      }),
    );

    assert.equal(response.status, 204, "a preview gets the same empty answer as everyone else, so the page behaves the same");
    assert.deepEqual(
      asked.filter((url) => NOTIFICATION_TABLE.test(url)),
      [],
      "a local preview must not reach the notification tables: the person has seen nothing, and this database is production",
    );
  });

  // The refusal is for a preview only. A real person's visit must still clear the badge, and a real
  // session cannot be minted without a database, so the call itself is pinned here.
  const route = stripComments(readFileSync("app/api/phoenix-crm/notices/seen/route.ts", "utf8"));
  const guardAt = route.indexOf("isPreviewSession(access)");
  const writeAt = route.indexOf("markPhoenixCrmModuleNoticesRead(access, moduleKey)");
  assert.ok(guardAt > -1 && writeAt > guardAt, "the route still clears the badge, after the preview check and only after it");
}
