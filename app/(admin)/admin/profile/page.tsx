import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminProfileForm } from "@/components/admin/admin-profile-form";
import { BiometricDevicesCard } from "@/components/auth/biometric-devices-card";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { SecondStepCard } from "@/components/auth/second-step-card";
import { EmployeePhotoEditor } from "@/components/employee-portal/employee-photo-editor";
import { NotificationSettingsPanel } from "@/components/notifications/notification-settings-panel";
import { Card } from "@/components/ui/card";
import { displayTitleForAccount } from "@/lib/auth/account-job-titles";
import { secondStepRequiredForRole } from "@/lib/auth/second-step";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { uploadedEmployeePhotoUrl } from "@/lib/employees/employee-photo";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The four things this page does. They were four cards stacked down one long scroll, which meant
 * changing a password or turning off a notification began with hunting past everything else. Tabs
 * are the owner's own suggested shape for exactly this ("they can be in the same page different
 * tabs, why not?", 2026-08-30).
 *
 * `?tab=` rather than client state, so the strip is plain `<Link>`s in a server component: Back
 * works, a tab is shareable, and no JavaScript is involved in choosing one. Profile is the default
 * and carries NO query string, so the page's existing URL keeps working and stays canonical.
 */
const PROFILE_TABS = [
  { key: "profile", label: "Profile" },
  { key: "password", label: "Password" },
  { key: "devices", label: "Devices" },
  { key: "notifications", label: "Notifications" },
] as const;

type ProfileTabKey = (typeof PROFILE_TABS)[number]["key"];

function resolveProfileTab(value: string | string[] | undefined): ProfileTabKey {
  const raw = Array.isArray(value) ? value[0] : value;
  // Anything unrecognised falls back to Profile rather than rendering an empty page — a stale or
  // hand-edited `?tab=` must not be able to produce a blank screen.
  return PROFILE_TABS.some((tab) => tab.key === raw) ? (raw as ProfileTabKey) : "profile";
}

/**
 * Same strip as the personal workspace and Direct Orders — same border, same square control, same
 * uppercase weight. Three tab strips that look like three different products is how a system starts
 * to feel like several systems.
 */
function ProfileTabStrip({ active }: { active: ProfileTabKey }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <div className="inline-flex min-w-max border border-slate-300 bg-white p-1" role="tablist">
        {PROFILE_TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              aria-selected={isActive}
              className={`min-h-[40px] whitespace-nowrap px-3 py-1.5 text-phx-sm font-black uppercase tracking-wide transition-colors ${
                isActive ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
              }`}
              href={tab.key === "profile" ? "/admin/profile" : `/admin/profile?tab=${tab.key}`}
              key={tab.key}
              role="tab"
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default async function AdminProfilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const activeTab = resolveProfileTab((await searchParams).tab);
  const access = await resolveAccessContextFromPage();

  if (!access.loginId) {
    redirect("/login");
  }

  let profile = null;
  let loadError: string | null = null;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("login_id, name, auth_email, hr_id, created_at")
      .eq("login_id", access.loginId)
      .maybeSingle();

    if (error) throw error;

    profile = {
      loginId: (data as { login_id: string } | null)?.login_id ?? access.loginId,
      name: (data as { name?: string | null } | null)?.name ?? null,
      email: (data as { auth_email?: string | null } | null)?.auth_email ?? null,
      // Her own profile page must say her TITLE, not the permission key behind it — and for an
      // account that declares one of its own (account-job-titles.ts), that title wins over the seat.
      role: access.role ? displayTitleForAccount(access.hrId, access.role) : null,
      hrId: (data as { hr_id?: string | null } | null)?.hr_id ?? null,
      createdAt: (data as { created_at?: string | null } | null)?.created_at ?? null,
    };
  } catch (error) {
    console.error("Failed to load admin profile:", error);
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  let uploadedPhoto: string | null = null;
  if (profile?.hrId) {
    uploadedPhoto = await uploadedEmployeePhotoUrl(profile.hrId).catch(() => null);
  }
  const staticPhoto = profile?.hrId ? employeeProfileImageForHrId(profile.hrId) : null;
  const currentPhotoUrl = uploadedPhoto ?? staticPhoto;
  const photoInitials = (profile?.name ?? profile?.loginId ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0))
    .join("")
    .toUpperCase();

  return (
    profile ? (
      <div className="space-y-6 pb-8">
        <div className="px-4 pt-4 sm:px-6 lg:px-8">
          <ProfileTabStrip active={activeTab} />
        </div>
        {activeTab === "profile" && (
          <>
            {profile.hrId && (
              <div className="px-4 sm:px-6 lg:px-8">
                <EmployeePhotoEditor
                  currentPhotoUrl={currentPhotoUrl}
                  fullName={profile.name ?? profile.loginId}
                  hasUploadedPhoto={Boolean(uploadedPhoto)}
                  initials={photoInitials}
                />
              </div>
            )}
            <AdminProfileForm profile={profile} />
          </>
        )}
        {activeTab === "password" && (
          <div className="px-4 sm:px-6 lg:px-8">
            <ChangePasswordForm />
          </div>
        )}
        {activeTab === "devices" && (
          <div className="px-4 sm:px-6 lg:px-8">
            <BiometricDevicesCard />
            {/* The second sign-in step is asked of Super Admin accounts only (src/lib/auth/second-step.ts). */}
            {secondStepRequiredForRole(access.role) && !access.seatView ? <SecondStepCard /> : null}
          </div>
        )}
        {activeTab === "notifications" && (
          <div className="px-4 sm:px-6 lg:px-8">
            <NotificationSettingsPanel />
          </div>
        )}
      </div>
    ) : (
      <div className="p-8">
          <Card className="mx-auto max-w-2xl border-rose-100 bg-rose-50 p-6">
            <div className="mb-4 flex items-center gap-3 text-rose-600">
              <AlertCircle className="h-6 w-6" />
              <h2 className="text-lg font-bold">Profile Load Error</h2>
            </div>
            <p className="mb-4 text-sm text-rose-700">
              There was a problem loading your profile. Please try again.
            </p>
            <div className="rounded-lg border border-rose-200 bg-white/50 p-3">
              <p className="break-all font-mono text-xs text-rose-800">
                {loadError ?? "Unknown error occurred"}
              </p>
            </div>
          </Card>
        </div>
      )
  );
}
