import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BogenServer } from '../http/server.ts';
import { toolDefiner, type Session } from './kit.ts';
import { registerBrandTools } from './tools-brand.ts';
import { registerBatchTool } from './tools-batch.ts';
import { registerComponentTools } from './tools-components.ts';
import { registerDataTools } from './tools-data.ts';
import { registerCodeTools } from './tools-code.ts';
import { registerCustomCheckTools } from './tools-custom-checks.ts';
import { registerCheckTools } from './tools-check.ts';
import { registerComplianceTools } from './tools-compliance.ts';
import { registerDesignTools } from './tools-design.ts';
import { registerDesignKnowledgeTools } from './tools-design-knowledge.ts';
import { registerDriftTools } from './tools-drift.ts';
import { registerFileTools } from './tools-files.ts';
import { registerFontTools } from './tools-fonts.ts';
import { registerImageTools } from './tools-images.ts';
import { registerCanvasPlanTools } from './tools-canvas-plan.ts';
import { registerLayoutTools } from './tools-layout.ts';
import { registerLibraryTools } from './tools-library.ts';
import { registerLiveTools } from './tools-live.ts';
import { registerOmarchyTools } from './tools-omarchy.ts';
import { registerProposalTools } from './tools-proposals.ts';
import { registerRevisionTools } from './tools-revisions.ts';
import { registerDesignBranchTools } from './tools-design-branches.ts';
import { registerWebTools } from './tools-web.ts';
import { registerPrototypeTools } from './tools-prototype.ts';
import { registerPublishTools } from './tools-publish.ts';
import { registerReadTools } from './tools-read.ts';
import { registerReplayTools } from './tools-replay.ts';
import { registerKitTools } from './tools-kits.ts';
import { registerTemplateTools } from './tools-templates.ts';
import { registerTomaccoTools } from './tools-tomacco.ts';
import { registerTransferTools } from './tools-transfer.ts';
import { registerWriteTools } from './tools-write.ts';
import { registerCraftTools } from './tools-craft.ts';

export function registerAllTools(server: McpServer, app: BogenServer, session: Session): void {
  const define = toolDefiner(server, app, session);
  registerFileTools(define);
  registerReadTools(define);
  registerWriteTools(define);
  registerCraftTools(define);
  registerDesignTools(define);
  registerDesignKnowledgeTools(define);
  registerImageTools(define);
  registerFontTools(define);
  registerComponentTools(define);
  registerCodeTools(define);
  registerLibraryTools(define);
  registerLayoutTools(define);
  registerCanvasPlanTools(define);
  registerLiveTools(define);
  registerCheckTools(define);
  registerComplianceTools(define);
  registerPrototypeTools(define);
  registerCustomCheckTools(define);
  registerProposalTools(define);
  registerRevisionTools(define);
  registerDesignBranchTools(define);
  registerWebTools(define);
  registerBrandTools(define);
  registerTemplateTools(define);
  registerOmarchyTools(define);
  registerTransferTools(define);
  registerReplayTools(define);
  registerTomaccoTools(define);
  registerPublishTools(define);
  registerDriftTools(define);
  registerKitTools(define);
  registerDataTools(define);
  registerBatchTool(define, app, session);
  answerRenamedTools(server);
}

/** Tools renamed before the first release. Not listed, but an agent that calls an old name learns the new one. */
export const RENAMED_TOOLS: Record<string, string> = {
  page_snapshot: 'page_capture',
  site_snapshot: 'site_capture',
  site_snapshot_status: 'site_capture_status',
};

/**
 * The SDK answers an unknown tool with "Tool x not found" through its tool error. That error is
 * rewritten here for an old name; if the SDK ever stops calling it, the plain error stays.
 */
function answerRenamedTools(server: McpServer): void {
  const sdk = server as unknown as { createToolError?: (message: string) => CallToolResult };
  const make = sdk.createToolError?.bind(server);
  if (!make) return;
  sdk.createToolError = (message) => {
    const old = /Tool (\w+) not found/.exec(message)?.[1];
    const now = old ? RENAMED_TOOLS[old] : undefined;
    return make(now ? `${old} is now called ${now}. Call ${now} with the same arguments.` : message);
  };
}
