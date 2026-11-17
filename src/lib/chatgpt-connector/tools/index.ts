/**
 * Every read-only domain tool the ChatGPT connector offers (app/api/mcp/route.ts registers them).
 * Each tool asserts the permission its Phoenix screen asserts and reads through the same domain
 * service; this list only gathers them and turns a permission refusal into plain words.
 */
import { attendanceTool, leaveTool, payrollTool } from "@/lib/chatgpt-connector/tools/hr";
import { crmKpisTool, orgChartTool } from "@/lib/chatgpt-connector/tools/org";
import { findPeopleTool, personTool } from "@/lib/chatgpt-connector/tools/people";
import { salesAchievementTool, salesRankingsTool } from "@/lib/chatgpt-connector/tools/sales";
import { listTablesTool, readTableTool } from "@/lib/chatgpt-connector/tools/tables";
import { asPlainRefusal } from "@/lib/chatgpt-connector/tools/helpers";
import type { ConnectorTool } from "@/lib/chatgpt-connector/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool keeps its own input shape
function withPlainRefusals(tool: ConnectorTool<any>): ConnectorTool<any> {
  return {
    ...tool,
    run: async (ctx, input) => {
      try {
        return await tool.run(ctx, input);
      } catch (error) {
        throw asPlainRefusal(error);
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous list of input shapes
export const DOMAIN_TOOLS: ConnectorTool<any>[] = [
  findPeopleTool,
  personTool,
  salesAchievementTool,
  salesRankingsTool,
  leaveTool,
  attendanceTool,
  payrollTool,
  crmKpisTool,
  orgChartTool,
  listTablesTool,
  readTableTool,
].map(withPlainRefusals);
