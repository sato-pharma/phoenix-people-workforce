import { PublicApplicationForm } from "@/components/recruitment/public-application-form";
import { getPublicPosting } from "@/lib/recruitment/postings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ApplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const posting = await getPublicPosting(token);

  if (!posting) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center p-6 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Position unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">This job posting is not currently accepting applications.</p>
      </main>
    );
  }

  return <PublicApplicationForm title={posting.title} token={posting.token} />;
}
