import { isDevelopment as isDev } from "@/lib/env";

/**
 * Drop-in replacement for `Promise.all` that runs thunks sequentially in
 * development to avoid overwhelming Turbopack's Jest worker pool.
 * In production the thunks fire concurrently via `Promise.all`.
 *
 * Usage:
 *   const [a, b, c] = await devSafePromiseAll([
 *     () => fetchA(),
 *     () => fetchB(),
 *     () => fetchC(),
 *   ]);
 */
export async function devSafePromiseAll<T extends readonly (() => Promise<unknown>)[]>(
  thunks: [...T],
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  if (!isDev) {
    // Production: full concurrency
    return Promise.all(thunks.map((fn) => fn())) as Promise<{
      -readonly [K in keyof T]: Awaited<ReturnType<T[K]>>;
    }>;
  }

  // Development: sequential execution to protect Turbopack workers
  const results: unknown[] = [];
  for (const fn of thunks) {
    results.push(await fn());
  }
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/**
 * Sequential-safe version of `Promise.allSettled` for development.
 * In production, delegates to `Promise.allSettled`.
 */
export async function devSafePromiseAllSettled<T extends readonly (() => Promise<unknown>)[]>(
  thunks: [...T],
): Promise<{ -readonly [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }> {
  if (!isDev) {
    return Promise.allSettled(thunks.map((fn) => fn())) as Promise<{
      -readonly [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>>;
    }>;
  }

  const results: PromiseSettledResult<unknown>[] = [];
  for (const fn of thunks) {
    try {
      const value = await fn();
      results.push({ status: "fulfilled", value });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  return results as { -readonly [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> };
}