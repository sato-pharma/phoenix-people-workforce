import { OfferActionConfirmation } from "@/components/offers/offer-action-confirmation";
import { getOfferDecisionPreview } from "@/lib/offers/service";

export const dynamic = "force-dynamic";
export const metadata = {
  robots: {
    follow: false,
    index: false,
  },
};

export default async function NegotiateOfferPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await getOfferDecisionPreview(token);

  return (
    <OfferActionConfirmation
      actionLabel="Request Negotiation"
      actionPath={`/api/offers/${token}/negotiate`}
      actionTone="reject"
      confirmCopy="Opening this link does not change your offer. Click the button below to ask the HR team to revisit the terms."
      preview={preview}
    />
  );
}
