import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { packContentDisposition, packFileName, packFileNameFromDisposition } from "@/lib/business-review/pack/filename";
import { packBuildsInFlight, packRequestKey, shareInFlight } from "@/lib/business-review/pack/single-flight";

/**
 * The Business Review download cannot pile up.
 *
 * 🔴 THE INCIDENT (12 Nov 2026, 13:58–14:05 Cairo, read from production's logs on 14 Nov): one browser sent
 * 188 `GET /api/business-review/pack` in five minutes, ~180 of them cancelled within two seconds and sent
 * again, because the Download buttons showed nothing while a slow pack was built. The server built every one
 * — up to nine at once — database calls went 4–5x, the heap to 2.1 GB, and the web process froze five times.
 *
 * Two halves, both pinned here: the ROUTE builds one pack per identical request in flight (single-flight.ts),
 * and the PAGE fetches the file itself, shows "Preparing…" and ignores clicks until it lands.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

export async function runBusinessReviewPackSingleFlightTests() {
  // ---- 1. nine identical requests while one build runs → ONE build, nine answers ----
  {
    let builds = 0;
    const gate = deferred<void>();
    const build = async () => {
      builds += 1;
      await gate.promise;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Disposition": "attachment; filename=\"a.pdf\"", "Content-Type": "application/pdf" },
        status: 200,
      });
    };
    const answers = Array.from({ length: 9 }, () => shareInFlight("omar|Super Admin|format=pdf", build));
    assert.equal(packBuildsInFlight(), 1, "nine identical requests in flight hold ONE build");
    gate.resolve();
    const responses = await Promise.all(answers);
    assert.equal(builds, 1, "the pack was built once, not nine times — the 12 Nov pile-up");
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), "application/pdf");
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3], "every caller reads its own full body");
    }
    assert.equal(packBuildsInFlight(), 0, "nothing is kept once the build ends");
  }

  // ---- 2. a finished build is not reused: the next click builds fresh ----
  {
    let builds = 0;
    const build = async () => {
      builds += 1;
      return new Response("x", { status: 200 });
    };
    await shareInFlight("k-fresh", build);
    await shareInFlight("k-fresh", build);
    assert.equal(builds, 2, "sharing is for builds IN FLIGHT only — a later request never gets a stale file");
  }

  // ---- 3. different keys never share ----
  {
    let builds = 0;
    const gate = deferred<void>();
    const build = async () => {
      builds += 1;
      await gate.promise;
      return new Response("x", { status: 200 });
    };
    const both = [shareInFlight("person-a|Medical Rep|format=pdf", build), shareInFlight("person-b|Medical Rep|format=pdf", build)];
    gate.resolve();
    await Promise.all(both);
    assert.equal(builds, 2, "two people asking for the same pack each get their own build");
  }

  // ---- 4. a failed build fails every waiter once, and frees the key ----
  {
    const gate = deferred<void>();
    let builds = 0;
    const failing = async (): Promise<Response> => {
      builds += 1;
      await gate.promise;
      throw new Error("boom");
    };
    const waiters = [shareInFlight("k-fail", failing), shareInFlight("k-fail", failing)];
    gate.resolve();
    for (const waiter of waiters) await assert.rejects(waiter, /boom/);
    assert.equal(builds, 1);
    assert.equal(packBuildsInFlight(), 0, "a failed build is not served to the next request");
    const after = await shareInFlight("k-fail", async () => new Response("ok", { status: 200 }));
    assert.equal(await after.text(), "ok", "the next request after a failure builds again");
  }

  // ---- 5. the key: who, as what, for exactly what ----
  {
    const base = { identity: "B-10", role: "Super Admin" };
    const a = packRequestKey({ ...base, url: "https://x/api/business-review/pack?format=pdf&m=a&m=b&from=2026-07" });
    const b = packRequestKey({ ...base, url: "https://x/api/business-review/pack?from=2026-07&m=a&m=b&format=pdf" });
    assert.equal(a, b, "the parameter order between names does not make a different pack");
    assert.notEqual(a, packRequestKey({ ...base, url: "https://x/api/business-review/pack?format=xlsx&m=a&m=b&from=2026-07" }), "another format is another pack");
    assert.notEqual(a, packRequestKey({ ...base, url: "https://x/api/business-review/pack?format=pdf&m=a&from=2026-07" }), "other ticks are another pack");
    assert.notEqual(a, packRequestKey({ identity: "B-11", role: "Super Admin", url: "https://x/api/business-review/pack?format=pdf&m=a&m=b&from=2026-07" }), "another person never shares");
    assert.notEqual(a, packRequestKey({ identity: "B-10", role: "CEO", url: "https://x/api/business-review/pack?format=pdf&m=a&m=b&from=2026-07" }), "another role never shares");
  }

  // ---- 6. the page names the saved file from the route's own header ----
  {
    const name = packFileName("Cairo district", "Jul – Aug 2026", "pdf");
    assert.equal(packFileNameFromDisposition(packContentDisposition(name)), name, "the real name, dashes intact");
    assert.equal(packFileNameFromDisposition('attachment; filename="plain.xlsx"'), "plain.xlsx");
    assert.equal(packFileNameFromDisposition(null), null);
    assert.equal(packFileNameFromDisposition("inline"), null);
  }

  // ---- 7. the wiring: the route asks through shareInFlight, and the page guards its clicks ----
  {
    const root = process.cwd();
    const route = readFileSync(path.join(root, "app/api/business-review/pack/route.ts"), "utf8");
    assert.match(route, /return shareInFlight\(key, \(\) => buildPackResponse\(request, access\)\)/, "GET builds through the shared flight");
    const picker = readFileSync(path.join(root, "src/components/business-review/pack-picker.client.tsx"), "utf8");
    assert.match(picker, /if \(busy\.current\) return;/, "a click while a file is preparing does nothing");
    assert.match(picker, /disabled=\{none \|\| preparing !== null\}/, "every Download button is disabled while one prepares");
    assert.match(picker, /onClick=\{\(event\) => void download\(event, format, label\)\}/, "the buttons download through the guarded handler");
  }
}
