import { redirect } from "next/navigation";

import { JobPostBuilder } from "@/components/recruitment/job-post-builder";
import { PremiumHero } from "@/components/ui/premium-hero";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadMarketAwarenessLines } from "@/lib/market-awareness/lines";
import { canBuildJobPosts } from "@/lib/recruitment/access";
import { listCandidateFolderAreaOptions } from "@/lib/recruitment/candidate-folder-options";
import { candidateRegionCodes, candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { listJobPostTitles } from "@/lib/recruitment/job-posts/service";
import { JOB_POST_CAREERS } from "@/lib/recruitment/job-posts/templates";
import { NEW_CHANNEL_APPLY_WHATSAPP_NUMBER } from "@/lib/recruitment/outreach/job-post-channels";

export const dynamic = "force-dynamic";

// Job Posts — pick or add a job title, write what the job is, choose one of the five post templates
// and download the picture (owner, 2026-10-15: "I choose the job title … I write the requirements
// and the needs … I choose the template I want to use and then download").
//
// THE AUDIENCE IS THE SUPER ADMIN AND THE TALENT ACQUISITION SEAT — canBuildJobPosts, the same two
// roles both nav rows carry. A row offered to someone this page then redirects is exactly what
// every-offered-link-opens.test.ts exists to catch, so the two change together.
//
// THE HEADER IS PremiumHero, flat by the owner's decision (see whatsapp-templates/page.tsx).
export default async function JobPostsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canBuildJobPosts(access)) {
    redirect("/employee-portals");
  }

  // The titles are the page's own data and a failure is shown as one; the areas and lines only feed
  // optional pickers, so a failed read degrades to an empty picker rather than an error page.
  const [titles, areaOptions, lines] = await Promise.all([
    listJobPostTitles({ includeInactive: true }),
    listCandidateFolderAreaOptions().catch(() => []),
    loadMarketAwarenessLines().catch(() => []),
  ]);

  // Areas grouped under their RECRUITMENT region, in the region order the CV folders use.
  const regionOrder = new Map<string, number>(candidateRegionCodes.map((code, index) => [code, index]));
  const groups = new Map<string, string[]>();
  for (const option of areaOptions) {
    const list = groups.get(option.regionCode) ?? [];
    list.push(option.name);
    groups.set(option.regionCode, list);
  }
  const areaGroups = [...groups.entries()]
    .sort(([a], [b]) => (regionOrder.get(a) ?? 99) - (regionOrder.get(b) ?? 99))
    .map(([code, areas]) => ({ label: candidateRegionLabels[code as CandidateRegionCode] ?? code, areas }));

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PremiumHero
        kicker="Recruitment"
        subtitle="Choose a job title and its wording is ready — what you will do and what you need. Adjust it, pick one of five designs, and download the post. Changes you save stay with the title."
        title="Job Posts"
      />
      <div className="pt-5">
        <JobPostBuilder
          apply={{ careers: JOB_POST_CAREERS, whatsapp: NEW_CHANNEL_APPLY_WHATSAPP_NUMBER }}
          areaGroups={areaGroups}
          initialTitles={titles}
          lines={lines.map((line) => line.name)}
        />
      </div>
    </div>
  );
}
