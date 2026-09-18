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

export function calendarApi(linkToken: string | null | undefined): CalendarApi {
  const token = linkToken?.trim() || null;
  const url = (path: string) => `${INTERVIEW_CALENDAR_API}${path}`;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => (token ? { ...extra, [LINK_HEADER]: token } : extra);
  const json = (method: string, path: string, body: unknown) =>
    fetch(url(path), { body: JSON.stringify(body), headers: headers({ "Content-Type": "application/json" }), method });
  return {
    del: async (path) => readJson(await fetch(url(path), { headers: headers(), method: "DELETE" }), "That could not be removed."),
    fetch: (path) => fetch(url(path), { cache: "no-store", headers: headers() }),
    get: async (path) => readJson(await fetch(url(path), { cache: "no-store", headers: headers() }), "That could not be read."),
    href: (path) => {
      if (!token) return url(path);
      return `${url(path)}${path.includes("?") ? "&" : "?"}link=${encodeURIComponent(token)}`;
    },
    linkToken: token,
    patch: async (path, body) => readJson(await json("PATCH", path, body), "That could not be saved."),
    post: async (path, body) => readJson(await json("POST", path, body), "That could not be saved."),
    postForm: async (path, form) => readJson(await fetch(url(path), { body: form, headers: headers(), method: "POST" }), "That could not be saved."),
  };
}

/** The reason a request failed, as a sentence. */
export function reasonText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
