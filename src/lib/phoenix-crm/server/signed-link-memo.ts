/**
 * Signed photo links the server already minted, kept so the same photo keeps the same link.
 *
 * Every signing returns a NEW link (the token inside it changes), and a new link is a new address to
 * the browser — so re-signing on every list load made every thumbnail download again, even though
 * the browser already held the picture. Handing back a link that is still good lets the browser's own
 * cache answer.
 *
 * Only the link is remembered, never who may see it: `signPhotoPaths` runs its scope check for every
 * path BEFORE it asks here, so a remembered link only ever reaches a viewer who passed that check.
 *
 * In process and bounded: the oldest link is dropped first once `max` is reached.
 */
export type SignedLinkMemo = {
  /** Links still good for at least `minLeftMs`, and the paths that need a fresh signing. */
  take(paths: readonly string[], now: number): { reused: Record<string, string>; toSign: string[] };
  remember(path: string, url: string, expiresAt: number): void;
  readonly size: number;
};

export function createSignedLinkMemo(options: { minLeftMs: number; max: number }): SignedLinkMemo {
  const links = new Map<string, { url: string; expiresAt: number }>();
  return {
    take(paths, now) {
      const reused: Record<string, string> = {};
      const toSign: string[] = [];
      for (const path of paths) {
        const link = links.get(path);
        if (link && link.expiresAt - now >= options.minLeftMs) {
          reused[path] = link.url;
        } else {
          if (link) links.delete(path);
          toSign.push(path);
        }
      }
      return { reused, toSign };
    },
    remember(path, url, expiresAt) {
      links.delete(path);
      links.set(path, { expiresAt, url });
      while (links.size > options.max) {
        const oldest = links.keys().next().value;
        if (oldest === undefined) break;
        links.delete(oldest);
      }
    },
    get size() {
      return links.size;
    },
  };
}
