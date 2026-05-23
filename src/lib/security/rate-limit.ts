type RateLimitBucket = { count: number; windowStart: number };

const store = new Map<string, RateLimitBucket>();
let lastGc = Date.now();
const GC_INTERVAL_MS = 5 * 60 * 1000;

function gc(now: number, windowMs: number) {
  if (now - lastGc < GC_INTERVAL_MS) return;
  lastGc = now;
  const cutoff = now - windowMs;
  for (const [key, bucket] of store) {
    if (bucket.windowStart < cutoff) store.delete(key);
  }
}

export function checkRateLimit(
  key: string,
  options: { maxRequests: number; windowMs: number },
): { limited: boolean; remaining: number } {
  const { maxRequests, windowMs } = options;
  const now = Date.now();
  gc(now, windowMs);

  const bucket = store.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { limited: false, remaining: maxRequests - 1 };
  }

  if (bucket.count >= maxRequests) {
    return { limited: true, remaining: 0 };
  }

  bucket.count += 1;
  return { limited: false, remaining: maxRequests - bucket.count };
}

export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    "unknown"
  );
}
