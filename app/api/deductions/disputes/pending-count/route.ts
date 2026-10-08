import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { countOpenDeductionsDisputes } from "@/lib/deductions/comments";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Deduction Disputes" sidebar row, its own inbox under the Approvals tab since
// 2026-10-08 (owner: *"make every approval inbox its own row under the orange Approvals tab"* —
// *"don't forget the deduction disputes"*).
//
// assertDeductionsReadActor, not the matrix alone. A Regional Manager holds `deductions:read` so
// their own portal line can render, and that grant alone once let a seat read the whole company's
// deductions (see the comment on that helper — 69 employees, 124,138.96 EGP). A COUNT is not an
// amount, but the audience for "how many people are disputing their pay" is the same question, so
// it is answered by the same named gate every company-wide deductions read passes.
//
// Any refusal settles at 0 rather than reaching the 30 s poll, exactly like its siblings here: a
// badge is chrome, and one domain's refusal must never blank the rest of the rail.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertDeductionsReadActor(access);
    return NextResponse.json({ count: await countOpenDeductionsDisputes() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
