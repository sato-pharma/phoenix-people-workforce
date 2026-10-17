import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describeThrown } from "../src/lib/error-monitor/describe-thrown.ts";
import {
  SUPABASE_UNREACHABLE_FINGERPRINT,
  SUPABASE_UNREACHABLE_TITLE,
  classifySupabaseUnreachable,
} from "../src/lib/error-monitor/supabase-unreachable.ts";
import { scrubSentryEvent, scrubSentryLog, type ScrubbableSentryEvent } from "../src/lib/observability/sentry-policy.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A Supabase outage is ONE named issue, "Supabase unreachable" (owner, 2026-10-17).
 *
 * One database restart at 12:30 Cairo filed four Sentry issues — two of them titled with a whole Cloudflare
 * "521: Web server is down" / "525: SSL handshake failed" page, one a digest-only render error, one an
 * unhandled heartbeat 500 — and the same markup filled `app_error_events.message`. The classifier is pure and
 * import-free, so every sink (the Sentry scrubber, the error-table writer, the heartbeat route) asks the same
 * function and a restart reads as one incident.
 *
 * What is held here: the real Cloudflare page is recognised in all three shapes it arrives in; ONLY that page
 * matches (a browser "Failed to fetch", the client's own timeout and a PostgREST error must stay what they
 * are); an event is renamed and fingerprinted but never dropped; and the three sinks call the one function.
 */

function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

/** Cloudflare's page for a Supabase project, trimmed to the parts that matter — the title carries the code. */
function edgePage(status: number, words: string): string {
  return [
    "<!DOCTYPE html>",
    '<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->',
    '<html class="no-js" lang="en-US">',
    "<head>",
    "",
    `<title>supabase.co | ${status}: ${words}</title>`,
    '<meta charset="UTF-8" />',
    "</head>",
    '<body><div id="cf-wrapper"><h1>' + words + "</h1></div></body>",
    "</html>",
  ].join("\n");
}

/** The scrubber is generic over the event it is given; the tests read fields it adds, so they hold the wide type. */
function scrub(event: ScrubbableSentryEvent): ScrubbableSentryEvent {
  return scrubSentryEvent(event);
}

function classifierTests() {
  const down = classifySupabaseUnreachable(edgePage(521, "Web server is down"));
  assert.ok(down, "a Cloudflare 521 page is Supabase being unreachable");
  assert.equal(down.status, 521);
  assert.equal(down.label, "Web server is down");
  assert.equal(down.summary, "Cloudflare 521: Web server is down");
  assert.equal(down.line, "Supabase unreachable: Cloudflare 521: Web server is down");

  const handshake = classifySupabaseUnreachable(edgePage(525, "SSL handshake failed"));
  assert.equal(handshake?.status, 525);
  assert.equal(handshake?.label, "SSL handshake failed");
  assert.equal(classifySupabaseUnreachable(edgePage(520, "Unknown error"))?.status, 520);
  assert.equal(classifySupabaseUnreachable(edgePage(522, "Connection timed out"))?.status, 522);

  // The shape postgrest-js hands back and this codebase rethrows: a plain object whose message is the page.
  const wrapped = describeThrown({ message: edgePage(521, "Web server is down"), details: "", hint: "", code: "" });
  assert.ok(wrapped.startsWith("{"), "a thrown object is described as JSON, with the page escaped inside it");
  assert.equal(classifySupabaseUnreachable(wrapped)?.summary, "Cloudflare 521: Web server is down");
  // …and the same page flattened into one line, the way a console log prints it.
  assert.equal(
    classifySupabaseUnreachable(edgePage(525, "SSL handshake failed").replace(/\n/g, " "))?.summary,
    "Cloudflare 525: SSL handshake failed",
  );
  // A subdomain in front of the host is still Supabase.
  assert.equal(classifySupabaseUnreachable("<title>abcdefgh.supabase.co | 503: Service unavailable</title>")?.status, 503);
}

function nonMatchTests() {
  // Only the exact Cloudflare title is this. Everything else keeps its own name and its own issue.
  for (const text of [
    "Failed to fetch",
    "Load failed",
    "Connection closed.",
    "Supabase request timed out.",
    '{"code":"42703","message":"column phoenix_crm_visit_recordings.id does not exist"}',
    "<title>example.com | 521: Web server is down</title>",
    "<title>supabase.co | 404: Not found</title>",
    "supabase.co is a database",
    "",
  ]) {
    assert.equal(classifySupabaseUnreachable(text), null, `${JSON.stringify(text)} must not be named a Supabase outage`);
  }
  for (const notText of [null, undefined, 521, {}, ["supabase.co | 521: Web server is down"]]) {
    assert.equal(classifySupabaseUnreachable(notText), null, "a non-string is never classified");
  }
}

function sentryEventTests() {
  const fingerprint = [...SUPABASE_UNREACHABLE_FINGERPRINT];

  // (a) an exception whose value is the JSON-wrapped page — the shape of the first Sentry issue.
  const wrapped = describeThrown({ message: edgePage(521, "Web server is down") });
  const exceptionEvent = scrub({
    exception: { values: [{ type: "Error", value: wrapped }] },
    user: { id: "B-10" },
  });
  assert.deepEqual(exceptionEvent.fingerprint, fingerprint, "every outage page lands in the one issue");
  assert.equal(exceptionEvent.exception?.values?.[0]?.type, SUPABASE_UNREACHABLE_TITLE);
  assert.equal(exceptionEvent.exception?.values?.[0]?.value, "Cloudflare 521: Web server is down");
  assert.equal(exceptionEvent.tags?.supabase_edge_status, "521");
  assert.equal("user" in exceptionEvent, false, "the existing scrub still runs");
  assert.ok(!JSON.stringify(exceptionEvent).includes("DOCTYPE"), "the page itself is replaced, not kept beside the name");

  // (b) a captureMessage whose text is the bare page — the shape of the 525 issue.
  const messageEvent = scrub({
    message: edgePage(525, "SSL handshake failed").replace(/\n/g, " "),
    logentry: { message: edgePage(525, "SSL handshake failed") },
  });
  assert.deepEqual(messageEvent.fingerprint, fingerprint);
  assert.equal(messageEvent.message, "Supabase unreachable: Cloudflare 525: SSL handshake failed");
  assert.equal(messageEvent.logentry?.message, "Supabase unreachable: Cloudflare 525: SSL handshake failed");
  assert.equal(messageEvent.tags?.supabase_edge_status, "525");

  // A chained error: only the entry that carries the page is renamed; the event is grouped as the outage.
  const chained = scrub({
    exception: {
      values: [
        { type: "Error", value: "could not load the session" },
        { type: "Error", value: edgePage(520, "Unknown error") },
      ],
    },
    tags: { route: "/api/auth/heartbeat" },
  });
  assert.equal(chained.exception?.values?.[0]?.value, "could not load the session");
  assert.equal(chained.exception?.values?.[1]?.type, SUPABASE_UNREACHABLE_TITLE);
  assert.deepEqual(chained.fingerprint, fingerprint);
  assert.deepEqual(chained.tags, { route: "/api/auth/heartbeat", supabase_edge_status: "520" }, "an existing tag survives");

  // Nothing else is touched: no fingerprint, no tag, no rewrite — and nothing is ever dropped.
  const ordinary = scrub({
    exception: { values: [{ type: "TypeError", value: "Failed to fetch" }] },
    message: "Supabase request timed out.",
  });
  assert.equal("fingerprint" in ordinary, false, "an event that is not the outage page keeps Sentry's own grouping");
  assert.equal("tags" in ordinary, false);
  assert.equal(ordinary.exception?.values?.[0]?.value, "Failed to fetch");
  assert.equal(ordinary.message, "Supabase request timed out.");
  assert.deepEqual(scrub({}), {}, "an event with none of those fields is returned as it came");

  // A log line carrying the page becomes the one readable line, and is still scrubbed after.
  const log = scrubSentryLog({ message: edgePage(521, "Web server is down"), attributes: {} });
  assert.equal(log.message, "Supabase unreachable: Cloudflare 521: Web server is down");
}

function sinkWiringTests() {
  // The Sentry scrubber is the ONE place both runtimes go through: beforeSend stays literally the scrubber.
  const policy = code("src/lib/observability/sentry-policy.ts");
  assert.match(policy, /foldSupabaseUnreachable\(scrubbable\);\s*return event;/, "scrubSentryEvent renames the outage before it returns");
  assert.match(policy, /classifySupabaseUnreachable\(log\.message\)/, "a console line carrying the page is renamed too");

  // The error table stores the readable line, not the page.
  const service = code("src/lib/error-monitor/service.ts");
  assert.match(service, /classifySupabaseUnreachable\(input\.message\)\?\.line \?\? input\.message/);
  assert.match(service, /message: truncate\(message, MAX_TEXT_LENGTH\)/, "the insert uses the renamed message, not input.message");

  // The heartbeat answers 503 for the outage page instead of rethrowing it as an unhandled 500.
  const heartbeat = code("app/api/auth/heartbeat/route.ts");
  const branch = heartbeat.slice(heartbeat.indexOf("isSupabaseTimeout(error)"));
  const body = branch.slice(0, branch.indexOf("throw error"));
  assert.match(body, /classifySupabaseUnreachable\(describeThrown\(error\)\)/, "the heartbeat recognises the Cloudflare page");
  assert.match(body, /status:\s*503/, "…and answers 503, which never signs a person out");
  assert.doesNotMatch(body, /status:\s*401|maxAge:\s*0/, "…without clearing a cookie");

  // The classifier is shared by the edge bundle and the browser bundle: it must stay free of imports.
  const classifier = readFileSync(new URL("../src/lib/error-monitor/supabase-unreachable.ts", import.meta.url), "utf8");
  assert.doesNotMatch(classifier, /^\s*import\s/m, "supabase-unreachable.ts must stay import-free (edge and browser bundles)");
}

export async function runSupabaseUnreachableTests() {
  classifierTests();
  nonMatchTests();
  sentryEventTests();
  sinkWiringTests();
}
