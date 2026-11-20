// How many compiled pages the dev server keeps, and for how long (owner, 2026-11-20: "I want the dev server
// to be super fast"). Off unless asked; when asked, next.config.ts hands Next both fields; and the installed
// Next still reads them, or the switch would silently do nothing.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  NEXT_DEFAULT_IDLE_MS,
  NEXT_DEFAULT_PAGES_KEPT,
  resolvePageRetention,
} from "../scripts/dev-server-page-retention.mjs";

function testTheSwitches() {
  assert.equal(resolvePageRetention({}), null, "nothing set: Next keeps its own defaults");
  assert.equal(resolvePageRetention({ PHOENIX_DEV_PAGES_KEPT: "", PHOENIX_DEV_PAGE_IDLE_MINUTES: " " }), null, "blank is unset");
  assert.deepEqual(
    resolvePageRetention({ PHOENIX_DEV_PAGES_KEPT: "8" }),
    { pagesBufferLength: 8, maxInactiveAge: NEXT_DEFAULT_IDLE_MS },
    "only the count set: the idle time stays Next's one minute",
  );
  assert.deepEqual(
    resolvePageRetention({ PHOENIX_DEV_PAGE_IDLE_MINUTES: "30" }),
    { pagesBufferLength: NEXT_DEFAULT_PAGES_KEPT, maxInactiveAge: 30 * 60_000 },
    "only the minutes set: the count stays Next's five",
  );
  assert.deepEqual(resolvePageRetention({ PHOENIX_DEV_PAGES_KEPT: "6", PHOENIX_DEV_PAGE_IDLE_MINUTES: "45" }), {
    pagesBufferLength: 6,
    maxInactiveAge: 45 * 60_000,
  });
  for (const bad of ["0", "-3", "2.5", "eight", "51"]) {
    assert.equal(resolvePageRetention({ PHOENIX_DEV_PAGES_KEPT: bad }), null, `a count of ${JSON.stringify(bad)} is ignored, never a half-read`);
  }
  assert.equal(resolvePageRetention({ PHOENIX_DEV_PAGE_IDLE_MINUTES: "1441" }), null, "more than a day is ignored");
}

function testTheConfigAndTheInstalledNext() {
  const config = readFileSync(resolve("next.config.ts"), "utf8");
  assert.match(config, /const devPageRetention = isProduction \? null : resolvePageRetention\(\);/, "never read in production");
  assert.match(config, /\.\.\.\(devPageRetention \? \{ onDemandEntries: devPageRetention \} : \{\}\)/, "handed to Next only when asked");

  const nextDir = dirname(createRequire(import.meta.url).resolve("next/package.json"));
  const read = (file: string) => readFileSync(join(nextDir, "dist", ...file.split("/")), "utf8");
  assert.match(read("server/config-shared.js"), /maxInactiveAge: 60 \* 1000,\s*pagesBufferLength: 5/, "Next's defaults are still 60 s and 5 pages");
  assert.match(read("server/dev/hot-reloader-webpack.js"), /\.\.\.this\.config\.onDemandEntries/, "the webpack dev server still reads onDemandEntries");
  assert.match(read("server/config-schema.js"), /onDemandEntries: _zod\.z\.strictObject\(\{\s*maxInactiveAge: _zod\.z\.number\(\)\.optional\(\),\s*pagesBufferLength: _zod\.z\.number\(\)\.optional\(\)/, "both fields still pass Next's config validation");
}

export function runDevServerPageRetentionTests() {
  testTheSwitches();
  testTheConfigAndTheInstalledNext();
}
