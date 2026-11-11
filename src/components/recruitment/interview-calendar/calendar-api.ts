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

/** A read the browser could not deliver at all — never the browser's own "Failed to fetch (host)". */
export const CALENDAR_UNREACHABLE_READ = "Phoenix could not be reached from this browser. Check the connection and press it again.";
/** A save that may or may not have arrived — the connection dropped, so the server's answer was never seen. */
export const CALENDAR_UNREACHABLE_WRITE =
  "Phoenix could not be reached from this browser, so it is not known whether that was saved. Check the connection, then reopen the interview to see.";

// 11 Nov 2026: an interview drawer showed "Failed to fetch (phoenix-hr.satopharma.com)" under the
// invitation and the polls while the server was up and answered every request it received — the
// laptop's connection had dropped for a moment. A read is safe to repeat, so it is tried once more
// after a short pause; a save is never repeated (it may already have arrived) and says so instead.
async function reach(input: string, init: RequestInit, retry: boolean): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    if (retry) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        return await fetch(input, init);
      } catch {
        // falls through to the plain sentence
      }
    }
    throw new Error(retry ? CALENDAR_UNREACHABLE_READ : CALENDAR_UNREACHABLE_WRITE);
  }
}

export function calendarApi(linkToken: string | null | undefined): CalendarApi {
  const token = linkToken?.trim() || null;
  const url = (path: string) => `${INTERVIEW_CALENDAR_API}${path}`;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => (token ? { ...extra, [LINK_HEADER]: token } : extra);
  const json = (method: string, path: string, body: unknown) =>
    reach(url(path), { body: JSON.stringify(body), headers: headers({ "Content-Type": "application/json" }), method }, false);
  return {
    del: async (path) => readJson(await reach(url(path), { headers: headers(), method: "DELETE" }, false), "That could not be removed."),
    fetch: (path) => reach(url(path), { cache: "no-store", headers: headers() }, true),
    get: async (path) => readJson(await reach(url(path), { cache: "no-store", headers: headers() }, true), "That could not be read."),
    href: (path) => {
      if (!token) return url(path);
      return `${url(path)}${path.includes("?") ? "&" : "?"}link=${encodeURIComponent(token)}`;
    },
    linkToken: token,
    patch: async (path, body) => readJson(await json("PATCH", path, body), "That could not be saved."),
    post: async (path, body) => readJson(await json("POST", path, body), "That could not be saved."),
    postForm: async (path, form) => readJson(await reach(url(path), { body: form, headers: headers(), method: "POST" }, false), "That could not be saved."),
  };
}

/** The reason a request failed, as a sentence. */
export function reasonText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
