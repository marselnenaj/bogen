#!/usr/bin/env -S npx tsx
// Writes docs/guide/reference/mcp-tools.md from what a real server lists: tools, resources and prompts.
//
//   npx tsx scripts/gen-docs-reference.ts [--check]
//
// The server runs in this process, on a free port and with a temporary data folder that is removed
// afterwards, so it never touches $BOGEN_HOME or a running Bogen. --check exits 1 when the page is out
// of date instead of writing it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BogenServer } from '../packages/server/src/http/server.ts';
import { GUIDES } from '../packages/server/src/mcp/guide.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'guide', 'reference', 'mcp-tools.md');

/** Groups in reading order. A tool that is in none of them lands in "Other tools", with a warning. */
const GROUPS: { title: string; intro: string; tools: string[] }[] = [
  {
    title: 'Files and pages',
    intro: 'Find, open and make files, manage their pages, and learn what the person has open.',
    tools: ['context_get', 'guide_get', 'design_knowledge', 'design_knowledge_update', 'design_verify', 'file_list', 'file_open', 'file_create', 'file_rename', 'page_list', 'page_create', 'page_rename', 'page_delete', 'page_reorder'],
  },
  {
    title: 'Reading the canvas',
    intro: 'Look at layers as an outline, as values, as computed styles and as pictures.',
    tools: ['layer_tree', 'layer_get', 'layer_find', 'layer_styles_computed', 'canvas_screenshot'],
  },
  {
    title: 'Layers and HTML',
    intro: 'Write HTML onto the canvas and change layers one property at a time.',
    tools: ['artboard_create', 'html_write', 'layer_style', 'layer_text', 'text_replace', 'layer_rename', 'layers_rename', 'layer_move', 'layer_duplicate', 'layer_delete', 'layer_set_flags', 'layer_attrs', 'keyframes_get', 'keyframes_set', 'asset_upload', 'batch'],
  },
  {
    title: 'Images',
    intro: 'Crop and filter images as CSS, and trace them into editable SVG.',
    tools: ['image_crop', 'image_filter', 'image_vectorize'],
  },
  {
    title: 'Designs from data',
    intro: 'Data sources of a file, layers bound to their fields, and templates repeated per record.',
    tools: ['data_source_list', 'data_source_set', 'data_source_refresh', 'data_source_delete', 'layer_bind', 'layer_repeat'],
  },
  {
    title: 'Layout and structure',
    intro: 'Group, wrap, align and distribute layers.',
    tools: ['layers_group', 'layers_ungroup', 'layer_wrap', 'layers_align', 'layers_distribute', 'layout_grid_set', 'canvas_plan_get', 'canvas_plan_set'],
  },
  {
    title: 'Tokens, theme modes and text styles',
    intro: 'The design system of a file: CSS variables, their values per mode, and named type styles.',
    tools: ['tokens_get', 'tokens_set', 'tokens_delete', 'tokens_from_css', 'tokens_export', 'modes_list', 'mode_create', 'mode_delete', 'mode_set', 'text_styles_list', 'text_style_set', 'text_style_apply', 'text_style_delete', 'design_system_css'],
  },
  {
    title: 'Fonts and icons',
    intro: 'Families you can use, and Lucide icons as editable vectors.',
    tools: ['fonts_list', 'icon_search', 'icon_insert'],
  },
  {
    title: 'Components and libraries',
    intro: 'Mains, instances, props, variants and slots, and components shared between files.',
    tools: ['component_create', 'component_list', 'component_get', 'component_update', 'instance_create', 'instance_set', 'instance_detach', 'library_publish', 'library_list', 'library_link', 'library_updates', 'library_accept'],
  },
  {
    title: 'Component kits',
    intro: 'Ready libraries such as shadcn/ui and Material 3, with tokens, dark mode and code handoff.',
    tools: ['kit_list', 'kit_use'],
  },
  {
    title: 'Code components',
    intro: 'React components from a project folder on this device, rendered by their own code, its Storybook stories, and its tokens next to the file\'s.',
    tools: ['code_project_link', 'code_components_list', 'code_component_insert', 'code_component_update', 'storybook_import', 'tokens_repo_diff', 'tokens_repo_pull'],
  },
  {
    title: 'Brands',
    intro: 'Brands as documents: their content, versions, assets, extraction and the brand check.',
    tools: ['brand_list', 'brand_create', 'brand_rename', 'brand_duplicate', 'brand_delete', 'brand_link', 'brand_default', 'brand_get', 'brand_book_get', 'brand_book_update', 'brand_update', 'brand_confirm', 'brand_publish', 'brand_versions', 'brand_diff', 'brand_impact', 'brand_apply', 'brand_check', 'voice_check', 'brand_drift', 'brand_extract', 'brand_asset_add', 'brand_asset_list', 'brand_asset_use', 'brand_template_use', 'brand_example_get', 'brand_sheet'],
  },
  {
    title: 'Templates',
    intro: 'Whole files laid out from a brand in one step.',
    tools: ['template_list', 'template_use'],
  },
  {
    title: 'Omarchy themes',
    intro: 'Design an Omarchy theme in a file, then export or install it. Only on a server that listens on this machine alone. Applying a theme is the person\'s click in the editor, so no tool runs `omarchy theme set`. See [Design a theme](../omarchy.md#design-a-theme).',
    tools: ['omarchy_theme_list', 'omarchy_theme_projects', 'omarchy_theme_create', 'omarchy_theme_displays', 'omarchy_theme_export', 'omarchy_theme_install'],
  },
  {
    title: 'Checks',
    intro: 'Measure a design: lint, widths, pixel differences, drift from its live site, against the real app, and saved checks of the file.',
    tools: ['design_lint', 'a11y_audit', 'responsive_check', 'visual_diff', 'drift_check', 'tomacco_compare', 'check_list', 'check_set', 'check_delete', 'check_run'],
  },
  {
    title: 'Responsive variants and prototypes',
    intro: 'Narrower versions of an artboard, and clickable prototypes with variables and interactions.',
    tools: ['responsive_variant', 'variable_set', 'interaction_set', 'prototype_get'],
  },
  {
    title: 'Web craft',
    intro: 'A fluid type and spacing scale, grids and components that adapt by themselves, website sections that work natively, motion with a still alternative, and the checks a designer runs before shipping.',
    tools: ['type_scale_set', 'grid_set', 'container_queries', 'web_page_set', 'section_list', 'section_insert', 'motion_preset', 'design_review', 'focus_order', 'font_audit', 'content_stress'],
  },
  {
    title: 'Export and code',
    intro: 'Files on disk, and code from layers.',
    tools: ['export_file', 'code_get'],
  },
  {
    title: 'Publishing and review links',
    intro: 'Versions of a design as a static site, and review links for clients. An agent prepares and asks; the owner publishes in the editor.',
    tools: ['publish_prepare', 'publish_list', 'share_prepare', 'share_list'],
  },
  {
    title: 'Capture and import',
    intro: 'Live pages and whole sites as editable layers, a page redrawn in a brand, files from Figma, and app screens from Tomacco.',
    tools: ['page_capture', 'site_capture', 'site_capture_status', 'site_restyle', 'interaction_rules', 'fonts_captured', 'figma_import', 'tomacco_import', 'tomacco_status'],
  },
  {
    title: 'History',
    intro: 'The timeline of changes, commits, branches, versions, and a film of how a page was built.',
    tools: ['change_list', 'change_revert', 'commit_create', 'commit_list', 'commit_diff', 'commit_restore', 'branch_create', 'branch_merge', 'version_save', 'version_list', 'version_restore', 'replay_export'],
  },
  {
    title: 'Working next to a person',
    intro: 'Comments, events, pointing at things, proposals for review, and undo of your own steps.',
    tools: ['wait_for_event', 'comments_list', 'comment_add', 'comment_reply', 'selection_set', 'view_focus', 'proposal_create', 'proposal_list', 'proposal_accept', 'proposal_discard', 'agent_undo'],
  },
  {
    title: 'Branches and revisions',
    intro: 'Branches are versions of the whole design inside the same file (tokens, records, components, layers), never files of their own; an agent starts and works in them, the person merges or discards them. Revisions redo artboards as a named draft next to the original instead of a new page: a commit first, the run held to the copies, and accepting keeps the original layers\' ids and edits made meanwhile. A run asked to redo gets one or the other before it starts: a theme gets a branch.',
    tools: ['design_branch_list', 'design_branch_create', 'design_branch_switch', 'revision_start', 'revision_list', 'revision_accept', 'revision_discard'],
  },
];

type Schema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  maxItems?: number;
  additionalProperties?: boolean | Schema;
};

/** Text for a table cell or a paragraph: one line, pipes escaped, tags in code spans so they show. */
function prose(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>/g, (tag) => `\`${tag}\``)))
    .join('')
    // Two tags side by side, such as <a></a>, read better as one code span.
    .replace(/``/g, '')
    .replace(/\|/g, '\\|')
    .trim();
}

function typeOf(s: Schema): string {
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' or ');
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return [...new Set(alts.map(typeOf))].join(' or ');
  const type = Array.isArray(s.type) ? s.type.join(' or ') : s.type;
  if (type === 'array') return s.items ? `array of ${typeOf(s.items)}` : 'array';
  if (type === 'object' && !s.properties && s.additionalProperties && typeof s.additionalProperties === 'object') return `map of ${typeOf(s.additionalProperties)}`;
  return type ?? 'any';
}

function limits(s: Schema): string {
  const parts: string[] = [];
  const min = s.minimum ?? s.exclusiveMinimum;
  // Zod writes Number.MAX_SAFE_INTEGER as the maximum of a plain non-negative integer.
  const max = s.maximum !== undefined && s.maximum < Number.MAX_SAFE_INTEGER ? s.maximum : undefined;
  if (min !== undefined && max !== undefined) parts.push(`${min} to ${max}`);
  else if (max !== undefined) parts.push(`at most ${max}`);
  else if (min !== undefined) parts.push(`at least ${min}`);
  if (s.maxItems !== undefined) parts.push(`at most ${s.maxItems} items`);
  if (s.default !== undefined) parts.push(`default ${JSON.stringify(s.default)}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** Rows for an object's properties, one level of nesting written as parent.child. */
function rows(schema: Schema, prefix = '', depth = 0): string[] {
  const out: string[] = [];
  const required = new Set(schema.required ?? []);
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const full = prefix + name;
    const desc = prose((prop.description ?? '') + limits(prop));
    out.push(`| \`${full}\` | ${prose(typeOf(prop))} | ${required.has(name) ? 'yes' : ''} | ${desc} |`);
    if (depth >= 2) continue;
    const alts = prop.anyOf ?? prop.oneOf;
    const object = prop.properties ? prop : alts?.find((a) => a.properties);
    if (object) out.push(...rows(object, `${full}.`, depth + 1));
    const item = prop.items?.properties ? prop.items : prop.items?.anyOf?.find((a) => a.properties);
    if (item) out.push(...rows(item, `${full}[].`, depth + 1));
  }
  return out;
}

const anchor = (name: string) => name.toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/ /g, '-');

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'bogen-docs-'));
  const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports') });
  await server.listen();
  const client = new Client({ name: 'docs', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.localUrl()}/mcp`)));
    const { tools } = await client.listTools();
    const { resourceTemplates } = await client.listResourceTemplates();
    const { resources } = await client.listResources();
    const { prompts } = await client.listPrompts();
    const instructions = client.getInstructions() ?? '';

    const byName = new Map(tools.map((t) => [t.name, t]));
    const placed = new Set<string>();
    const groups = GROUPS.map((g) => ({ ...g, tools: g.tools.filter((n) => byName.has(n)) }));
    for (const g of GROUPS) for (const n of g.tools) if (!byName.has(n)) process.stderr.write(`note: ${n} is grouped but the server does not list it\n`);
    for (const g of groups) for (const n of g.tools) placed.add(n);
    const rest = tools.map((t) => t.name).filter((n) => !placed.has(n));
    if (rest.length) {
      process.stderr.write(`note: not in a group yet, listed under Other tools: ${rest.join(', ')}\n`);
      groups.push({ title: 'Other tools', intro: 'Tools that have no group in scripts/gen-docs-reference.ts yet.', tools: rest });
    }

    const md: string[] = [];
    md.push('# MCP tools', '');
    md.push(`Generated by \`scripts/gen-docs-reference.ts\` from what a running server lists. Do not edit by hand: run \`npx tsx scripts/gen-docs-reference.ts\` again after a change to the tools.`, '');
    md.push(`The server offers ${tools.length} tools, ${resourceTemplates.length} resource templates and ${prompts.length} prompts. Your agent reaches them through \`bogen mcp\` (stdio) or \`http://127.0.0.1:29990/mcp\` (Streamable HTTP); see [Agents](../agents.md).`, '');
    md.push('Most tools take `file_id` and `page_id` as optional arguments. Left out, `file_id` means the file last opened in this session, then the file the person has open; `page_id` means the page last used in this session, then the page the person is on, then the first page.', '');
    md.push('Read only tools change nothing. Every other tool call is one undo step for its agent, which `agent_undo` can take back. A tool that reaches past the file, to the network, a folder or program on this computer, or another person, says so with `openWorldHint`. The most used tools list an output schema, and return their result as `structuredContent` too.', '');

    md.push('## Contents', '');
    for (const g of groups) md.push(`- [${g.title}](#${anchor(g.title)}): ${g.tools.map((n) => `\`${n}\``).join(', ')}`);
    md.push('- [Resources](#resources)', '- [Prompts](#prompts)', '- [Guides](#guides)', '- [Server instructions](#server-instructions)', '');

    for (const g of groups) {
      md.push(`## ${g.title}`, '', g.intro, '');
      for (const name of g.tools) {
        const tool = byName.get(name)!;
        md.push(`### ${name}`, '');
        const flags = [tool.annotations?.readOnlyHint ? 'Read only.' : '', tool.annotations?.destructiveHint ? 'Destructive.' : '', tool.annotations?.openWorldHint ? 'Reaches past the file.' : ''].filter(Boolean).join(' ');
        if (flags) md.push(`*${flags}*`, '');
        md.push(prose(tool.description ?? ''), '');
        const table = rows(tool.inputSchema as Schema);
        if (table.length) md.push('| Argument | Type | Required | Description |', '| --- | --- | --- | --- |', ...table, '');
        else md.push('No arguments.', '');
        const returns = tool.outputSchema ? rows(tool.outputSchema as Schema) : [];
        if (returns.length) md.push('Returns these fields, also as `structuredContent`:', '', '| Field | Type | Always | Description |', '| --- | --- | --- | --- |', ...returns, '');
      }
    }

    md.push('## Resources', '');
    md.push('Resources show the live state of a file. Clients that support subscriptions get `notifications/resources/updated` when one changes, a short moment after a burst of edits. `resources/list` names them for up to 12 files: the one this session works on, then files a person has open, then the most recent.', '');
    md.push('| URI | Type | Description |', '| --- | --- | --- |');
    for (const r of resourceTemplates) md.push(`| \`${r.uriTemplate}\` | ${r.mimeType ?? ''} | ${prose(r.description ?? '')} |`);
    md.push('');
    if (resources.length) {
      md.push('Fixed resources:', '', '| URI | Description |', '| --- | --- |');
      for (const r of resources) md.push(`| \`${r.uri}\` | ${prose(r.description ?? '')} |`);
      md.push('');
    }

    md.push('## Prompts', '');
    md.push('Starting points a client can offer as commands, such as slash commands in Claude Code.', '');
    for (const p of prompts) {
      md.push(`### ${p.name}`, '');
      if (p.title) md.push(`**${prose(p.title)}.** ${prose(p.description ?? '')}`, '');
      else md.push(prose(p.description ?? ''), '');
      if (p.arguments?.length) {
        md.push('| Argument | Required | Description |', '| --- | --- | --- |');
        for (const a of p.arguments) md.push(`| \`${a.name}\` | ${a.required ? 'yes' : ''} | ${prose(a.description ?? '')} |`);
        md.push('');
      }
    }

    md.push('## Guides', '');
    md.push(`\`guide_get\` returns one of these texts, written for your agent: ${Object.keys(GUIDES).map((k) => `\`${k}\``).join(', ')}. \`bogen install\` writes the same text into the Bogen skill for Claude Code and Codex.`, '');

    md.push('## Server instructions', '');
    md.push('What every client receives when it connects, as the MCP server instructions:', '');
    md.push('```text', instructions.trim(), '```', '');

    const text = `${md.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
    if (process.argv.includes('--check')) {
      let current = '';
      try { current = readFileSync(OUT, 'utf8'); } catch { /* missing counts as stale */ }
      if (current !== text) {
        process.stderr.write(`${OUT} is out of date. Run npx tsx scripts/gen-docs-reference.ts\n`);
        process.exitCode = 1;
      }
      return;
    }
    writeFileSync(OUT, text);
    process.stdout.write(`Wrote ${OUT}: ${tools.length} tools, ${resourceTemplates.length} resource templates, ${prompts.length} prompts.\n`);
  } finally {
    await client.close().catch(() => {});
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
