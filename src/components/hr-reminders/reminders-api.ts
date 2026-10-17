// HR Reminders — the board's one door to the API. A refusal arrives as the sentence the server
// wrote for a person ("Only the person who wrote a reminder can change it…"), so it is thrown as the
// error's message and shown as is.

export async function remindersApi<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    method,
  });
  const json = (await response.json().catch(() => ({}))) as { message?: unknown };
  if (!response.ok) {
    throw new Error(typeof json.message === "string" && json.message ? json.message : "Something went wrong. Try again.");
  }
  return json as T;
}
