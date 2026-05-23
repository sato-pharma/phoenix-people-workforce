import { PasswordSetupForm } from "@/components/auth/password-setup-form";
import { getPasswordSetupPreview } from "@/lib/auth/password-setup";

export const dynamic = "force-dynamic";

export default async function PasswordSetupPage(
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  let preview: Awaited<ReturnType<typeof getPasswordSetupPreview>>;

  try {
    preview = await getPasswordSetupPreview(token);
  } catch (error) {
    const message = "This password setup link is unavailable.";

    return (
      <main className="min-h-screen bg-[#020202] px-4 py-10 text-white">
        <section className="mx-auto max-w-xl rounded-[32px] border border-white/10 bg-[linear-gradient(145deg,rgba(19,22,27,0.92),rgba(5,6,8,0.98))] p-8 shadow-[0_30px_70px_rgba(0,0,0,0.55)]">
          <p className="text-sm font-black uppercase tracking-[0.24em] text-[#ff7900]">Phoenix Workforce</p>
          <h1 className="mt-5 text-3xl font-black text-white">Link unavailable</h1>
          <p className="mt-3 text-base leading-7 text-white/72">{message}</p>
          <p className="mt-4 text-sm text-white/55">Ask your admin to generate a new password setup link.</p>
        </section>
      </main>
    );
  }

  return (
    <PasswordSetupForm
      expiresAt={preview.expiresAt}
      hrId={preview.hrId}
      loginId={preview.loginId}
      name={preview.name}
      purpose={preview.purpose}
      token={token}
    />
  );
}
