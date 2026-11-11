// The interview calendar's requests, with the copy link carried on every one.
//
// Someone who opened the calendar from a copy link (/share/interview-calendar/<token>) is known to
// the server only by that token, so every request carries it: a header on fetches, and `?link=` on
// the addresses a browser opens by itself — a CV in the preview frame, a file download — which
// cannot carry a header. Inside Phoenix there is no token and these are the plain requests.

export const INTERVIEW_CALENDAR_API = "/api/recruitment/interview-calendar";
const LINK_HEADER = "x-interview-calendar-link";

export type CalendarApi = {
  /** The token being carried, or null inside Phoenix. */
  linkToken: string | null;
  get: (path: string) => Promise<Record<string, unknown>>;
  post: (path: string, body: unknown) => Promise<Record<string, unknown>>;
  postForm: (path: string, form: FormData) => Promise<Record<string, unknown>>;
  patch: (path: string, body: unknown) => Promise<Record<string, unknown>>;
  del: (path: string) => Promise<Record<string, unknown>>;
  /** A full address for the browser to open, with the link on it when there is one. */
  href: (path: string) => string;
  /** A raw fetch (downloads), with the link header. */
  fetch: (path: string) => Promise<Response>;
};

async function readJson(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : fallback);
  return data;
}

/** A read the browser could not deliver for two minutes — never the browser's own "Failed to fetch (host)". */
export const CALENDAR_UNREACHABLE_READ = "Phoenix could not be reached from this browser for two minutes. Check the connection and press it again.";
/** A save that may or may not have arrived — the connection dropped, so the server's answer was never seen. */
export const CALENDAR_UNREACHABLE_WRITE =
  "Phoenix could not be reached from this browser, so it is not known whether that was saved. Check the connection, then reopen the interview to see.";

/** The pauses between tries of a read whose connection dropped — about two minutes in all. */
export const CALENDAR_READ_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000];

/** A pause that ends early the moment the browser says the connection is back. */
function pauseUntilOnline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Only a real event target is listened to — a test or a non-browser runtime may stand in a bare window.
    const online = typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : null;
    const done = () => {
      clearTimeout(timer);
      online?.removeEventListener("online", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    online?.addEventListener("online", done);
  });
}

// 11 Nov 2026: Youmna's drawer for Merna Sobhy Abdelatty showed "Failed to fetch
// (phoenix-hr.satopharma.com)" under the invitation and the polls. The server was up and answered every
// request it received; her laptop was off the internet for about two minutes (11:23-11:25 Cairo), and the
// panels never asked again, so the data stayed missing until the page was reloaded — at 11:29 the same
// drawer loaded the polls at once. A read is safe to repeat, so it keeps trying for about two minutes,
// and at once when the browser says it is back online: the data appears by itself when the connection
// returns. A save is never repeated (it may already have arrived) and says so instead. A server's
// answer — a refusal included — is never retried; only a request that never got an answer is.
async function reach(input: string, init: RequestInit, retryDelaysMs: readonly number[] | null): Promise<Response> {
  const pauses = retryDelaysMs ?? [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch {
      if (attempt >= pauses.length) break;
      await pauseUntilOnline(pauses[attempt]);
    }
  }
  throw new Error(retryDelaysMs ? CALENDAR_UNREACHABLE_READ : CALENDAR_UNREACHABLE_WRITE);
}

export function calendarApi(
  linkToken: string | null | undefined,
  { readRetryDelaysMs = CALENDAR_READ_RETRY_DELAYS_MS }: { readRetryDelaysMs?: readonly number[] } = {},
): CalendarApi {
  const token = linkToken?.trim() || null;
  const url = (path: string) => `${INTERVIEW_CALENDAR_API}${path}`;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => (token ? { ...extra, [LINK_HEADER]: token } : extra);
  const json = (method: string, path: string, body: unknown) =>
    reach(url(path), { body: JSON.stringify(body), headers: headers({ "Content-Type": "application/json" }), method }, null);
  return {
    del: async (path) => readJson(await reach(url(path), { headers: headers(), method: "DELETE" }, null), "That could not be removed."),
    fetch: (path) => reach(url(path), { cache: "no-store", headers: headers() }, readRetryDelaysMs),
    get: async (path) => readJson(await reach(url(path), { cache: "no-store", headers: headers() }, readRetryDelaysMs), "That could not be read."),
    href: (path) => {
      if (!token) return url(path);
      return `${url(path)}${path.includes("?") ? "&" : "?"}link=${encodeURIComponent(token)}`;
    },
    linkToken: token,
    patch: async (path, body) => readJson(await json("PATCH", path, body), "That could not be saved."),
    post: async (path, body) => readJson(await json("POST", path, body), "That could not be saved."),
    postForm: async (path, form) => readJson(await reach(url(path), { body: form, headers: headers(), method: "POST" }, null), "That could not be saved."),
  };
}

/** The reason a request failed, as a sentence. */
export function reasonText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
