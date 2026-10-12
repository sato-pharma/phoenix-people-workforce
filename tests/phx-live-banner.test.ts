import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isPhxLive, phxLiveDataSource, PHOENIX_PRODUCTION_PROJECT_REF } from "../src/lib/phx-live.ts";
import { stripComments } from "./support/comment-strip.ts";

// phx-live is the owner's dev server on the Hetzner box. The strip is how he can tell that tab from
// the real site at a glance — and it must never appear on the real site, nor claim production data
// over a staging copy. Account: docs/agents-worktree-and-machine-limits.md, "phx-live".
export function runPhxLiveBannerTests() {
  // The gate: exactly PHX_LIVE=1, nothing else. Production and staging have no PHX_LIVE at all.
  assert.equal(isPhxLive({}), false, "no PHX_LIVE must mean no banner — that is production and staging");
  assert.equal(isPhxLive({ PHX_LIVE: "0" }), false);
  assert.equal(isPhxLive({ PHX_LIVE: "" }), false);
  assert.equal(isPhxLive({ PHX_LIVE: "true" }), false, "only live-ctl.sh's exact PHX_LIVE=1 turns it on");
  assert.equal(isPhxLive({ PHX_LIVE: "1" }), true);

  // 🔴 The strip names the DATABASE. The box is installed on staging keys and switched to production
  // by `phx-live -InstallEnv`, so a strip that reads PHX_LIVE alone announces production data over a
  // staging copy.
  const prod = phxLiveDataSource({ SUPABASE_PROJECT_REF: PHOENIX_PRODUCTION_PROJECT_REF });
  assert.equal(prod.kind, "production");
  assert.match(prod.label, /PRODUCTION DATA/);
  assert.match(prod.label, /NOT sent/, "it must say the emails and notifications do not leave");
  for (const [label, env] of [
    ["the staging project", { SUPABASE_PROJECT_REF: "cifwmndunmlxjhyjugxa" }],
    ["the url form of staging", { NEXT_PUBLIC_SUPABASE_URL: "https://cifwmndunmlxjhyjugxa.supabase.co" }],
    ["no project at all", {}],
  ] as ReadonlyArray<readonly [string, Record<string, string | undefined>]>) {
    const other = phxLiveDataSource(env);
    assert.equal(other.kind, "other", label + " must NOT read as production");
    assert.ok(!/^PRODUCTION DATA/.test(other.label), label + " must not be announced as production data");
  }
  // The URL form of production counts too — install-env keeps both keys, but only one is guaranteed.
  assert.equal(
    phxLiveDataSource({ NEXT_PUBLIC_SUPABASE_URL: `https://${PHOENIX_PRODUCTION_PROJECT_REF}.supabase.co` }).kind,
    "production",
  );

  const root = path.resolve(import.meta.dirname, "..");
  const banner = stripComments(readFileSync(path.join(root, "src/components/layout/phx-live-banner.tsx"), "utf8"));
  const layout = stripComments(readFileSync(path.join(root, "app/layout.tsx"), "utf8"));

  assert.match(
    banner,
    /if \(!isPhxLive\(\)\) return null;/,
    "the banner must render NOTHING unless isPhxLive() — otherwise it ships to every production page",
  );
  assert.match(banner, /phxLiveDataSource\(\)/, "the banner must read the project, not just the PHX_LIVE flag");
  assert.ok(!/rounded-(?!none)/.test(banner), "the banner must keep square edges");
  assert.match(layout, /<PhxLiveBanner \/>/, "app/layout.tsx must render the banner, or phx-live has none");
  assert.ok(!/["']use client["']/.test(banner), "the banner must stay server-rendered, so it reads the box's env");
}
