import { redirect } from "next/navigation";

import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export default async function Home() {
  const session = await resolveAccessContextFromPage();

  if (!session.loginId) {
    redirect("/login");
  }

  redirect(resolveLandingPathForRole(session.role));
}
