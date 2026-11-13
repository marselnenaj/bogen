#!/usr/bin/env -S npx tsx
// Writes Bogen's client plugins from the server's own text and version, so they cannot drift from `bogen install`:
//
//   .claude-plugin/marketplace.json                   Claude Code marketplace: /plugin marketplace add marselnenaj/bogen
//   integrations/claude-code/                         the Claude Code plugin: manifest, .mcp.json and the skill
//   .agents/plugins/marketplace.json                  Codex marketplace: codex plugin marketplace add marselnenaj/bogen
//   integrations/codex/                               the Codex plugin, in the portable Agent Plugins layout
//   integrations/claude-desktop/manifest.json         the Claude Desktop extension, packed by scripts/build-mcpb.mjs
//
//   npx tsx scripts/gen-plugins.ts [--check]
//
// Each plugin starts the `bogen` command that install.sh puts in ~/.local/bin, over stdio, and that command talks to the
// loopback server only. Nothing here bundles Bogen itself: install it first with the install script. --check exits 1
// when a file is out of date instead of writing it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillText } from '../packages/server/src/skill.ts';
import { VERSION } from '../packages/server/src/version.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/marselnenaj/bogen';
const HOMEPAGE = 'https://bogen.dev';
const AUTHOR = { name: 'Marsel Nenaj', url: REPOSITORY };
const DESCRIPTION = 'An open source design canvas where every layer is real HTML and CSS, drawn by your own coding agent over MCP. Needs Bogen installed: curl -fsSL https://bogen.dev/install.sh | bash';
const KEYWORDS = ['design', 'canvas', 'html', 'css', 'mcp', 'local-first'];

/** The skill as `bogen install` writes it, without the line that says `bogen uninstall` removes it: a plugin's goes with the plugin. */
const pluginSkill = (client: string) => skillText(client).replace(/\n<!-- Managed by Bogen:[^\n]*-->\n/, '\n');

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function pluginFiles(): Record<string, string> {
  return {
    '.claude-plugin/marketplace.json': json({
      $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
      name: 'bogen',
      owner: AUTHOR,
      description: 'Bogen, the open source design canvas for coding agents.',
      plugins: [{ name: 'bogen', source: './integrations/claude-code', description: DESCRIPTION, version: VERSION, category: 'design', homepage: HOMEPAGE }],
    }),
    'integrations/claude-code/.claude-plugin/plugin.json': json({
      $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
      name: 'bogen',
      displayName: 'Bogen',
      version: VERSION,
      description: DESCRIPTION,
      author: AUTHOR,
      homepage: HOMEPAGE,
      repository: REPOSITORY,
      license: 'GPL-3.0-or-later',
      keywords: KEYWORDS,
      icon: './assets/icon.png',
    }),
    // The whole tool list: Claude Code loads MCP tool schemas on demand with its tool search.
    'integrations/claude-code/.mcp.json': json({ mcpServers: { bogen: { type: 'stdio', command: 'bogen', args: ['mcp'] } } }),
    'integrations/claude-code/skills/bogen/SKILL.md': pluginSkill('claude-code'),
    '.agents/plugins/marketplace.json': json({
      name: 'bogen',
      interface: { displayName: 'Bogen' },
      plugins: [{ name: 'bogen', source: { source: 'local', path: './integrations/codex' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Design' }],
    }),
    'integrations/codex/plugin.json': json({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'bogen',
      version: VERSION,
      description: DESCRIPTION,
      author: AUTHOR,
      homepage: HOMEPAGE,
      repository: REPOSITORY,
      license: 'GPL-3.0-or-later',
      keywords: KEYWORDS,
      extensions: {
        'com.openai': {
          interface: {
            displayName: 'Bogen',
            shortDescription: 'Design on a local HTML and CSS canvas',
            longDescription: 'Bogen is a design canvas on your own computer where every layer is real HTML and CSS. Your agent draws, checks and comments through its MCP tools while you watch and edit in the browser.',
            developerName: 'Marsel Nenaj',
            category: 'Design',
            websiteURL: HOMEPAGE,
            defaultPrompt: ['Open Bogen and design a landing page for this project'],
            composerIcon: './assets/icon.png',
            logo: './assets/icon.png',
          },
        },
      },
    }),
    // Codex finds MCP tools with its tool search on the models that have it, so the whole list here too.
    'integrations/codex/mcp.json': json({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { bogen: { type: 'stdio', command: 'bogen', args: ['mcp'] } } }),
    'integrations/codex/skills/bogen/SKILL.md': pluginSkill('codex'),
    'integrations/claude-desktop/manifest.json': json({
      $schema: 'https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/schemas/mcpb-manifest-v0.3.schema.json',
      manifest_version: '0.3',
      name: 'bogen',
      display_name: 'Bogen',
      version: VERSION,
      description: 'A local design canvas where every layer is real HTML and CSS, drawn by Claude.',
      long_description: 'Bogen is an open source design canvas on your own computer. Claude draws, checks and comments on screens through its tools while you watch and edit in the browser. This extension starts the bogen command that the install script puts in ~/.local/bin, which talks to the Bogen server on this computer only. Install Bogen first: curl -fsSL https://bogen.dev/install.sh | bash',
      author: AUTHOR,
      homepage: HOMEPAGE,
      repository: { type: 'git', url: `${REPOSITORY}.git` },
      documentation: `${HOMEPAGE}/docs/agents`,
      support: `${REPOSITORY}/issues`,
      icon: 'icon.png',
      license: 'GPL-3.0-or-later',
      keywords: KEYWORDS,
      server: {
        type: 'binary',
        entry_point: 'bogen',
        mcp_config: {
          command: '${HOME}/.local/bin/bogen',
          args: ['mcp', '--tools', '${user_config.tools}'],
          env: {},
        },
      },
      user_config: {
        tools: {
          type: 'string',
          title: 'Tool list',
          description: 'full lists every tool with its whole schema; compact one sentence each; grouped one tool per area. Every tool stays callable in each.',
          default: 'full',
          required: false,
        },
      },
      compatibility: { platforms: ['darwin', 'linux'] },
    }),
  };
}

/** The app icon, the same in each plugin. */
const ICON = 'apps/editor/public/icons/icon-512.png';
export const PLUGIN_ICONS = ['integrations/claude-code/assets/icon.png', 'integrations/codex/assets/icon.png', 'integrations/claude-desktop/icon.png'];

function main(): void {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  const icon = readFileSync(join(ROOT, ICON));
  const files: [string, string | Buffer][] = [...Object.entries(pluginFiles()), ...PLUGIN_ICONS.map((p) => [p, icon] as [string, Buffer])];
  for (const [path, text] of files) {
    const file = join(ROOT, path);
    const now = existsSync(file) ? readFileSync(file) : null;
    if (now && now.equals(Buffer.from(text))) continue;
    if (check) {
      stale.push(path);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`Wrote ${path}`);
  }
  if (stale.length) {
    console.error(`Out of date: ${stale.join(', ')}. Run npx tsx scripts/gen-plugins.ts`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
