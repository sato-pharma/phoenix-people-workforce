import assert from "node:assert/strict";

import { reportClientError } from "../src/lib/error-monitor/report-client-error.ts";

// React #441 on Expense Submissions (System Audit, 31 Oct 2026). The page forwards every manager who
// files trips to Submit Expense with a server redirect(). A production browser receives that as
// "Minified React error #441" carrying the redirect's digest; Next.js follows it and nothing fails.
// On 29 Oct one District Manager's forward reached the page-wide listener, which passes no digest,
// and was filed as a crash while she landed on Submit Expense three seconds later. These tests throw
// the real errors Next.js throws, give them the browser's minified wording, and read what is posted.

const { redirect, permanentRedirect, notFound } = await import("next/navigation.js");

const MINIFIED_441 =
  "Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

function thrownBy(signal: () => never): { digest: string } {
  try {
    signal();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    assert.equal(typeof digest, "string", "Next.js marks its navigation errors with a digest");
    return { digest: digest as string };
  }
  throw new Error("the navigation call was expected to throw");
}

/** What the production browser holds: React's minified placeholder, with the server's digest on it. */
function browserCopy(digest: string): Error {
  return Object.assign(new Error(MINIFIED_441), { digest });
}

export async function runClientErrorRouterNavigationTests() {
  const navigations = [
    { name: "the Expense Submissions forward", ...thrownBy(() => redirect("/employee-portals/submit-expense#my-claims")) },
    { name: "a permanent redirect", ...thrownBy(() => permanentRedirect("/employee-portals")) },
    { name: "a not-found page", ...thrownBy(() => notFound()) },
  ];

  const originalFetch = globalThis.fetch;
  const posted: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    posted.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    for (const navigation of navigations) {
      // The page-wide listener's call: the thrown object and a route, no digest argument.
      reportClientError({ error: browserCopy(navigation.digest), route: "/employee-portals/expense-submissions" });
      assert.equal(posted.length, 0, `🔴 ${navigation.name} is navigation, never a crash — the digest on the error is enough`);
      // An error boundary's call: the digest as an argument, whatever the error object is.
      reportClientError({ digest: navigation.digest, error: "opaque", route: "/employee-portals/expense-submissions" });
      assert.equal(posted.length, 0, `🔴 ${navigation.name}: the digest argument alone is enough`);
    }

    // A real server-render failure is still filed — and, from the listener, now WITH its digest, so
    // the browser copy can be matched to what the server recorded.
    reportClientError({ error: browserCopy("1635479752"), route: "/employee-portals/expense-submissions" });
    assert.equal(posted.length, 1, "any other #441 is still a crash and is still reported");
    assert.equal(posted[0]?.digest, "1635479752", "🔴 the error's own digest is posted when the caller passed none");

    reportClientError({ digest: "2001", error: browserCopy("1635479752"), route: "/x" });
    assert.equal(posted[1]?.digest, "2001", "a digest the caller passes wins over the one on the error");

    reportClientError({ error: new Error("plain failure"), route: "/x" });
    assert.equal(posted[2]?.digest, null, "an error with no digest anywhere posts none");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
