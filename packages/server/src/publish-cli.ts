import type { Connection } from './daemon.ts';
import type { PublishRequest, PublishSite } from './publish.ts';
import type { ClientCommentItem, ShareLink, ShareState } from './shares.ts';
import type { StaticListenerStatus } from './static-listener.ts';

/**
 * `bogen publish ...` and `bogen share ...`. The CLI can make a version, look, and take things back: unpublish,
 * turn a listener off, revoke a link. Making anything reachable from elsewhere is the owner's step in the editor,
 * and the server refuses it from here, so these commands do not offer it.
 */

type Values = Record<string, string | boolean | undefined>;

interface Overview {
  sites: (PublishSite & { fileName?: string })[];
  requests: PublishRequest[];
  shares: (Omit<ShareLink, 'hash'> & { state: ShareState })[];
  inbox: ClientCommentItem[];
  listeners: { site: StaticListenerStatus; review: StaticListenerStatus };
  funnelPolicy: string[];
}

class Refused extends Error {}

async function call<T>(conn: Connection, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${conn.url}${path}`, {
      method,
      headers: { ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Refused(`No Bogen server answers at ${conn.url}.`);
  }
  const text = await res.text();
  let parsed: { error?: string } & T;
  try {
    parsed = JSON.parse(text) as { error?: string } & T;
  } catch {
    throw new Refused(`The server at ${conn.url} gave an unexpected answer (${res.status}).`);
  }
  if (res.status === 404 && /No route/.test(parsed.error ?? '')) throw new Refused(`The server at ${conn.url} is older than this command. Restart it: systemctl --user restart bogen, or bogen stop.`);
  if (!res.ok) throw new Refused(parsed.error ?? `The server answered ${res.status}.`);
  return parsed;
}

async function findFile(conn: Connection, nameOrId: string): Promise<{ id: string; name: string }> {
  const files = await call<{ id: string; name: string }[]>(conn, 'GET', '/api/files');
  const byId = files.find((f) => f.id === nameOrId);
  if (byId) return byId;
  const named = files.filter((f) => f.name === nameOrId);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Refused(`Several files are called "${nameOrId}": ${named.map((f) => f.id).join(', ')}. Use an id.`);
  throw new Refused(`No file has the id or name "${nameOrId}".`);
}

const date = (at: number) => new Date(at).toLocaleString();

function listenerLine(name: string, l: StaticListenerStatus): string {
  if (!l.on) return `${name}: off`;
  const where = l.public ? 'public on the internet through Funnel' : 'on the tailnet only';
  const serve = { ours: '', free: `, but tailscale serve has nothing on https port ${l.httpsPort}`, taken: `, but another app uses https port ${l.httpsPort}`, unknown: ', tailscale serve cannot be read' }[l.serve];
  return `${name}: on, ${where}${serve}${l.url ? `, ${l.url}` : ''}`;
}

const PUBLISH_USAGE = 'Usage: bogen publish status | list [--file <file>] | prepare <file> [<artboard id>] [--page <id>] [--name <title>] | unpublish <site> [listener|folder|github] | remove <site> | off';
const SHARE_USAGE = 'Usage: bogen share list | revoke <id> | off';

export async function publishCommand(conn: Connection, positionals: string[], values: Values): Promise<void> {
  const [action, a, b] = positionals;
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  try {
    switch (action) {
      case 'status':
      case 'list':
      case undefined: {
        const file = typeof values.file === 'string' ? await findFile(conn, values.file) : null;
        const state = await call<Overview>(conn, 'GET', `/api/publish${file ? `?fileId=${encodeURIComponent(file.id)}` : ''}`);
        if (values.json) return out(JSON.stringify({ sites: state.sites, requests: state.requests, listeners: state.listeners }));
        out(listenerLine('Site listener', state.listeners.site));
        out(listenerLine('Review listener', state.listeners.review));
        if (!state.sites.length) out('Nothing prepared yet. Make a version: bogen publish prepare <file> [<artboard id>]');
        for (const s of state.sites) {
          const n = (id?: string) => s.versions.find((v) => v.id === id)?.n;
          const live = [
            s.live.listener ? `Bogen's site v${n(s.live.listener)}` : '',
            s.live.folder ? `${s.live.folder.path} v${n(s.live.folder.version)}` : '',
            s.live.github ? `${s.live.github.repo} ${s.live.github.branch} v${n(s.live.github.version)}` : '',
          ].filter(Boolean);
          out('');
          out(`${s.id}  ${s.name}${s.fileName ? ` in ${s.fileName}` : ''}`);
          out(`  live: ${live.join('; ') || 'nowhere'}`);
          for (const v of s.versions.slice(-5)) out(`  v${v.n}  ${date(v.at)}  by ${v.by}, ${v.files} files${v.notes.length ? `; ${v.notes.join(' ')}` : ''}`);
        }
        if (state.requests.length) {
          out('');
          out(`${state.requests.length} request${state.requests.length === 1 ? '' : 's'} from agents wait${state.requests.length === 1 ? 's' : ''} for you in the editor's Publish dialog.`);
        }
        if (state.inbox.length) out(`${state.inbox.length} comment${state.inbox.length === 1 ? '' : 's'} from clients wait${state.inbox.length === 1 ? 's' : ''} in the editor's inbox.`);
        return;
      }
      case 'prepare': {
        if (!a) throw new Refused(PUBLISH_USAGE);
        const file = await findFile(conn, a);
        const made = await call<{ site: PublishSite; version: PublishSite['versions'][number] }>(conn, 'POST', '/api/publish/prepare', {
          fileId: file.id, ...(b ? { nodeId: b } : {}), ...(typeof values.page === 'string' ? { pageId: values.page } : {}), ...(typeof values.name === 'string' ? { title: values.name } : {}),
        });
        if (values.json) return out(JSON.stringify(made));
        out(`Made v${made.version.n} of ${made.site.name} (site ${made.site.id}): ${made.version.files} files, ${Math.round(made.version.bytes / 1024)} kB.`);
        for (const note of made.version.notes) out(`  ${note}`);
        out('Nothing is published. Send it somewhere from the Publish dialog in the editor.');
        return;
      }
      case 'unpublish': {
        if (!a || (b && !['listener', 'folder', 'github'].includes(b))) throw new Refused(PUBLISH_USAGE);
        if (b === 'github') throw new Refused('Taking a site off GitHub Pages pushes a commit. Do it in the editor, where you see what it removes.');
        const done = await call<{ removed: string[]; kept: string[] }>(conn, 'POST', `/api/publish/sites/${encodeURIComponent(a)}/unpublish`, b ? { target: b } : {});
        if (values.json) return out(JSON.stringify(done));
        out(done.removed.length ? `Taken back from: ${done.removed.join(', ')}.` : 'It was not published there.');
        if (done.kept.length) out(`Files Bogen did not write stay in the folder: ${done.kept.slice(0, 5).join(', ')}${done.kept.length > 5 ? ', ...' : ''}`);
        return;
      }
      case 'remove': {
        if (!a) throw new Refused(PUBLISH_USAGE);
        await call(conn, 'DELETE', `/api/publish/sites/${encodeURIComponent(a)}`);
        return out(`Site ${a} and its versions are gone.`);
      }
      case 'off': {
        const done = await call<{ outcome: { message: string } | null }>(conn, 'POST', '/api/publish/listeners/site', { on: false });
        out('The site listener is off, and stays off after a restart.');
        if (done.outcome) out(done.outcome.message);
        return;
      }
      case 'on':
        throw new Refused('Turning the site listener on makes it reachable from elsewhere. Do it in the editor, in the Publish dialog.');
      default:
        throw new Refused(PUBLISH_USAGE);
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stderr.write(`bogen: ${e.message}\n`);
    process.exitCode = 1;
  }
}

export async function shareCommand(conn: Connection, positionals: string[], values: Values): Promise<void> {
  const [action, a] = positionals;
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  try {
    switch (action) {
      case 'list':
      case undefined: {
        const state = await call<Overview>(conn, 'GET', '/api/publish');
        if (values.json) return out(JSON.stringify({ shares: state.shares, inbox: state.inbox.length }));
        out(listenerLine('Review listener', state.listeners.review));
        if (!state.shares.length) out('No review links. Make one in the editor: Share for review.');
        for (const s of state.shares) {
          const site = state.sites.find((x) => x.id === s.siteId);
          const v = site?.versions.find((x) => x.id === s.versionId)?.n;
          out(`${s.id}  ${s.label}  ${site?.name ?? '?'} v${v ?? '?'}  ${s.state}, ${s.views}${s.maxViews ? `/${s.maxViews}` : ''} views, until ${date(s.expiresAt)}${s.comments ? ', takes comments' : ''}`);
        }
        if (state.inbox.length) out(`${state.inbox.length} comment${state.inbox.length === 1 ? '' : 's'} from clients wait${state.inbox.length === 1 ? 's' : ''} in the editor's inbox.`);
        return;
      }
      case 'revoke': {
        if (!a) throw new Refused(SHARE_USAGE);
        await call(conn, 'DELETE', `/api/shares/${encodeURIComponent(a)}`);
        return out(`Link ${a} no longer works.`);
      }
      case 'off': {
        const done = await call<{ outcome: { message: string } | null }>(conn, 'POST', '/api/publish/listeners/review', { on: false });
        out('The review listener is off, and stays off after a restart. No review link opens until it is on again.');
        if (done.outcome) out(done.outcome.message);
        return;
      }
      case 'create':
      case 'on':
        throw new Refused('Review links are made in the editor, in Share for review, and shown there once.');
      default:
        throw new Refused(SHARE_USAGE);
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stderr.write(`bogen: ${e.message}\n`);
    process.exitCode = 1;
  }
}
