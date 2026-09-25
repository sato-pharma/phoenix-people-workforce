---
name: nextjs16-proxy-csrf
description: "Next.js 16 renamed middleware.ts → proxy.ts; Phoenix enforces global CSRF there. Grepping \"middleware.ts\" gives a false \"no CSRF\" finding."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 56090757-a287-4d04-aa95-5e556e004a00
---

Phoenix runs **Next.js 16**, which renamed `middleware.ts` to **`proxy.ts`** (root). The build log shows it as `ƒ Proxy (Middleware)`. The repo has NO `middleware.ts` — auditors who grep only for `middleware.ts` wrongly conclude "no global CSRF protection."

`proxy.ts` (matcher `/api/:path*` + `/offers/:token/accept|reject`) enforces **global same-origin CSRF** on every mutating request: `requiresCsrfProtection` (`src/lib/security/csrf.ts:9`) covers POST/PUT/PATCH/DELETE, and `isSameOriginMutationRequest` validates the Origin header (then Referer), **fail-closed when both are absent**. Webhooks (`/api/attendance/raw-punches`, `telegram/webhook`, `webhooks/resend`) are explicitly exempted (they verify their own signatures/bearer). Per-route `assertSameOriginMutation` calls are redundant defense-in-depth, NOT the primary boundary.

`proxy.ts` also implements preview read-only mode (`VERCEL_ENV=preview` + `PHOENIX_PREVIEW_READ_ONLY=true`) blocking mutations except an allowlist. Verified during the 2026-06-07 audit.
