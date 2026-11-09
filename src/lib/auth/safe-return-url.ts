/**
 * The page a sign-in may send its user back to — or null when the value is not safe to follow.
 *
 * A post-login target is a same-origin path: one leading "/", never "//" or "/\" (a browser reads
 * both as another host), and no control character (a browser drops a tab or newline from a url, so
 * "/<tab>/host" would become "//host"). The login page's server redirect and the sign-in form both
 * read it here, so the two can never disagree about what is safe.
 */
export function safeReturnUrl(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return null;
  for (let index = 0; index < v.length; index += 1) {
    const code = v.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return v;
}
