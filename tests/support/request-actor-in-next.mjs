// Run by tests/employee-and-deduction-history.test.ts in a process of its own.
//
// It opens two REAL Next request scopes (Next's own async storage, the same one next/headers reads),
// remembers a person in one of them through the app's own entry points, and sends writes through the
// app's own admin client with fetch replaced by a recorder. What it prints is what would have left the
// server. A process of its own, because Next's storage takes AsyncLocalStorage from globalThis at import
// time, and the suite's shared process has already imported next/headers without it.
import { AsyncLocalStorage } from "node:async_hooks";

globalThis.AsyncLocalStorage = AsyncLocalStorage;
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://actor-probe.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "actor-probe-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "actor-probe-anon-key";

const sent = [];
globalThis.fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  sent.push({
    method: String(init?.method ?? "GET").toUpperCase(),
    path: new URL(String(input)).pathname,
    login: headers.get("x-phoenix-actor-login-id"),
    hr: headers.get("x-phoenix-actor-hr-id"),
    body: typeof init?.body === "string" ? init.body : null,
  });
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
};

const { workAsyncStorage } = (await import("next/dist/server/app-render/work-async-storage.external.js")).default;
const { workUnitAsyncStorage } = (await import("next/dist/server/app-render/work-unit-async-storage.external.js")).default;
const { headers } = await import("next/headers.js");
const actor = await import("../../src/lib/supabase/request-actor.ts");
const { getSupabaseAdmin } = await import("../../src/lib/supabase/server.ts");

const inRequest = (run) =>
  workAsyncStorage.run({ route: "/actor-probe" }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "action", headers: new Headers() }, run),
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sentSince = (from) => sent.slice(from);

const out = {};

// Before anyone was remembered in this process: nothing asks Next for anything. Proven inside a STATIC
// render, where merely calling headers() marks the route dynamic for good before it throws.
const staticWork = { route: "/actor-probe-static" };
const staticUnit = { type: "prerender-legacy", phase: "render", revalidate: 3600 };
out.beforeAnyone = await workAsyncStorage.run(staticWork, () =>
  workUnitAsyncStorage.run(staticUnit, () =>
    actor.requestActorHeaders({ method: "PATCH", url: "https://x/rest/v1/employees" }),
  ),
);
out.staticRenderLeftAlone = staticUnit.revalidate === 3600 && staticWork.dynamicUsageDescription === undefined;

await Promise.all([
  inRequest(async () => {
    const first = await headers();
    const second = await headers();
    out.sameStoreTwice = first === second;
    await actor.rememberRequestActor({ source: "session", loginId: "ops:omar", hrId: "B-10" });
    await pause(30); // the other request runs meanwhile

    const from = sent.length;
    const admin = getSupabaseAdmin();
    await admin.from("employees").update({ nickname: "probe" }).eq("hr_id", "A-1");
    await admin.from("employees").select("hr_id").eq("hr_id", "A-1");
    await admin.rpc("phx_probe", { p: 1 });
    await admin.from("employees").update({ nickname: "probe" }).eq("hr_id", "A-1").setHeader("x-phoenix-actor-login-id", "joining-form");
    await admin.storage.from("probe").upload("a.txt", "x");
    out.remembered = sentSince(from);
  }),
  inRequest(async () => {
    await pause(10);
    const from = sent.length;
    await getSupabaseAdmin().from("employees").update({ nickname: "other" }).eq("hr_id", "A-2");
    out.otherRequest = sentSince(from).filter((call) => call.body?.includes("other"));
  }),
]);

const from = sent.length;
await getSupabaseAdmin().from("employees").update({ nickname: "outside" }).eq("hr_id", "A-3");
out.outsideARequest = sentSince(from);

console.log(`ACTOR_PROBE ${JSON.stringify(out)}`);
