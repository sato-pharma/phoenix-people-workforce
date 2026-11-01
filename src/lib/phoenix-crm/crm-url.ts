/**
 * A GET path with its query. Empty, null and false values are left out (a flag is on only when sent).
 *
 * Its own file because the browser's screens and the page's first read (server/first-read.ts) must build
 * the same address, character for character: that address is how the screen knows the read is its own.
 */
export function crmUrl(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "" || value === false) continue;
    search.set(name, value === true ? "true" : String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}
