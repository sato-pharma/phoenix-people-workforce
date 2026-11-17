import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describeThrown } from "../src/lib/error-monitor/describe-thrown.ts";
import { newErrorAlertText, newErrorSignature, normalizeErrorMessage } from "../src/lib/error-monitor/new-error-alert-rules.ts";
import {
  SUPABASE_UNREACHABLE_TITLE,
  classifyCloudflareGatewayPage,
  classifySupabaseUnreachable,
} from "../src/lib/error-monitor/supabase-unreachable.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A Supabase outage is ONE named issue, "Supabase unreachable" (owner, 2026-10-17).
 *
 * One database restart at 12:30 Cairo filed four separate error reports — two of them titled with a whole
 * Cloudflare "521: Web server is down" / "525: SSL handshake failed" page, one a digest-only render error, one an
 * unhandled heartbeat 500 — and the same markup filled `app_error_events.message`. The classifier is pure and
 * import-free, so every sink (the error-table writer, the new-error Telegram, the heartbeat route) asks the same
 * function and a restart reads as one incident.
 *
 * What is held here: the real Cloudflare page is recognised in all three shapes it arrives in; ONLY that page
 * matches (a browser "Failed to fetch", the client's own timeout and a PostgREST error must stay what they
 * are); every outage page is ONE new error for the Telegram, whatever its code; and the sinks call the one function.
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

/** Cloudflare's PLAIN gateway page — no host in it — as Supabase's edge served it on 26 and 30 Oct 2026. */
const PLAIN_GATEWAY_PAGE = [
  "<html>",
  "<head><title>502 Bad Gateway</title></head>",
  "<body>",
  "<center><h1>502 Bad Gateway</h1></center>",
  "<hr><center>cloudflare</center>",
  "</body>",
  "</html>",
].join("\r\n");

function gatewayPageTests() {
  // The heartbeat crashed with a 500 on this page (System Audit, 31 Oct 2026): it names no host, so the
  // branded-title classifier never saw it. The plain-page helper does, raw and inside the thrown JSON.
  assert.deepEqual(classifyCloudflareGatewayPage(PLAIN_GATEWAY_PAGE), { status: 502, label: "Bad Gateway" });
  const wrapped = describeThrown({ message: PLAIN_GATEWAY_PAGE, details: "", hint: "", code: "" });
  assert.ok(wrapped.startsWith("{"), "the thrown object is described as JSON, with the page escaped inside it");
  assert.deepEqual(classifyCloudflareGatewayPage(wrapped), { status: 502, label: "Bad Gateway" });
  assert.equal(
    classifyCloudflareGatewayPage(PLAIN_GATEWAY_PAGE.replace("502 Bad Gateway</title>", "504 Gateway Time-out</title>"))?.status,
    504,
  );

  // Only CLOUDFLARE's page: the same markup from another server is not Supabase's edge.
  assert.equal(classifyCloudflareGatewayPage(PLAIN_GATEWAY_PAGE.replace("<center>cloudflare</center>", "<center>nginx</center>")), null);
  assert.equal(classifyCloudflareGatewayPage("<title>404 Not Found</title><hr><center>cloudflare</center>"), null, "a 4xx is not an outage");
  assert.equal(classifyCloudflareGatewayPage("502 Bad Gateway from cloudflare"), null, "words without the page are not the page");
  for (const notText of [null, undefined, 502, {}, "", [PLAIN_GATEWAY_PAGE]]) {
    assert.equal(classifyCloudflareGatewayPage(notText), null, "a non-string is never classified");
  }

  // It stays OUT of the every-sink classifier: the AI provider sits behind Cloudflare too, and its 502 is
  // not "Supabase unreachable".
  assert.equal(classifySupabaseUnreachable(PLAIN_GATEWAY_PAGE), null, "the plain page is not renamed in every sink");
  assert.equal(classifySupabaseUnreachable(wrapped), null);
}

function newErrorAlertTests() {
  // Every outage page is the same new error: one Telegram for a restart, whatever the code or the route.
  const wrapped = describeThrown({ message: edgePage(521, "Web server is down") });
  assert.equal(normalizeErrorMessage(wrapped), "supabase unreachable");
  assert.equal(normalizeErrorMessage(edgePage(525, "SSL handshake failed")), "supabase unreachable");
  assert.equal(
    newErrorSignature({ message: edgePage(520, "Unknown error"), source: "server" }),
    newErrorSignature({ message: wrapped, source: "server" }),
    "a 520 and a 521 are one error",
  );

  // The message carries the readable line, never the page.
  const text = newErrorAlertText({ message: wrapped, route: "/api/auth/heartbeat", source: "server" });
  assert.match(text.message, /Supabase unreachable: Cloudflare 521: Web server is down/);
  assert.ok(!text.message.includes("DOCTYPE"), "the page itself is replaced, not kept beside the name");

  // Anything else keeps its own grouping.
  assert.equal(normalizeErrorMessage("Supabase request timed out."), "supabase request timed out.");
  assert.notEqual(
    newErrorSignature({ message: "Failed to fetch", source: "client" }),
    newErrorSignature({ message: wrapped, source: "client" }),
  );
}

function sinkWiringTests() {
  // The new-error Telegram groups and words the outage through the same classifier.
  const alertRules = code("src/lib/error-monitor/new-error-alert-rules.ts");
  assert.match(alertRules, /if \(classifySupabaseUnreachable\(text\)\) return "supabase unreachable";/);
  assert.match(alertRules, /const outage = classifySupabaseUnreachable\(report\.message\);/);

  // The error table stores the readable line, not the page.
  const service = code("src/lib/error-monitor/service.ts");
  assert.match(service, /classifySupabaseUnreachable\(input\.message\)\?\.line \?\? input\.message/);
  assert.match(service, /message: truncate\(message, MAX_TEXT_LENGTH\)/, "the insert uses the renamed message, not input.message");

  // The heartbeat answers 503 for the outage page instead of rethrowing it as an unhandled 500.
  const heartbeat = code("src/lib/auth/session-heartbeat.ts");
  const branch = heartbeat.slice(heartbeat.indexOf("isSupabaseTimeout(error)"));
  const body = branch.slice(0, branch.indexOf("throw error"));
  assert.match(body, /const described = describeThrown\(error\);/);
  assert.match(body, /classifySupabaseUnreachable\(described\)/, "the heartbeat recognises the Cloudflare page");
  assert.match(body, /classifyCloudflareGatewayPage\(described\)/, "…and Cloudflare's plain gateway page, which only Supabase's edge serves here");
  assert.match(body, /status:\s*503/, "…and answers 503, which never signs a person out");
  assert.doesNotMatch(body, /status:\s*401|maxAge:\s*0/, "…without clearing a cookie");

  // The classifier is shared by the edge bundle and the browser bundle: it must stay free of imports.
  const classifier = readFileSync(new URL("../src/lib/error-monitor/supabase-unreachable.ts", import.meta.url), "utf8");
  assert.doesNotMatch(classifier, /^\s*import\s/m, "supabase-unreachable.ts must stay import-free (edge and browser bundles)");
}

export async function runSupabaseUnreachableTests() {
  classifierTests();
  nonMatchTests();
  gatewayPageTests();
  newErrorAlertTests();
  sinkWiringTests();
}
