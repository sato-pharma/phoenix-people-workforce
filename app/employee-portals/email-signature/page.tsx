import { redirect } from "next/navigation";

import { EmailSignatureMaker } from "@/components/email-signature/email-signature-maker";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { systemDeployment } from "@/config/system-settings";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getSignatureCardForHrId } from "@/lib/email-signature/service";
import { signatureAltText, signatureLinesFor } from "@/lib/email-signature/signature-content";
import { SIGNATURE_SHOWN_HEIGHT, SIGNATURE_SHOWN_WIDTH } from "@/lib/email-signature/signature-layout";
import { sealSignatureToken } from "@/lib/email-signature/signature-token";

export const dynamic = "force-dynamic";

export default async function EmployeeEmailSignaturePage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "employee_profile", "read");

  let prepared: {
    alt: string;
    dropped: boolean;
    imagePath: string;
  } | null = null;
  try {
    const hrId = access.hrId;
    const card = hrId ? await getSignatureCardForHrId(hrId) : null;
    if (hrId && card) {
      const { dropped, lines } = signatureLinesFor(card);
      if (lines.name) {
        prepared = {
          alt: signatureAltText(lines),
          dropped,
          imagePath: `/api/email-signature/${sealSignatureToken(hrId)}/signature.png`,
        };
      }
    }
  } catch {
    prepared = null;
  }

  return (
    <EmployeePortalPageShell
      badge="Email Signature"
      description="Your Sato Pharma and Phoenix Workforce signature, built from your own record. Copy it once, paste it into your mail app."
      title="My Email Signature"
    >
      {prepared ? (
        <EmailSignatureMaker
          alt={prepared.alt}
          height={SIGNATURE_SHOWN_HEIGHT}
          imagePath={prepared.imagePath}
          linkUrl={systemDeployment.productionUrl}
          nameHasUnprintableCharacters={prepared.dropped}
          productionOrigin={systemDeployment.productionUrl}
          width={SIGNATURE_SHOWN_WIDTH}
        />
      ) : (
        <EmployeePortalEmptyState
          message="We could not find your details to prepare a signature right now. Please try again in a moment, or contact HR if this continues."
          title="Your signature isn't ready yet"
        />
      )}
    </EmployeePortalPageShell>
  );
}
