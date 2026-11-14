// One build per identical Business Review pack request — however many times it is asked for.
//
// 🔴 WHY (12 Nov 2026, 13:58–14:05 Cairo, read from production's logs on 14 Nov): ONE browser sent 188
// `GET /api/business-review/pack` in five minutes, about 180 of them cancelled by the browser within two
// seconds and sent again. The Download buttons showed nothing while a slow pack was built, so every
// click looked lost, and every click cancelled the last request and started another. The route never
// noticed a cancel and shared nothing, so each one rebuilt the whole live review — the Monthly Closing
// customer by customer, the CRM lists and visits, the KPIs board. The server ran up to nine at once,
// database calls went from ~1,000 a minute to 4,000–5,600 with 34 timeouts, the heap went from 0.5 to
// 2.1 GB, and the web process froze five times for up to 2.1 s — everyone on Phoenix waited.
//
// So the route asks for its answer through `shareInFlight`: while a build for the same person, the same
// role and the same request is running, a second request waits for THAT build and gets the same bytes,
// instead of starting another. The key is built by the route from the session and the full query string,
// so two different people, or one person asking for two different packs, never share anything.
// Nothing is kept once a build ends: the next click after a finished download builds fresh.

/** What a finished build answered — kept as bytes so every waiting request can be handed its own Response. */
export type SharedPackAnswer = {
  body: Uint8Array;
  headers: [string, string][];
  status: number;
};

const inFlight = new Map<string, Promise<SharedPackAnswer>>();

async function settle(response: Response): Promise<SharedPackAnswer> {
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    headers: [...response.headers.entries()],
    status: response.status,
  };
}

/**
 * Run `build` once per `key` at a time. Every caller gets its OWN Response (a body can be read once),
 * carrying the same status, headers and bytes. A build that throws rejects every caller waiting on it,
 * and the key is freed either way, so a failure is never served twice.
 */
export async function shareInFlight(key: string, build: () => Promise<Response>): Promise<Response> {
  let shared = inFlight.get(key);
  if (!shared) {
    shared = build().then(settle);
    inFlight.set(key, shared);
    const release = () => {
      if (inFlight.get(key) === shared) inFlight.delete(key);
    };
    shared.then(release, release);
  }
  const answer = await shared;
  return new Response(answer.body.slice(), { headers: answer.headers, status: answer.status });
}

/** How many builds are running right now — for the test, and for nothing else. */
export function packBuildsInFlight(): number {
  return inFlight.size;
}

/**
 * The sharing key: who is asking, as what, and for exactly what. Every query parameter counts and the
 * order does not, so `?m=a&m=b` and `?m=b&m=a` are the same pack only when the route would build the
 * same pack from them — the metric order IS read, so it is kept per name.
 */
export function packRequestKey(input: { identity: string; role: string; url: string }): string {
  const params = new URL(input.url).searchParams;
  const names = [...new Set(params.keys())].sort();
  const query = names.map((name) => `${name}=${params.getAll(name).join(",")}`).join("&");
  return `${input.identity}|${input.role}|${query}`;
}
