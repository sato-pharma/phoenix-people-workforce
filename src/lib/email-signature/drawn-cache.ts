/**
 * The signature pictures this process has already drawn (REC-055, F-RCT-016). Every opened email asks
 * for the picture again and drawing it is the costly part, so a picture is kept for a while under a key
 * the caller chooses — the exact lines it shows, so a changed number or title is a new key and is drawn
 * afresh at once. Bounded: a full cache drops its oldest entry, it never grows.
 *
 * Deliberately dependency-free, so the unit tests import it directly.
 */

export type DrawnPictureCache = {
  /** The kept picture for `key` when it was drawn less than the lifetime ago; otherwise drawn now and kept. */
  get(key: string, draw: () => Promise<ArrayBuffer>, now?: number): Promise<ArrayBuffer>;
  /** How many pictures are held right now — never more than the cap. */
  readonly size: number;
};

export function createDrawnPictureCache(maxEntries: number, lifetimeMs: number): DrawnPictureCache {
  const cap = Math.max(1, Math.floor(maxEntries));
  const kept = new Map<string, { at: number; png: ArrayBuffer }>();

  return {
    async get(key, draw, now = Date.now()) {
      const hit = kept.get(key);
      if (hit && now - hit.at < lifetimeMs) return hit.png;
      const png = await draw();
      kept.delete(key);
      while (kept.size >= cap) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        kept.delete(oldest);
      }
      kept.set(key, { at: now, png });
      return png;
    },
    get size() {
      return kept.size;
    },
  };
}
