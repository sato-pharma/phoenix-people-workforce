import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export async function assertExportRateLimit(input: {
  actor?: string | null;
  request: Request;
  scope: string;
}) {
  await assertApiRateLimit({
    identifier: rateLimitIdentity({ actor: input.actor, request: input.request }),
    limit: 10,
    scope: input.scope,
    windowMs: 60_000,
  });
}
