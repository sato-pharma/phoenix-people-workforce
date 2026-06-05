import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { submitPublicApplication } from "@/lib/recruitment/postings";
import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, unauthenticated submission. Protected by the posting token + IP rate
// limit (see submitPublicApplication). No session, no CSRF (matches the offer
// token endpoints); it only writes — it never returns recruitment data.
function hashIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = (forwarded ? forwarded.split(",")[0]?.trim() : null) || request.headers.get("x-real-ip");
  return ip ? crypto.createHash("sha256").update(ip).digest("hex") : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const raw = await request.json().catch(() => ({}));
    const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    await submitPublicApplication(
      token,
      {
        fullName: String(body.fullName ?? ""),
        email: body.email,
        phone: body.phone,
        governorate: body.governorate,
        currentEmployer: body.currentEmployer,
        yearsExperience: body.yearsExperience,
        expectedSalary: body.expectedSalary,
        noticePeriod: body.noticePeriod,
        cvExternalUrl: body.cvExternalUrl,
        source: body.source,
      },
      hashIp(request),
    );
    return NextResponse.json({ success: true, message: "Application submitted. Thank you — our team will be in touch." });
  } catch (error) {
    return recruitmentApiError(error, "Application submission failed.");
  }
}
