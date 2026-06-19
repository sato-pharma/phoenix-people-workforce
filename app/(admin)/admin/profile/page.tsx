import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminProfileForm } from "@/components/admin/admin-profile-form";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { EmployeePhotoEditor } from "@/components/employee-portal/employee-photo-editor";
import { NotificationSettingsPanel } from "@/components/notifications/notification-settings-panel";
import { Card } from "@/components/ui/card";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { uploadedEmployeePhotoUrl } from "@/lib/employees/employee-photo";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminProfilePage() {
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
      role: access.role ?? null,
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
      <div className="space-y-6">
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
        <div className="px-4 sm:px-6 lg:px-8">
          <ChangePasswordForm />
        </div>
        <div className="px-4 pb-8 sm:px-6 lg:px-8">
          <NotificationSettingsPanel />
        </div>
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
