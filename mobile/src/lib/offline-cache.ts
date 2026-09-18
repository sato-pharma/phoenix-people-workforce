import * as SecureStore from "expo-secure-store";

/**
 * The last good answer from each endpoint, kept so a rep out of signal still sees their numbers.
 *
 * THIS CACHE IS NEVER SILENT. `use-phoenix-query.ts` used to carry a note saying a stale-while-
 * revalidate cache that quietly served yesterday's attendance would be worse than a spinner, and
 * that is still true — so everything here is built to make staleness impossible to miss. A cached
 * read always comes back stamped with when it was taken, the screen always says so on the face of
 * it, and anything older than a session's own lifetime is not served at all.
 *
 * IT IS ONLY EVER USED WHEN THE PHONE COULD NOT REACH PHOENIX. A `NetworkError` means the request
 * never landed; an `ApiError` means the server answered and said no. Only the first one falls back
 * to cache. Serving yesterday's figures because the server threw a 500 would hide a live fault
 * behind data that looks fine, which is the failure mode this whole file exists to avoid.
 *
 * WHY THE KEYSTORE AND NOT AsyncStorage. `session.tsx` puts the token in `expo-secure-store` because
 * AsyncStorage is a plaintext file inside the app sandbox, readable on a rooted handset. What is
 * cached here is not a credential, but it is still the employee's own salary-adjacent, KPI and leave
 * data, and there is no reason to hold it to a lower standard than the token sitting beside it.
 * Using the keystore also costs no new dependency, which matters: an offline cache that forced a
 * package into the build would have to justify itself against a route the app can already take.
 *
 * WHAT THE KEYSTORE COSTS. `expo-secure-store` documents a 2,048-byte ceiling per value on Android
 * and warns past it. That is a real constraint, and it is treated as a design boundary rather than
 * worked around: an oversized payload is simply not cached, `writeCache` says so by returning false,
 * and the screen behaves exactly as it did before this file existed. A portal snapshot is a few
 * hundred bytes of scalars, so this is headroom, not a squeeze — but a future screen that wants to
 * cache a long list needs a different store, and should not quietly truncate into this one.
 */

/** One stored answer. `scope` is what stops one employee's cache being shown to another. */
type CacheEnvelope<T> = {
  cachedAt: string;
  payload: T;
  scope: string;
};

/**
 * How long a cached answer may still be shown.
 *
 * Twelve hours, matching the session's own absolute lifetime in `session.tsx`. The reasoning is that
 * cached data outliving the session that fetched it has nothing left to be consistent with — the
 * person has to sign in again anyway, and at that point a fresh read costs nothing. It is also a
 * natural ceiling for a portal whose figures are daily: a KPI from two days ago is not a degraded
 * version of today's, it is a different number.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Refuse to store anything larger than this.
 *
 * Deliberately under the 2,048-byte Android ceiling rather than at it, because the measured length
 * here is UTF-16 code units in JS while the limit applies to the encoded value — a payload carrying
 * Arabic names encodes longer than it measures. Leaving the margin means the guard fires before the
 * platform warning does.
 */
const MAX_BYTES = 1_600;

/** The keys we have written, so `clearCache` can find them — SecureStore cannot enumerate itself. */
const INDEX_KEY = "phoenix.cache.index";

/**
 * SecureStore keys on Android may only contain alphanumerics, `.`, `-` and `_`, so an API path has
 * to be flattened. The result only has to be stable and collision-free across the paths this app
 * reads, not reversible.
 */
function keyForPath(path: string): string {
  return `phoenix.cache.${path.replace(/[^A-Za-z0-9.\-_]/g, "_")}`;
}

async function readIndex(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

async function rememberKey(key: string): Promise<void> {
  try {
    const keys = await readIndex();
    if (keys.includes(key)) return;
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...keys, key]));
  } catch {
    // An index we could not update means `clearCache` may miss this entry. The entry itself still
    // carries its scope, so it can never be shown to a different employee — it just lingers until
    // it ages out. Failing the write the index belongs to would be the worse trade.
  }
}

async function forget(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Already unreadable to us either way.
  }
}

/**
 * The cached answer for `path`, or null when there is nothing usable.
 *
 * Returns null — and deletes the entry — when it belongs to a different employee or has aged past
 * `MAX_AGE_MS`. Both are treated as a miss rather than an error: the caller's fallback is to report
 * the network failure it already has, which is the honest thing to show.
 */
export async function readCache<T>(
  path: string,
  scope: string,
): Promise<{ cachedAt: string; payload: T } | null> {
  const key = keyForPath(path);

  try {
    const raw = await SecureStore.getItemAsync(key);
    if (!raw) return null;

    const envelope = JSON.parse(raw) as CacheEnvelope<T>;
    if (!envelope || typeof envelope.cachedAt !== "string" || envelope.scope !== scope) {
      await forget(key);
      return null;
    }

    const takenAt = Date.parse(envelope.cachedAt);
    if (!Number.isFinite(takenAt) || Date.now() - takenAt > MAX_AGE_MS) {
      await forget(key);
      return null;
    }

    return { cachedAt: envelope.cachedAt, payload: envelope.payload };
  } catch {
    // Corrupt JSON, a keystore that threw, a shape from an older build — all mean the same thing to
    // the caller, and none of them should surface as an error on a screen that is already coping
    // with being offline.
    await forget(key);
    return null;
  }
}

/**
 * Store the latest answer for `path`. Returns false when it was not stored, which is not a failure
 * the caller needs to report — the screen is showing live data either way.
 */
export async function writeCache<T>(path: string, scope: string, payload: T): Promise<boolean> {
  const key = keyForPath(path);

  try {
    const envelope: CacheEnvelope<T> = { cachedAt: new Date().toISOString(), payload, scope };
    const serialized = JSON.stringify(envelope);

    if (serialized.length > MAX_BYTES) {
      // Too big for the keystore's ceiling. Drop any older entry rather than leave a smaller, older
      // answer behind that would later be served as though it were the last thing we saw.
      await forget(key);
      return false;
    }

    await SecureStore.setItemAsync(key, serialized);
    await rememberKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove every cached answer.
 *
 * Called on sign-out and whenever the server rejects the session. A handset that has been signed out
 * must not keep the last employee's figures on it — and a revoked session is exactly the case where
 * leaving readable data behind would be worst.
 */
export async function clearCache(): Promise<void> {
  const keys = await readIndex();
  await Promise.all(keys.map((key) => forget(key)));
  await forget(INDEX_KEY);
}

/**
 * "12:04 today", "Tuesday 14:30" — how the screen says when this was taken.
 *
 * Times are shown in the device's own zone, which for this workforce is Cairo. Kept here beside the
 * cache so every screen labels staleness the same way.
 */
export function describeCachedAt(cachedAt: string): string {
  const taken = new Date(cachedAt);
  if (!Number.isFinite(taken.getTime())) return "earlier";

  const time = taken.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const isToday = taken.toDateString() === new Date().toDateString();
  if (isToday) return `${time} today`;

  return `${taken.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
}
