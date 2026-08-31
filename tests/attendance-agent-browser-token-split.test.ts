import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-pinning, deliberately. The invariant is "a particular secret never reaches a particular
// file", and nothing you can call at runtime can observe that: the page is a server component whose
// props are serialized into the RSC payload, so the leak is visible only in what the file asks for.
// Matching on whole identifiers rather than byte offsets, so the pins survive the file moving.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const MAPPING_PAGE = "app/(admin)/attendance/device-user-mapping/page.tsx";
const MANAGER = "src/components/attendance/device-user-mapping-manager.tsx";
const RAW_PUNCHES = "app/api/attendance/raw-punches/route.ts";
const AGENT = "local-attendance-agent/Program.cs";

export function runAttendanceAgentBrowserTokenSplitTests() {
  const page = read(MAPPING_PAGE);
  const rawPunches = read(RAW_PUNCHES);
  const agent = read(AGENT);

  // The premise. If raw-punches ever stops being authenticated by this bare token, the rest of this
  // file is pinning a rule whose reason has moved, so assert the reason rather than assuming it.
  assert.ok(
    rawPunches.includes("process.env.ATTENDANCE_AGENT_TOKEN"),
    `${RAW_PUNCHES} is expected to gate on ATTENDANCE_AGENT_TOKEN alone — if that changed, revisit why the browser must not hold it`,
  );

  // The actual regression. This page hands a token to a client component, so whatever it reads here
  // ends up in view-source for every user who can open the page.
  assert.ok(
    !page.includes("process.env.ATTENDANCE_AGENT_TOKEN"),
    `${MAPPING_PAGE} must never read ATTENDANCE_AGENT_TOKEN: it is the sole credential on POST /api/attendance/raw-punches, so shipping it to the browser lets any reader write attendance straight into payroll`,
  );
  assert.ok(
    page.includes("process.env.ATTENDANCE_AGENT_BROWSER_TOKEN"),
    `${MAPPING_PAGE} should pass the weaker ATTENDANCE_AGENT_BROWSER_TOKEN instead`,
  );

  // The manager must not reach for the strong token by any route either.
  assert.ok(
    !read(MANAGER).includes("ATTENDANCE_AGENT_TOKEN"),
    `${MANAGER} runs in the browser and must never name ATTENDANCE_AGENT_TOKEN`,
  );

  // Agent side: the weaker token buys /sync-now and nothing else. Every other endpoint reads the
  // fingerprint device or its enrolments and stays on the full agent token.
  const browserTokenAuthLines = agent
    .split("\n")
    .filter((line) => line.includes("cfg.AttendanceAgentBrowserToken"));
  assert.equal(
    browserTokenAuthLines.length,
    1,
    "exactly one endpoint may accept the browser token; found: " + JSON.stringify(browserTokenAuthLines),
  );
  assert.ok(
    browserTokenAuthLines[0].includes("IsAuthorizedForAny"),
    "the browser token must be accepted through IsAuthorizedForAny, alongside the agent token, never on its own",
  );

  // …and that one endpoint is /sync-now. Take the auth line's position and walk back to the nearest
  // route registration above it, so this keeps working when endpoints are reordered.
  const authIndex = agent.indexOf("cfg.AttendanceAgentBrowserToken");
  const routeBefore = agent.slice(0, authIndex).lastIndexOf("app.Map");
  const routeLine = agent.slice(routeBefore, agent.indexOf("\n", routeBefore));
  assert.ok(
    routeLine.includes('"/sync-now"'),
    `the browser token must guard /sync-now only, but it guards: ${routeLine.trim()}`,
  );

  // The two tokens being equal would rebuild the hole while every name still claimed otherwise, so
  // the agent refuses to start on that. Pin the guard, not just the comment describing it.
  assert.ok(
    agent.includes("must not be the same value as ATTENDANCE_AGENT_TOKEN"),
    "AgentConfig must refuse to start when ATTENDANCE_AGENT_BROWSER_TOKEN equals ATTENDANCE_AGENT_TOKEN",
  );
}
