import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BogenServer } from '../http/server.ts';
import { toolDefiner, type Session, type ToolDefiner } from './kit.ts';
import { installToolModes, reviewerRefusal, type ToolMode } from './tool-modes.ts';
import { registerBrandTools } from './tools-brand.ts';
import { registerBatchTool } from './tools-batch.ts';
import { registerScriptTool } from './tools-script.ts';
import { registerComponentTools } from './tools-components.ts';
import { registerDataTools } from './tools-data.ts';
import { registerCodeTools } from './tools-code.ts';
import { registerCustomCheckTools } from './tools-custom-checks.ts';
import { registerCheckTools } from './tools-check.ts';
import { registerComplianceTools } from './tools-compliance.ts';
import { registerDesignTools } from './tools-design.ts';
import { registerDesignKnowledgeTools } from './tools-design-knowledge.ts';
import { registerDesignMdTools } from './tools-design-md.ts';
import { registerDiagramTools } from './tools-diagram.ts';
import { registerPdfTools } from './tools-pdf.ts';
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
import { registerTranslationTools } from './tools-translation.ts';
import { registerReadTools } from './tools-read.ts';
import { registerReplayTools } from './tools-replay.ts';
import { registerReferenceTools } from './tools-references.ts';
import { registerRunTools } from './tools-runs.ts';
import { registerKitTools } from './tools-kits.ts';
import { registerTemplateTools } from './tools-templates.ts';
import { registerTomaccoTools } from './tools-tomacco.ts';
import { registerTransferTools } from './tools-transfer.ts';
import { registerWriteTools } from './tools-write.ts';
import { registerCraftTools } from './tools-craft.ts';

/**
 * Where a tool is listed in the grouped tool list: its module's area, unless named here. An area is a word an agent
 * picks by, so a tool goes where someone would look for it, not where its code lives.
 */
const AREA_OF: Record<string, string> = {
  comments_list: 'comments', comment_add: 'comments', comment_reply: 'comments', export_file: 'transfer', fonts_list: 'fonts', guide_get: 'files', design_lint: 'checks',
  design_verify: 'checks', palette_suggest: 'tokens', tokens_export: 'tokens', icon_search: 'images', icon_insert: 'images',
  modes_list: 'tokens', mode_create: 'tokens', mode_delete: 'tokens', mode_set: 'tokens', text_styles_list: 'tokens', text_style_set: 'tokens', text_style_apply: 'tokens', text_style_delete: 'tokens', design_system_css: 'tokens',
  site_restyle: 'transfer', responsive_variant: 'layout', design_review: 'checks', content_stress: 'checks', focus_order: 'checks', font_audit: 'checks', motion_preset: 'prototype',
  interaction_rules: 'prototype', fonts_captured: 'fonts', commit_create: 'history', commit_list: 'history', commit_diff: 'history', commit_restore: 'history', change_list: 'history', change_revert: 'history',
  branch_create: 'history', branch_merge: 'history', version_save: 'history', version_list: 'history', version_restore: 'history',
};

export interface ToolListOptions { mode?: ToolMode; reviewer?: boolean }

export function registerAllTools(server: McpServer, app: BogenServer, session: Session, options: ToolListOptions = {}): ToolDefiner {
  const plain = toolDefiner(server, app, session);
  // The same definer, with each tool's area set as it is defined.
  const define = ((name: string, ...rest: unknown[]) => {
    const area = plain.area;
    plain.area = AREA_OF[name] ?? area;
    (plain as unknown as (...a: unknown[]) => void)(name, ...rest);
    plain.area = area;
  }) as unknown as ToolDefiner;
  define.tools = plain.tools;
  define.outOfScope = plain.outOfScope;
  const areas: [string, (d: ToolDefiner) => void][] = [
    ['files', registerFileTools], ['read', registerReadTools], ['edit', registerWriteTools], ['edit', registerCraftTools], ['tokens', registerDesignTools],
    ['files', registerDesignKnowledgeTools], ['images', registerImageTools], ['images', registerReferenceTools], ['fonts', registerFontTools], ['components', registerComponentTools], ['code', registerCodeTools],
    ['components', registerLibraryTools], ['layout', registerLayoutTools], ['layout', registerCanvasPlanTools], ['comments', registerLiveTools], ['checks', registerCheckTools],
    ['checks', registerComplianceTools], ['prototype', registerPrototypeTools], ['checks', registerCustomCheckTools], ['proposals', registerProposalTools],
    ['proposals', registerRevisionTools], ['proposals', registerDesignBranchTools], ['web', registerWebTools], ['brand', registerBrandTools], ['components', registerTemplateTools],
    ['omarchy', registerOmarchyTools], ['transfer', registerTransferTools], ['transfer', registerReplayTools], ['transfer', registerTomaccoTools], ['web', registerPublishTools], ['web', registerTranslationTools],
    ['checks', registerDriftTools], ['components', registerKitTools], ['data', registerDataTools], ['proposals', registerRunTools], ['transfer', registerPdfTools], ['edit', registerDiagramTools], ['tokens', registerDesignMdTools],
  ];
  for (const [area, register] of areas) {
    plain.area = area;
    register(define);
  }
  plain.area = 'edit';
  registerBatchTool(define, app, session);
  plain.area = 'edit';
  registerScriptTool(define, app, session);
  plain.area = undefined;
  const reviewer = session.scope === 'critique';
  installToolModes(server, plain, options.mode ?? 'full', { reviewer });
  answerUnknownTools(server, plain, reviewer);
  return plain;
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
function answerUnknownTools(server: McpServer, define: ToolDefiner, reviewer: boolean): void {
  const sdk = server as unknown as { createToolError?: (message: string) => CallToolResult };
  const make = sdk.createToolError?.bind(server);
  if (!make) return;
  sdk.createToolError = (message) => {
    const old = /Tool (\w+) not found/.exec(message)?.[1];
    const now = old ? RENAMED_TOOLS[old] : undefined;
    if (now) return make(`${old} is now called ${now}. Call ${now} with the same arguments.`);
    // A reviewer does not get the tools that change a design: the call says so, rather than that the tool is unknown.
    if (old && reviewer && define.outOfScope.has(old)) return make(reviewerRefusal(old));
    return make(message);
  };
}
