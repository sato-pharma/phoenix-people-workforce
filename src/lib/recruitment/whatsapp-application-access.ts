// Recruitment / ATS — who may open a WhatsApp application.
//
// The application is a person's name, phone, email, salary answer and CV in one file, so it is opened
// only by a recruiter: an HR authority role holding recruitment:read AND the candidates grant. That is the
// gate on the list that offers the buttons (app/(admin)/recruitment/whatsapp-applicants), on the page that
// prints it (app/print/whatsapp-application/[sessionId]) and on the route that builds it
// (app/api/recruitment/whatsapp-applicants/[sessionId]/application). Those three state it inline, and
// tests/interview-calendar-application.test.ts pins that all four say the same three things.
//
// This copy exists for the interview calendar. A person the calendar is shared with may hold no
// recruitment permission at all — that is what sharing is for — and the CV beside the interview opens for
// them through the calendar's own door. The application does NOT: the calendar only OFFERS its buttons to
// someone who could open the same file from WhatsApp Applicants, and the routes behind the buttons refuse
// everybody else on their own.

import { canAccess, isHrAuthorityRole, type AccessContext } from "@/lib/auth/permissions";

export async function canOpenWhatsAppApplications(access: AccessContext): Promise<boolean> {
  if (!isHrAuthorityRole(access.role)) return false;
  const [recruitment, candidates] = await Promise.all([
    canAccess(access, "recruitment", "read").catch(() => false),
    canAccess(access, "candidates", "read").catch(() => false),
  ]);
  return Boolean(recruitment) && Boolean(candidates);
}
