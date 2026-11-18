import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GET } from "../app/api/healthz/route.ts";
import { stripComments } from "./support/comment-strip.ts";

// 18 Nov 2026: a key was swapped on Railway and nothing could say whether the servers had picked it up. A
// variable change redeploys the SAME commit, so `/api/healthz` `revision` does not move; the process's start
// time does. Calls the real handler, which reads nothing but the process and the build marker.

type Health = { revision: string | null; startedAt: string; status: string; time: string };

export async function runHealthzStartedAtTests() {
  const first = (await (await GET()).json()) as Health;
  const second = (await (await GET()).json()) as Health;

  assert.equal(first.status, "ok");
  assert.match(first.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/, "an ISO time, to the second");
  assert.equal(second.startedAt, first.startedAt, "the same process answers the same start on every request");
  assert.ok(Date.parse(first.startedAt) <= Date.parse(first.time), "a process cannot start after it answers");

  // The process's start, not the first request's: this suite has been running for a while by now.
  const fromUptime = Date.now() - process.uptime() * 1000;
  assert.ok(
    Math.abs(Date.parse(first.startedAt) - fromUptime) < 2_000,
    `startedAt must be the process's own start (${first.startedAt}), not when the route was first loaded`,
  );

  const source = stripComments(readFileSync("app/api/healthz/route.ts", "utf8"));
  assert.ok(source.includes("process.uptime()"), "taken from the process's uptime");
  assert.ok(source.includes("startedAt: STARTED_AT"), "computed once, at load, not per request");
}
