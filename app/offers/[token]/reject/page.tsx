import { OfferActionConfirmation } from "@/components/offers/offer-action-confirmation";
import { getOfferDecisionPreview } from "@/lib/offers/service";

export const dynamic = "force-dynamic";
export const metadata = {
  robots: {
    follow: false,
    index: false,
  },
};

export default async function RejectOfferPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await getOfferDecisionPreview(token);

  return (
    <OfferActionConfirmation
      actionLabel="Reject Offer"
      actionPath={`/api/offers/${token}/reject`}
      actionTone="reject"
      confirmCopy="Opening this link does not reject the offer. Click the button below to confirm your decision."
      preview={preview}
    />
  );
}
