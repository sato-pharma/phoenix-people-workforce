import dynamic from "next/dynamic";

import type { DsmTeamMemberData } from "@/lib/employee-portal/service";

type MembersOnlyProps = {
  members: DsmTeamMemberData[];
};

type TeamAchievementChartProps = {
  members: DsmTeamMemberData[];
  teamAchievementPercent: number;
};

type TeamSalesVsTargetChartProps = {
  members: DsmTeamMemberData[];
  minHeightPx?: number;
};

export const TeamAchievementChart = dynamic<TeamAchievementChartProps>(() =>
  import("./team-members-breakdown.client").then((mod) => mod.TeamAchievementChart),
);

export const TeamSalesVsTargetChart = dynamic<TeamSalesVsTargetChartProps>(() =>
  import("./team-members-breakdown.client").then((mod) => mod.TeamSalesVsTargetChart),
);

type TeamLeaderboardTableProps = MembersOnlyProps & { showProductCount?: boolean };

export const TeamLeaderboardTable = dynamic<TeamLeaderboardTableProps>(() =>
  import("./team-members-breakdown.client").then((mod) => mod.TeamLeaderboardTable),
);

export const TeamMembersBreakdown = dynamic<MembersOnlyProps>(() =>
  import("./team-members-breakdown.client").then((mod) => mod.TeamMembersBreakdown),
);
