import { OfferActionConfirmation } from "@/components/offers/offer-action-confirmation";
import { getOfferDecisionPreview } from "@/lib/offers/service";

export const dynamic = "force-dynamic";
export const metadata = {
  robots: {
    follow: false,
    index: false,
  },
};

export default async function AcceptOfferPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await getOfferDecisionPreview(token);

  return (
    <OfferActionConfirmation
      actionLabel="Accept Offer"
      actionPath={`/api/offers/${token}/accept`}
      actionTone="accept"
      confirmCopy="Opening this link does not accept the offer. Click the button below to confirm your acceptance."
      preview={preview}
    />
  );
}
