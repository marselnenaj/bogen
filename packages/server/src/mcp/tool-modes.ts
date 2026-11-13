import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolDefiner } from './kit.ts';

/**
 * The tool list a session sees, in one of three sizes. `full` is every tool with its whole schema. `compact` keeps
 * every tool, with each description cut to its first sentence and no argument descriptions. `grouped` lists one tool
 * per area, such as `brand`, which takes a tool's name as `operation` and its own arguments as `arguments`. In every
 * mode each tool can still be called by its own name, and the `schema` tool and `bogen://reference/{operation}` give
 * any tool's whole schema: the shorter lists change what an agent reads up front, never what it can do.
 */
export const TOOL_MODES = ['full', 'compact', 'grouped'] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

/** `reviewer` is the critique scope outside a run: read-only tools and the comment tools. */
export const TOOL_PROFILES = ['all', 'reviewer'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

/** The environment variables `bogen mcp` reads, and the headers it sends them as. */
export const TOOLS_VARIABLE = 'BOGEN_MCP_TOOLS';
export const PROFILE_VARIABLE = 'BOGEN_MCP_PROFILE';
export const TOOLS_HEADER = 'x-bogen-tools';
export const PROFILE_HEADER = 'x-bogen-profile';

/** A mode by name. An unknown one is the full list, with a warning to say so. */
export function parseToolMode(raw: string | undefined | null): { mode: ToolMode; warning?: string } {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return { mode: 'full' };
  if ((TOOL_MODES as readonly string[]).includes(value)) return { mode: value as ToolMode };
  return { mode: 'full', warning: `${TOOLS_VARIABLE}=${value.slice(0, 40)} is not a tool list Bogen knows (${TOOL_MODES.join(', ')}), so it lists them in full.` };
}

/** A profile by name. An unknown one is all tools, with a warning. */
export function parseToolProfile(raw: string | undefined | null): { profile: ToolProfile; warning?: string } {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return { profile: 'all' };
  if ((TOOL_PROFILES as readonly string[]).includes(value)) return { profile: value as ToolProfile };
  return { profile: 'all', warning: `${PROFILE_VARIABLE}=${value.slice(0, 40)} is not a profile Bogen knows (${TOOL_PROFILES.join(', ')}), so the session gets every tool.` };
}

export const SCHEMA_TOOL = 'schema';
const REFERENCE = 'bogen://reference/';

/** What each area is for, in the grouped tool's description. Areas come from `registerAllTools`. */
export const AREA_PURPOSE: Record<string, string> = {
  files: 'Files, pages, what the person has open, guides and design knowledge',
  read: 'Read layers as an outline, as values, as computed styles and as pictures',
  edit: 'Write HTML and change layers, text, keyframes and assets; batch several steps',
  layout: 'Group, wrap, align and distribute layers, grids and the canvas plan',
  tokens: 'Tokens, theme modes, variables and text styles',
  comments: 'Comment threads and waiting for the person',
  checks: 'Lint, review, accessibility, responsive, drift, compliance and custom checks',
  images: 'Crop, filter and trace images, and icons',
  fonts: 'Font families, captured fonts and fonts made in Bogen',
  components: 'Components, instances, kits, libraries and templates',
  code: 'Code components, Storybook, tokens in a repository, live dev servers',
  prototype: 'Interactions, prototypes and motion',
  web: 'Web pages: sections, type scale, grids, container queries, publishing and sharing',
  proposals: 'Proposals, revisions and design branches the person accepts or discards',
  history: 'Commits, changes, versions and branches of a file, and undo',
  transfer: 'Import, export and capture: .bogen files, Figma, sites, replays, Tomacco',
  brand: 'Brands: rules, colours, fonts, voice, assets, books and checks',
  data: 'Data sources and layers bound to them',
  omarchy: 'Omarchy themes',
};

interface Annotated { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean }

/** The text up to the end of its first sentence: a full stop before a space and a capital, or the end; at most 200 characters, cut at a word. */
export function firstSentence(text: string): string {
  const match = /^[\s\S]*?\.(?= [A-Z])/.exec(text);
  const sentence = match ? match[0] : text;
  if ([...sentence].length <= 200) return sentence;
  const cut = [...sentence].slice(0, 200).join('');
  const space = cut.lastIndexOf(' ');
  return space > 0 ? `${cut.slice(0, space).replace(/[,;:]+$/, '')}…` : cut;
}

/** A JSON schema without its prose: descriptions, `$schema`, and an empty `required`. A property named `description` stays. */
export function stripDescriptions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripDescriptions);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if ((key === 'description' && typeof value === 'string') || key === '$schema') continue;
    if (key === 'required' && Array.isArray(value) && !value.length) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripDescriptions(v)]));
      continue;
    }
    out[key] = stripDescriptions(value);
  }
  return out;
}

/** MCP reads a missing hint as its default, so the short list states only the others. */
const HINT_DEFAULTS: Record<string, boolean> = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function compactTool(tool: Tool): Tool {
  const annotations = Object.fromEntries(Object.entries(tool.annotations ?? {}).filter(([k, v]) => HINT_DEFAULTS[k] === undefined || v !== HINT_DEFAULTS[k]));
  const out: Tool = { name: tool.name, description: firstSentence(tool.description ?? ''), inputSchema: stripDescriptions(tool.inputSchema) as Tool['inputSchema'] };
  if (tool.outputSchema) out.outputSchema = stripDescriptions(tool.outputSchema) as Tool['outputSchema'];
  if (Object.keys(annotations).length) out.annotations = annotations;
  return out;
}

function effect(a: Annotated | undefined): 'read' | 'write' | 'destructive' {
  return a?.readOnlyHint ? 'read' : a?.destructiveHint ? 'destructive' : 'write';
}

/** `layer_style(node_ids, style)`: a tool with the arguments it needs. */
function signature(tool: Tool): string {
  const required = (tool.inputSchema.required ?? []) as string[];
  return required.length ? `${tool.name}(${required.join(', ')})` : tool.name;
}

function groupTool(area: string, tools: Tool[]): Tool {
  const by = (kind: ReturnType<typeof effect>) => tools.filter((t) => effect(t.annotations) === kind).map(signature);
  const lists = [['Read-only', by('read')], ['Writes', by('write')], ['Destructive, ask the person first', by('destructive')]] as const;
  const listed = lists.filter(([, names]) => names.length).map(([label, names]) => `${label}: ${names.join(', ')}.`).join(' ');
  const purpose = AREA_PURPOSE[area];
  const annotations: Annotated = {
    readOnlyHint: tools.every((t) => t.annotations?.readOnlyHint),
    destructiveHint: tools.some((t) => t.annotations?.destructiveHint),
    openWorldHint: tools.some((t) => t.annotations?.openWorldHint),
  };
  return {
    name: area,
    description: `${purpose ? `${purpose}. ` : ''}Run one operation: its tool name as operation, its own arguments as arguments. Required arguments are in parentheses; schema gives the rest. ${listed}`,
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: tools.map((t) => t.name) },
        arguments: { type: 'object', additionalProperties: {} },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    annotations,
  };
}

const schemaTool: Tool = {
  name: SCHEMA_TOOL,
  description: `The whole schema of one tool: its description, every argument with its description, and its annotations. Read it before calling a tool whose arguments you do not know. The resource ${REFERENCE}{operation} has the same.`,
  inputSchema: { type: 'object', properties: { operation: { type: 'string', minLength: 1 } }, required: ['operation'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** A line for the server's instructions: what this list leaves out, and how to reach it. */
export function modeInstructions(mode: ToolMode, profile: ToolProfile): string {
  const lines: string[] = [];
  if (mode === 'compact') lines.push(`This server lists its tools in short form, one sentence each and arguments without descriptions. ${SCHEMA_TOOL} (or the resource ${REFERENCE}{tool}) gives a tool's whole description before you call one you do not know.`);
  if (mode === 'grouped') lines.push(`This server lists one tool per area. Call an area's tool with operation set to a tool name (the names used above, such as context_get or html_write) and arguments set to that tool's arguments; ${SCHEMA_TOOL} gives a tool's arguments. batch steps use the same tool names.`);
  if (profile === 'reviewer') lines.push('This session reviews: it reads, checks and comments, and changes no design. Leave each suggestion as a comment with comment_add.');
  return lines.join('\n');
}

/** Refuses a tool this session does not have, saying why. */
export function reviewerRefusal(name: string): string {
  return `${name} changes the design, and this session is a reviewer: it reads, checks and comments, and changes nothing. Leave a comment with your suggestion instead (comment_add).`;
}

type ListHandler = (request: unknown, extra: unknown) => Promise<{ tools: Tool[] }>;

/**
 * Adds the `schema` tool, one hidden tool per area and the reference resource, and answers tools/list for the mode.
 * Called after every tool is defined, so that the lists are complete; they are made once per session.
 */
export function installToolModes(server: McpServer, define: ToolDefiner, mode: ToolMode, options: { reviewer?: boolean } = {}): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers;
  const sdkList = handlers?.get('tools/list');
  if (!sdkList) throw new Error('The MCP SDK no longer keeps its tools/list handler where Bogen reads it.');
  let full: Promise<Map<string, Tool>> | null = null;
  const wholeTools = () => (full ??= sdkList({ method: 'tools/list', params: {} }, {}).then((r) => new Map(r.tools.map((t) => [t.name, t]))));
  const areas = new Map<string, string[]>();
  for (const [name, entry] of define.tools) {
    if (!entry.area) continue;
    const list = areas.get(entry.area) ?? [];
    list.push(name);
    areas.set(entry.area, list);
  }
  for (const area of areas.keys()) if (define.tools.has(area) || area === SCHEMA_TOOL) throw new Error(`The area ${area} has the name of a tool.`);

  const unknownTool = (name: string) => {
    if (options.reviewer && define.outOfScope.has(name)) return reviewerRefusal(name);
    const near = [...define.tools.keys()].filter((n) => n.split('_')[0] === name.split('_')[0]).slice(0, 8);
    return `There is no tool ${name}.${near.length ? ` Close ones: ${near.join(', ')}.` : ''}`;
  };

  const answerSchema = async (operation: string): Promise<Tool> => {
    const tool = (await wholeTools()).get(operation);
    if (!tool) throw new Error(unknownTool(operation));
    const area = define.tools.get(operation)?.area;
    return { ...tool, ...(area && mode === 'grouped' ? { _meta: { area } } : {}) };
  };

  server.registerTool(SCHEMA_TOOL, {
    description: schemaTool.description,
    inputSchema: { operation: z.string().min(1) },
    annotations: schemaTool.annotations,
  }, async ({ operation }) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await answerSchema(operation), null, 1) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  });

  for (const [area, names] of areas) {
    server.registerTool(area, {
      description: `${area} operations.`,
      inputSchema: z.looseObject({ operation: z.string(), arguments: z.unknown().optional() }),
    }, async (args, extra): Promise<CallToolResult> => {
      const refuse = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
      const { operation, arguments: inner, ...rest } = args as { operation: string; arguments?: unknown } & Record<string, unknown>;
      const stray = Object.keys(rest);
      if (stray.length) return refuse(`Unknown argument ${stray[0]}. ${area} takes operation and arguments, the tool's own arguments: {"operation":"${names[0]}","arguments":{…}}.`);
      if (!names.includes(operation)) {
        const elsewhere = define.tools.get(operation)?.area;
        if (elsewhere) return refuse(`${operation} is in ${elsewhere}, not ${area}. Call ${elsewhere} with it, or ${operation} by its own name.`);
        if (options.reviewer && define.outOfScope.has(operation)) return refuse(reviewerRefusal(operation));
        return refuse(`${area} has no operation ${JSON.stringify(operation)}. operation is one of ${names.join(', ')}.`);
      }
      if (inner !== undefined && (inner === null || typeof inner !== 'object' || Array.isArray(inner))) return refuse('arguments must be an object of the tool\'s own arguments.');
      const entry = define.tools.get(operation)!;
      const parsed = await z.object(entry.shape).safeParseAsync(inner ?? {});
      if (!parsed.success) return refuse(`Invalid arguments for ${operation}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ')}. ${SCHEMA_TOOL} gives its arguments.`);
      return entry.call(parsed.data, extra as { signal?: AbortSignal });
    });
  }

  server.registerResource('tool-reference', new ResourceTemplate(`${REFERENCE}{operation}`, {
    list: undefined,
    complete: { operation: (value) => [...define.tools.keys()].filter((n) => n.startsWith(value)).slice(0, 100) },
  }), { title: 'Tool reference', description: 'The whole schema of one tool, as the full tool list has it.', mimeType: 'application/json' }, async (uri, variables) => {
    const operation = String(variables.operation);
    const tool = (await wholeTools()).get(operation);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, unknownTool(operation));
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(tool, null, 1) }] };
  });

  const hidden = new Set([SCHEMA_TOOL, ...areas.keys()]);
  let listed: Promise<{ tools: Tool[] }> | null = null;
  const list = async (): Promise<{ tools: Tool[] }> => {
    const whole = [...(await wholeTools()).values()].filter((t) => !hidden.has(t.name));
    if (mode === 'full') return { tools: whole };
    if (mode === 'compact') return { tools: [...whole.map(compactTool), schemaTool] };
    const byName = new Map(whole.map((t) => [t.name, t]));
    return { tools: [...[...areas].map(([area, names]) => groupTool(area, names.map((n) => byName.get(n)!).filter(Boolean))), schemaTool] };
  };
  server.server.setRequestHandler(ListToolsRequestSchema, () => (listed ??= list()));
}
