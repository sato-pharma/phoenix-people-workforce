import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { bankLetterFileName, bankLetterRows } from "@/lib/hiring-pack/bank-account-letter";
import { buildBankAccountLetterDocx } from "@/lib/hiring-pack/bank-account-letter-docx";
import { listBankLetterEmployees, loadBankLetterImages } from "@/lib/hiring-pack/bank-account-letter-store";
import { loadCompanyDetails } from "@/lib/hiring-pack/company-details-store";
import { hrFormsAccessFor } from "@/lib/hiring-pack/paper-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The bank account-opening letter (src/lib/hiring-pack/bank-account-letter.ts).
//
//   GET                              → { employees } — the active staff the screen lists.
//   GET ?format=docx&hr=A&hr=B…      → the Word letter, those people in that order.
//
// GET for both, like the rest of `/api/hiring-pack/**`, whose registry gate is `employee_documents`
// read. The letter carries every chosen person's national ID, mobile, address and base salary, so
// it is HR's alone: a seat that reaches HR Forms through a paper grant (`paperScope`) never gets it.
// The HR Operations Specialist has it with the rest of HR Forms (owner, 2026-11-02, "FULL MODULE").
// Every file is audited BEFORE it is returned. No row, no file.

const MAX_PEOPLE = 500;

function cairoDate(): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());
}

function fail(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");
    const forms = await hrFormsAccessFor(access);
    if (!forms.canRead || forms.paperScope !== null) {
      return fail(403, "forbidden", "The bank account letter is prepared by HR.");
    }

    const employees = await listBankLetterEmployees();
    const url = new URL(request.url);
    if (url.searchParams.get("format") !== "docx") {
      return NextResponse.json({ employees }, { headers: { "Cache-Control": "no-store, max-age=0" } });
    }

    const requested = url.searchParams.getAll("hr");
    if (requested.length === 0) return fail(400, "no_people", "Choose at least one employee.");
    if (requested.length > MAX_PEOPLE) return fail(400, "too_many_people", `Put at most ${MAX_PEOPLE} people on one letter.`);
    if (new Set(requested).size !== requested.length) return fail(400, "duplicate_people", "Someone was chosen twice.");

    const byId = new Map(employees.map((employee) => [employee.hrId, employee]));
    const chosen = [];
    for (const hrId of requested) {
      const employee = byId.get(hrId);
      if (!employee) {
        return fail(404, "employee_not_active", "One of the chosen people is no longer on the active staff list. Refresh the page and choose again.");
      }
      chosen.push(employee);
    }

    const company = await loadCompanyDetails();
    const docx = await buildBankAccountLetterDocx({
      companyNameAr: company.legalNameAr,
      companyNameEn: company.legalNameEn,
      headOfficeAr: company.headOfficeAr,
      images: loadBankLetterImages(),
      rows: bankLetterRows(chosen),
    });

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityId: randomUUID(),
      entityType: "bank_account_letter_export",
      newValues: { count: chosen.length, hrIds: requested },
      summary: `Bank account letter exported (${chosen.length} ${chosen.length === 1 ? "person" : "people"}) by ${access.hrId ?? "unknown"}.`,
    });

    return new Response(Buffer.from(docx), {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Disposition": `attachment; filename="${bankLetterFileName(cairoDate())}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) return fail(403, "forbidden", "You do not have access to the bank account letter.");
    console.error("[bank-account-letter] failed", error);
    return fail(500, "bank_account_letter_failed", "The letter could not be generated. Try again.");
  }
}
