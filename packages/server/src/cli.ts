import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectionFromEnv, probe, probeState, startDaemon, stopDaemon, type Connection } from './daemon.ts';
import { bogenHome, DEFAULT_PORT, ensurePrivateHome, errorMessage } from './util.ts';
import { FULL_VERSION, VERSION } from './version.ts';

const USAGE = `bogen ${VERSION}: an open source design canvas that your own coding agents draw on

Usage:
  bogen serve [--port ${DEFAULT_PORT}] [--host <addr> --token <secret>] [--tailnet]
                                                              Run in the foreground; --tailnet also listens on the Tailscale address
  bogen start [--port ${DEFAULT_PORT}]                                    Run in the background
  bogen stop                                                  Stop the background server
  bogen status                                                Show whether it runs, and which agents are active
  bogen open [<file>[#<layer>]]                               Open the editor, or a file with a layer selected and in view
  bogen welcome                                               Open the welcome file, made anew if you deleted it
  bogen mcp [--tools full|compact|grouped] [--profile reviewer]
                                                              MCP over stdio, for agents; starts the server if needed
  bogen setup [--agents <claude-code,codex|all|none>]         Find your agents, connect the ones you pick, and say what to do next
  bogen install <claude-code|codex|cursor|vscode|opencode|gemini|zed|grok|hermes|omp|--all> [--tools full|compact|grouped]
                                                              Add Bogen to an MCP client, with the tool list that suits it
  bogen uninstall <client>                                    Take Bogen out of an MCP client again, skill included
  bogen omarchy install|uninstall [--dry-run]                 Bar widget, launcher, keybinding and user service on Omarchy
  bogen omarchy portrait <status|install|enable|…> [--apply]   Portrait screens show a theme's own composition; plans unless --apply
  bogen doctor [--json]                                     Check the whole setup, with the exact fix for each problem. Changes nothing
  bogen live <url> --dir <project>                            Open a dev server in Bogen, to pick elements and have your agent edit the source
  bogen capture <url> | --site <url> [--widths 1440,768,390] [--schemes dark,light] [--limit 30] [--no-fonts]
                                                              Capture a page, or a whole site with one page per route
  bogen import figma <file url> [--token <t>] [--save-token]  Import through Figma's REST API with your own token
  bogen export <file or brand> [<file.bogen>] [--no-brand] [--force]
                                                              Write a .bogen file, with the brand the file links to
  bogen import <file.bogen>                                   Open a .bogen file here, and add the brand it carries
  bogen replay <file> [--page <name>] [--format mp4|webm|gif] [--speed 2] [--max-idle 1.5] [--from <change>] [--to <change>]
               [--run <id>] [--width 1920] [--height 1080] [--fps 30] [--camera auto|grow|fit|follow] [--no-captions] [--no-cursors] [-o <file>]
                                                              Film how a page was built, step by step, from its history
  bogen export-folder <file> <folder> [--no-brand]            Write a design as a folder of text, for Git, its brand in brand/
  bogen import-folder <folder>                                Make a new file from such a folder
  bogen diff <folder A> <folder B> [--json]                   What changed between two design folders
  bogen git init|commit|log|restore <file> [<dir>]            Keep the design folder in a real Git repository. Never pushes
  bogen peer pair [--name <this device>]                      Show what another device needs to sync with this one
  bogen peer add <url> --token <t> [--name <n>]               Pair with a device, both ways
  bogen peer list | status | remove <id> | tailnet <on|off>   Manage paired devices
  bogen peer deploy <ssh-host> [--dry-run]                    Copy this build to another Omarchy device, restart it, report its version
  bogen phone on [--login <a,b>] [--https-port 29443]         Serve Bogen to your phone through tailscale serve, and save that
  bogen phone off | pair | list | remove <id> | status        Turn it off, pair a phone with a code, list and remove phones
  bogen publish status | prepare <file> [<artboard>] | unpublish <site> [target] | remove <site> | off
                                                              Versions of a design as a static site; you publish them in the editor
  bogen share list | revoke <id> | off                        Review links for clients; you make them in the editor
  bogen verify <file> [--sig <f>] [--sha256 <f>] [--json]     Check a release file's checksum and signature against the built-in key
  bogen update [check|apply|rollback|on|off|source <url>|default] [--json]
                                                              Look for a newer release, or verify and install it (npm installs)
  bogen report [--output <file>] [--no-doctor] [--json]       Write a bug-report bundle with secrets masked. Sends nothing
  bogen agents check [--runner claude|codex] [--model <m>] [--json]
                                                              Run your real claude and codex on a throwaway file: a polite request,
                                                              a question and a two-turn chat. Uses your plan, a few small runs
  bogen agents check --repo [--runner claude|codex] [--model <m>] [--keep]
                                                              One design change to a pull request in a throwaway repository with a
                                                              local remote: one real run, a push, a merge. Nothing leaves this machine
  bogen agents trace <run id> [--output <file>]               The trace of one run as JSON, for a bug report, secrets masked

Environment:
  BOGEN_HOME         Data folder (default $XDG_DATA_HOME/bogen or ~/.local/share/bogen)
  BOGEN_PORT         Port (default ${DEFAULT_PORT})
  BOGEN_URL          For \`mcp\`, \`status\`, \`open\`: use a server elsewhere
  BOGEN_TOKEN        Bearer token, as an alternative to --token
  BOGEN_FFMPEG       Path to ffmpeg for video and AVIF, or none to use only the browser
  FIGMA_TOKEN        For \`import figma\`: a Figma personal access token
  BOGEN_PEER_TOKEN   For \`peer add\`: the other device's token, to keep it off the command line
  BOGEN_BROWSER      Path to a Chromium-based browser
  BOGEN_AGENTS       For \`setup\`: the agents to connect without asking, as for --agents
  BOGEN_MCP_TOOLS    For \`mcp\`: full (default), compact or grouped, as for --tools. Every tool stays callable
  BOGEN_MCP_PROFILE  For \`mcp\`: reviewer for a session that reads, checks and comments only, as for --profile
  BOGEN_EXPORT_DIR   Where export_file writes (default ~/Downloads/Bogen)
  BOGEN_UPDATE_CHECK off turns every update check off, also the ones you ask for
  BOGEN_UPDATE_URL   Where releases are fetched from (default the latest GitHub release)
`;

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

function fail(message: string): never {
  process.stderr.write(`bogen: ${message}\n`);
  process.exit(1);
}

function portArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`"${value}" is not a port.`);
  return port;
}

async function serve(values: { port?: string; host?: string; token?: string; dev?: boolean; tailnet?: boolean; 'insecure-allow-any-host'?: boolean }): Promise<void> {
  const host = values.host ?? '127.0.0.1';
  const token = values.token ?? process.env.BOGEN_TOKEN;
  if (!isLoopback(host) && !token) fail('Listening beyond this machine needs a token: pass --token <secret>, or set BOGEN_TOKEN.');
  const home = bogenHome();
  try {
    ensurePrivateHome(home);
  } catch (e) {
    fail(errorMessage(e));
  }
  const { BogenServer } = await import('./http/server.ts');
  const allowedOrigins = process.env.BOGEN_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
  const server = new BogenServer({
    home, host, token, dev: values.dev, allowedOrigins, thumbnails: true, welcome: process.env.BOGEN_WELCOME !== '0',
    // For testing against a stand-in. It decides where a Figma token goes, so only the environment can set it.
    ...(process.env.BOGEN_FIGMA_API ? { figmaApiBase: process.env.BOGEN_FIGMA_API } : {}),
    tailnet: values.tailnet, insecureAllowAnyHost: values['insecure-allow-any-host'], updateChecks: !values.dev,
    port: portArg(values.port) ?? (Number(process.env.BOGEN_PORT) || DEFAULT_PORT),
  });
  try {
    await server.listen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') fail(`Port ${server.options.port} is in use. If that is Bogen already, run \`bogen status\`.`);
    throw e;
  }
  process.stdout.write(`Bogen ${VERSION} on http://${host.includes(':') ? `[${host}]` : host}:${server.port}\n`);
  process.stdout.write(`Data in ${home}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    // An editor, a phone or a peer can hold a socket open; after a moment, stop anyway rather than wait for systemd's kill.
    setTimeout(() => process.exit(0), 3000).unref();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function openUrl(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] as const
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const
      : ['xdg-open', [url]] as const;
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => process.stderr.write(`Could not open a browser. Go to ${url}\n`));
  child.unref();
}

/** Runs integrations/omarchy/<action>.sh from wherever this build came with it. */
function omarchyScript([action, ...args]: string[]): void {
  if (action !== 'install' && action !== 'uninstall') fail('Usage: bogen omarchy install|uninstall [--dry-run] [...], see --help of each');
  const here = dirname(fileURLToPath(import.meta.url));
  // The npm package and a deployed copy keep integrations/ next to dist/, a checkout two levels up.
  const script = [join(here, '..', 'integrations', 'omarchy', `${action}.sh`), join(here, '..', '..', '..', 'integrations', 'omarchy', `${action}.sh`)].find((p) => existsSync(p));
  if (!script) fail('This build came without integrations/omarchy.');
  const child = spawn('bash', [script, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}

async function ensure(conn: Connection): Promise<void> {
  if (process.env.BOGEN_URL) {
    if (!(await probe(conn))) throw new Error(`No Bogen server answers at ${conn.url}.`);
    return;
  }
  await startDaemon(conn);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  // The scripts take their own options, so these pass through unparsed.
  if (command === 'omarchy' && rest[0] === 'portrait') {
    const { portraitCli } = await import('./portrait-cli.ts');
    return portraitCli(rest.slice(1));
  }
  if (command === 'omarchy') return omarchyScript(rest);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      token: { type: 'string' },
      file: { type: 'string' },
      page: { type: 'string' },
      name: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      scheme: { type: 'string' },
      dev: { type: 'boolean' },
      all: { type: 'boolean' },
      tailnet: { type: 'boolean' },
      json: { type: 'boolean' },
      'insecure-allow-any-host': { type: 'boolean' },
      dir: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-brand': { type: 'boolean' },
      force: { type: 'boolean' },
      site: { type: 'string' },
      widths: { type: 'string' },
      schemes: { type: 'string' },
      limit: { type: 'string' },
      'no-fonts': { type: 'boolean' },
      'save-token': { type: 'boolean' },
      login: { type: 'string' },
      'phone-port': { type: 'string' },
      'https-port': { type: 'string' },
      message: { type: 'string', short: 'm' },
      rev: { type: 'string' },
      output: { type: 'string', short: 'o' },
      sig: { type: 'string' },
      sha256: { type: 'string' },
      'no-doctor': { type: 'boolean' },
      from: { type: 'string' },
      to: { type: 'string' },
      run: { type: 'string' },
      format: { type: 'string' },
      speed: { type: 'string' },
      'max-idle': { type: 'string' },
      fps: { type: 'string' },
      camera: { type: 'string' },
      'no-captions': { type: 'boolean' },
      'no-cursors': { type: 'boolean' },
      runner: { type: 'string' },
      model: { type: 'string' },
      agents: { type: 'string' },
      tools: { type: 'string' },
      profile: { type: 'string' },
      repo: { type: 'boolean' },
      keep: { type: 'boolean' },
    },
  });
  const conn = connectionFromEnv(portArg(values.port));
  // For `peer add` this is the other device's token, which the local server has no use for.
  // For `import figma` it is the person's Figma token.
  if (values.token && command !== 'peer' && command !== 'import') conn.token = values.token;

  switch (command) {
    case 'serve':
      return serve(values);
    case 'start': {
      if (values.host && !isLoopback(values.host) && !conn.token) fail('Listening beyond this machine needs a token: pass --token <secret>, or set BOGEN_TOKEN.');
      const status = await startDaemon(conn, values.host);
      process.stdout.write(`Bogen ${status.version} is running on ${conn.url} (pid ${status.pid}).\n`);
      return;
    }
    case 'git': {
      const [action, file, dir] = positionals;
      if (!action || !['init', 'commit', 'log', 'restore'].includes(action) || !file) fail('Usage: bogen git init <file> <dir>\n       bogen git commit <file> [<dir>] [--message <text>]\n       bogen git log <file> [<dir>]\n       bogen git restore <file> [<dir>] [--rev <commit>]');
      await ensure(conn);
      const { gitCommand } = await import('./cli-transfer.ts');
      return gitCommand(conn, action, file, dir, values, (line) => process.stdout.write(`${line}\n`));
    }
    case 'replay': {
      const [file] = positionals;
      if (!file) fail('Usage: bogen replay <file id or name> [--page <name>] [--format mp4|webm|gif] [--speed 2] [--max-idle 1.5] [-o <file>], see bogen --help');
      await ensure(conn);
      const { replayCommand } = await import('./cli-transfer.ts');
      return replayCommand(conn, file, values, (line) => process.stdout.write(`${line}\n`));
    }
    case 'export-folder': {
      const [file, dir] = positionals;
      if (!file || !dir) fail('Usage: bogen export-folder <file id or name> <folder> [--no-brand]');
      await ensure(conn);
      const { exportFolder } = await import('./cli-transfer.ts');
      return exportFolder(conn, file, dir, values, (line) => process.stdout.write(`${line}\n`));
    }
    case 'export': {
      const [file, target] = positionals;
      if (!file) fail('Usage: bogen export <file or brand, id or name> [<file.bogen>] [--no-brand] [--force]');
      await ensure(conn);
      const { exportBogenFile } = await import('./cli-transfer.ts');
      return exportBogenFile(conn, file, target, values, (line) => process.stdout.write(`${line}\n`));
    }
    case 'import-folder': {
      const [dir] = positionals;
      if (!dir) fail('Usage: bogen import-folder <folder> [--name <name>]');
      await ensure(conn);
      const { importFolder } = await import('./cli-transfer.ts');
      return importFolder(conn, dir, values, (line) => process.stdout.write(`${line}\n`));
    }
    case 'diff': {
      const [a, b] = positionals;
      if (!a || !b) fail('Usage: bogen diff <folder A> <folder B> [--json]');
      const { diffCommand } = await import('./cli-transfer.ts');
      return diffCommand(a, b, values, (text) => process.stdout.write(text));
    }
    case 'import': {
      const [kind, url] = positionals;
      if (kind && kind !== 'figma') {
        if (url) fail('Usage: bogen import <file.bogen>');
        await ensure(conn);
        const { importBogenFile } = await import('./cli-transfer.ts');
        return importBogenFile(conn, kind, (line) => process.stdout.write(`${line}\n`));
      }
      if (kind !== 'figma' || !url) fail('Usage: bogen import <file.bogen>\n       bogen import figma <file url> [--token <figma token>] [--save-token] [--name <file name>]');
      await ensure(conn);
      const { figmaImport } = await import('./cli-transfer.ts');
      return figmaImport(conn, url, values, values.token, (line) => process.stdout.write(`${line}\n`));
    }
    case 'capture': {
      if (values.site) {
        await startDaemon(conn);
        const { siteCapture } = await import('./cli-transfer.ts');
        if (!(await siteCapture(conn, values.site, values, (line) => process.stdout.write(`${line}\n`)))) process.exitCode = 1;
        return;
      }
      const url = positionals[0];
      if (!url) fail('Usage: bogen capture <url> [--file <id>] [--page <name>] [--name <artboard>] [--width 1440] [--height 900] [--scheme dark|light]\n       bogen capture --site <url> [--widths 1440,768,390] [--schemes dark,light] [--limit 30] [--no-fonts]');
      await startDaemon(conn);
      const res = await fetch(`${conn.url}/api/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}) },
        body: JSON.stringify({
          url,
          ...(values.file ? { fileId: values.file } : {}),
          ...(values.page ? { pageName: values.page } : {}),
          ...(values.name ? { name: values.name } : {}),
          ...(values.width ? { width: Number(values.width) } : {}),
          ...(values.height ? { height: Number(values.height) } : {}),
          ...(values.scheme ? { colorScheme: values.scheme } : {}),
          ...(values['no-fonts'] ? { captureFonts: false } : {}),
        }),
      });
      const out = await res.json() as Record<string, unknown>;
      if (!res.ok) fail(String(out.error ?? res.status));
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }
    case 'stop': {
      const result = await stopDaemon(conn);
      process.stdout.write(result === 'stopped' ? 'Stopped.\n' : 'It was not running.\n');
      return;
    }
    case 'status': {
      const result = await probeState(conn);
      if (result.state === 'busy') {
        process.stdout.write(`Something on ${conn.url} took the connection and did not reply within 2 s: most likely Bogen, waiting on a busy disk. Try again in a moment.\n`);
        process.exitCode = 1;
        return;
      }
      if (result.state === 'down') {
        process.stdout.write('Not running.\n');
        process.exitCode = 3;
        return;
      }
      const { status } = result;
      process.stdout.write(`Running on ${conn.url}, version ${status.version}, pid ${status.pid}, ${status.files} files.\n`);
      if (status.version !== FULL_VERSION) process.stdout.write(`  This command is ${FULL_VERSION}, so that server runs another build. Restart it.\n`);
      for (const p of status.peers ?? []) if (p.versionMismatch) process.stdout.write(`  ${p.name} runs ${p.version}, which differs. Update it: bogen peer deploy <its ssh host>\n`);
      for (const a of status.agents) process.stdout.write(`  ${a.name}: ${a.status} in "${a.fileName}", last ${a.lastTool}\n`);
      return;
    }
    case 'mcp': {
      const modes = await import('./mcp/tool-modes.ts');
      // --tools and --profile win over the environment; an unknown value is the full list or every tool, and says so.
      const { mode, warning: modeWarning } = modes.parseToolMode(values.tools ?? process.env[modes.TOOLS_VARIABLE]);
      const { profile, warning: profileWarning } = modes.parseToolProfile(values.profile ?? process.env[modes.PROFILE_VARIABLE]);
      for (const w of [modeWarning, profileWarning]) if (w) process.stderr.write(`bogen: ${w}\n`);
      await ensure(conn);
      const { runRelay } = await import('./mcp/relay.ts');
      const headers = { ...(mode !== 'full' ? { [modes.TOOLS_HEADER]: mode } : {}), ...(profile !== 'all' ? { [modes.PROFILE_HEADER]: profile } : {}) };
      return runRelay({ url: `${conn.url}/mcp`, token: conn.token, headers, ensureServer: () => ensure(conn) });
    }
    case 'open': {
      await ensure(conn);
      const url = conn.token ? `${conn.url}/?token=${encodeURIComponent(conn.token)}` : conn.url;
      if (positionals[0]) {
        const { openTarget } = await import('./cli-transfer.ts');
        let target: { hash: string; name: string };
        try {
          target = await openTarget(conn, positionals.join(' '));
        } catch (e) {
          fail(errorMessage(e));
        }
        openUrl(`${conn.token ? url : `${conn.url}/`}${target.hash}`);
        process.stdout.write(`Opening ${target.name}: ${conn.url}/${target.hash}\n`);
        return;
      }
      openUrl(url);
      process.stdout.write(`Opening ${conn.url}\n`);
      return;
    }
    case 'welcome': {
      await ensure(conn);
      const res = await fetch(`${conn.url}/api/welcome`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}) }, body: '{}' });
      const out = await res.json() as { id?: string; created?: boolean; error?: string };
      if (!res.ok || !out.id) fail(String(out.error ?? res.status));
      openUrl(`${conn.token ? `${conn.url}/?token=${encodeURIComponent(conn.token)}` : conn.url}#/file/${out.id}`);
      process.stdout.write(`${out.created ? 'Made the welcome file again' : 'Opening the welcome file'}: ${conn.url}/#/file/${out.id}\n`);
      return;
    }
    case 'setup': {
      const { setup, terminalQuestions } = await import('./setup.ts');
      const agents = values.agents ?? (process.env.BOGEN_AGENTS?.trim() || undefined);
      // Asks only a person at a terminal, and only when nobody said which agents already.
      const questions = agents === undefined && process.stdin.isTTY ? terminalQuestions() : null;
      try {
        process.exitCode = await setup({ agents }, { write: (text) => process.stdout.write(text), ...(questions ? { ask: questions.ask } : {}) });
      } catch (e) {
        fail(errorMessage(e));
      } finally {
        questions?.close();
      }
      return;
    }
    case 'install': {
      const { CLIENTS, install } = await import('./install.ts');
      const all = values.all || positionals.includes('all');
      const named = positionals.filter((p) => p !== 'all');
      for (const name of named) if (!(CLIENTS as readonly string[]).includes(name)) fail(`Unknown client "${name}". Use one of: ${CLIENTS.join(', ')}, or --all.`);
      if (!all && !named.length) fail(`Say which client: ${CLIENTS.join(', ')}, or --all.`);
      const { TOOL_MODES } = await import('./mcp/tool-modes.ts');
      if (values.tools !== undefined && !(TOOL_MODES as readonly string[]).includes(values.tools)) fail(`Unknown tool list "${values.tools}". Use one of: ${TOOL_MODES.join(', ')}.`);
      const results = await install(all ? [...CLIENTS] : named as never[], { onlyDetected: all, ...(values.tools ? { tools: values.tools as never } : {}) });
      for (const r of results) process.stdout.write(`${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'}  ${r.client}: ${r.how}\n`);
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }
    case 'uninstall': {
      const { CLIENTS, uninstall } = await import('./install.ts');
      for (const name of positionals) if (!(CLIENTS as readonly string[]).includes(name)) fail(`Unknown client "${name}". Use one of: ${CLIENTS.join(', ')}.`);
      if (!positionals.length) fail(`Say which client: ${CLIENTS.join(', ')}.`);
      const results = await uninstall(positionals as never[]);
      for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.client}: ${r.how}\n`);
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }
    case 'doctor': {
      const { doctor } = await import('./doctor.ts');
      process.exitCode = await doctor(conn, values.json);
      return;
    }
    case 'live': {
      const target = positionals[0];
      if (!target || !values.dir) fail('Usage: bogen live <dev server url> --dir <project folder>');
      await ensure(conn);
      const res = await fetch(`${conn.url}/api/live/sites`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}) }, body: JSON.stringify({ url: target, dir: resolve(values.dir) }) });
      const out = await res.json() as { id?: string; proxyUrl?: string; error?: string };
      if (!res.ok) fail(String(out.error ?? res.status));
      openUrl(`${conn.url}/#/live/${out.id}`);
      process.stdout.write(`Opening ${target} through ${out.proxyUrl}\n`);
      return;
    }
    case 'peer': {
      if (positionals[0] === 'deploy') {
        const { deployCommand } = await import('./deploy.ts');
        process.exitCode = await deployCommand(positionals[1], { dryRun: Boolean(values['dry-run']), port: values.port });
        return;
      }
      await ensure(conn);
      const { peerCommand } = await import('./peer-cli.ts');
      return peerCommand(conn, positionals, values);
    }
    case 'phone': {
      await ensure(conn);
      const { phoneCommand } = await import('./phone-cli.ts');
      return phoneCommand(conn, positionals, values);
    }
    case 'publish':
    case 'share': {
      await ensure(conn);
      const { publishCommand, shareCommand } = await import('./publish-cli.ts');
      return command === 'publish' ? publishCommand(conn, positionals, values) : shareCommand(conn, positionals, values);
    }
    case 'verify': {
      const { verifyCommand } = await import('./release-verify.ts');
      process.exitCode = verifyCommand(positionals[0], values, (text) => process.stdout.write(text));
      return;
    }
    case 'update': {
      const { updateCommand } = await import('./update-cli.ts');
      process.exitCode = await updateCommand(positionals, values, (text) => process.stdout.write(text));
      return;
    }
    case 'report': {
      const { reportCommand } = await import('./report.ts');
      process.exitCode = await reportCommand(conn, { output: values.output, doctor: !values['no-doctor'], json: values.json }, (text) => process.stdout.write(text));
      return;
    }
    case 'agents': {
      if (positionals[0] === 'trace') {
        const { agentsTraceCommand } = await import('./agents-check-cli.ts');
        process.exitCode = await agentsTraceCommand(conn, positionals[1], values.output, (text) => process.stdout.write(text));
        return;
      }
      if (positionals[0] !== 'check') fail('Usage: bogen agents check [--repo] [--runner claude|codex] [--model <m>] [--keep] [--json]\n       bogen agents trace <run id> [--output <file>]');
      if (values.repo) {
        const { repoCheckCommand } = await import('./repo-check.ts');
        process.exitCode = await repoCheckCommand({ ...(values.runner ? { runner: values.runner } : {}), ...(values.model ? { model: values.model } : {}), keep: Boolean(values.keep), json: Boolean(values.json) }, (text) => process.stdout.write(text));
        return;
      }
      const runner = values.runner;
      if (runner !== undefined && runner !== 'claude' && runner !== 'codex') fail(`--runner is claude or codex, not "${runner}".`);
      const { agentsCheckCommand } = await import('./agents-check-cli.ts');
      process.exitCode = await agentsCheckCommand({ ...(runner ? { runners: [runner] } : {}), ...(values.model ? { model: values.model } : {}), json: Boolean(values.json) }, (text) => process.stdout.write(text));
      return;
    }
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${FULL_VERSION}\n`);
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(USAGE);
      fail(`Unknown command "${command}".`);
  }
}

// `bogen peer status | head` closes the pipe early. That is the reader being done, not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw e;
  });
}
main().catch((e) => fail(errorMessage(e)));
