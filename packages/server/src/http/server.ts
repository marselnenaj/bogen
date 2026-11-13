import { ScreenPreviews } from '../screen-previews.ts';
import { allKits, ensureKitLibrary, kitSummary } from '../kits/index.ts';
import { fillMode, planModeCapture, recordCapture, type ModeReport } from '../capture-modes.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { addFontFaces, cleanRunLanguage, getGlyphFont, newId, setInteractionRecord, Y, BogenDoc } from '@bogen/core';
import { runInstructions, Runs, type RunEnd } from '../agents.ts';
import { handleBrandRoute } from '../brand-http.ts';
import { exampleList, runTemplate, EXAMPLES } from '../templates/index.ts';
import { DesignQuality } from '../design-quality.ts';
import { DISCIPLINE_IDS, KNOWLEDGE_ACTIONS, readKnowledge } from '../design-knowledge/index.ts';
import { KnowledgeLibrary, KnowledgeChange } from '../design-knowledge/library.ts';
import { Welcome } from '../welcome.ts';
import { Brands } from '../brand-store.ts';
import { Libraries } from '../library.ts';
import { AgentSteps } from '../agent-steps.ts';
import { AwayLog } from '../away.ts';
import { LiveSites } from '../live-site.ts';
import { PullRequests } from '../pull-requests.ts';
import { RunTraces } from '../run-trace.ts';
import { resolveMentions } from '../chat-context.ts';
import { ClientRuns } from '../client-runs.ts';
import { StorybookWatch } from '../storybook.ts';
import { CodeBuilder } from '../code-build.ts';
import { frameFromUrl } from '../code-measure.ts';
import { CodeProjects } from '../code-projects.ts';
import { handleCodeRoute, syncStories } from './code-routes.ts';
import { Notifications } from '../notifications.ts';
import { RunHistory } from '../run-history.ts';
import { Conversations, observers } from '../conversations.ts';
import { RunSummaries } from '../run-summary.ts';
import { RemoteRuns } from '../remote-runs.ts';
import { DecisionMemory } from '../memory.ts';
import { ScoreHistory } from '../brand-scores.ts';
import { Races } from '../race.ts';
import { RunSettingsStore, EFFORT_ID, MODEL_ID } from '../run-settings.ts';
import { RUNNER_IDS, MAX_DIRECTION_LANES, cleanVariation, VARIATION_ASPECTS, VARIATION_RANGES } from '@bogen/core';
import { agentRoutes } from './agent-routes.ts';
import { clientRoutes } from './client-routes.ts';
import { install, type Client, type InstallResult } from '../install.ts';
import { exportBogen, importBogen } from '../bogen-transfer.ts';
import { CommentRuns } from '../comment-runs.ts';
import { ReplyTargets } from '../reply-targets.ts';
import { EventHub, type BogenEvent } from '../events.ts';
import { exportTarget, reportHeader } from '../exporter.ts';
import { importPdf, importSummary, importSvg, MAX_IMPORT_BYTES, sniffLayerFile } from '../layer-import.ts';
import { checkWidths } from '../width-check.ts';
import { FileEvents } from '../file-events.ts';
import { History, type HistoryOptions } from '../history.ts';
import { GitBindings } from '../git-mirror.ts';
import { createCommit } from '../history-ops.ts';
import { Timeline, type TimelineOptions } from '../timeline.ts';
import { rememberEdit } from '../recent-edits.ts';
import { TimelineSync } from '../timeline-sync.ts';
import { SiteJobs } from '../site-capture.ts';
import { listFonts } from '../fonts.ts';
import { McpGateway } from '../mcp/gateway.ts';
import { isLocalOnlyPath, isPeerPath, PeerManager, type PeerOptions } from '../peers.ts';
import { decideProposal, inbox } from '../inbox.ts';
import { keepToOwnUser } from '../local-user.ts';
import { Phone, phoneRefusedPath, type PhoneDevice } from '../phone.ts';
import { PushNotices, type PushFetch } from '../push.ts';
import { CatchUpBody, phoneCatchUp, phoneHosts } from '../phone-sync.ts';
import { PeerDeploys } from '../peer-deploy.ts';
import { runImages } from '../run-images.ts';
import { platformTheme } from '../platform.ts';
import { NO_PLATFORM_LANGUAGE, platformLanguage } from '../platform-language.ts';
import { Renderer } from '../render.ts';
import { thumbnailTarget, THEME_THUMBNAIL_REVISION, THUMBNAIL_REVISION } from '../thumbnail-target.ts';
import { runSavedChecks } from '../custom-checks.ts';
import { FILE_ID, Storage, type FileEntry } from '../storage.ts';
import { capturePage, type CaptureResult } from '../capture.ts';
import type { FontReport } from '../capture-sheets.ts';
import { resolveRuleLayers } from '../capture-sheets.ts';
import { agentOrigin, Rooms } from '../sync.ts';
import { tailscaleCli, type TailscaleCli } from '../tailnet.ts';
import { nextArtboardX } from '../mcp/kit.ts';
import { atomicWrite, DEFAULT_PORT, errorMessage, HttpError } from '../util.ts';
import { UpdateWatch } from '../updates.ts';
import { MAX_COLORS, MIN_COLORS, VECTORIZE_DETAILS, vectorizeAsset } from '../vectorize.ts';
import { buildGlyphFontInto } from '../glyph-font-build.ts';
import { FULL_VERSION, VERSION } from '../version.ts';
import { checkRequest, COOKIE, tokenMatches, type GuardOptions } from './security.ts';
import { serveEditor } from './static.ts';
import { receiveAsset, serveAsset } from './assets.ts';
import { handleTransfer } from './transfer-routes.ts';
import { handleReplayRoute } from './replay-routes.ts';
import { handleFolders } from './folder-routes.ts';
import { handleDesignBranches } from './branch-routes.ts';
import { handleTomacco } from './tomacco-routes.ts';
import { handleVoiceRoute, voiceNotes } from '../voice.ts';
import { handlePublishRoute } from './publish-routes.ts';
import { Publisher } from '../publish.ts';
import { ghCli, type GhCli } from '../publish-github.ts';
import { Shares } from '../shares.ts';
import { StaticListener } from '../static-listener.ts';
import { fetchPublic } from '../net-guard.ts';
import { handleDriftRoutes } from './drift-routes.ts';
import { extensionCors, ExtensionPairings, handleExtensionRoute } from '../extension.ts';
import { EXTENSION_ROUTE } from '../extension-origin.ts';
import { cleanTags, imagePalette, References } from '../references.ts';
import { handleComplianceRoutes } from './compliance-routes.ts';
import { MemoryGauge, type MemoryReading } from '../memory-pressure.ts';
import { prepareRunIntent, settleRunRevision } from '../run-intent.ts';
import { prepareRunKnowledge } from '../run-knowledge.ts';
import { prepareRunLanguage } from '../run-language.ts';

const JSON_LIMIT = 4 * 1024 * 1024;
const MCP_LIMIT = 8 * 1024 * 1024;
const IMPORT_LIMIT = 512 * 1024 * 1024;
const THUMBNAIL_DELAY_MS = 30_000;
const THUMBNAIL_STARTUP_MS = 20_000;
const THUMBNAIL_PAUSE_MS = 30_000;
/** Between two previews of the backlog, so memory from one is given back before the next file loads. */
const BACKLOG_GAP_MS = 2_000;

export interface ServerOptions extends PeerOptions {
  home: string;
  port?: number;
  host?: string;
  token?: string;
  dev?: boolean;
  allowedOrigins?: string[];
  /** Render dashboard thumbnails in the background. */
  thumbnails?: boolean;
  thumbnailDelayMs?: number;
  /** Files that never had a preview wait this long after start, so the editor is usable first. Default 20 s. */
  thumbnailStartupMs?: number;
  /** How long background previews wait after finding the machine short of memory. Default 30 s. */
  thumbnailPauseMs?: number;
  /** Tests: the memory reading, instead of /proc. */
  memory?: () => MemoryReading;
  idleMs?: number;
  /** How often imported stories are compared with their files. */
  storybookIntervalMs?: number;
  agentExpiryMs?: number;
  exportDir?: string;
  versions?: HistoryOptions;
  timeline?: Partial<TimelineOptions>;
  /** Tests only: where the Figma REST API is. */
  figmaApiBase?: string;
  /** Tests: the phone listener's port, 0 for any. The saved setting otherwise. */
  phonePort?: number;
  /** Tests: the HTTPS port that `tailscale serve` is said to use for the phone. */
  phoneHttpsPort?: number;
  /** Tests: a stand-in for the Tailscale CLI. */
  tailscale?: TailscaleCli;
  /** Tests: how a notification reaches the phone's push service. */
  pushFetch?: PushFetch;
  /** Tests: the script "Update the other device" runs, and what it gets in its environment. */
  deployScript?: string | null;
  deployEnv?: NodeJS.ProcessEnv;
  /** Check for a new release once a day, unless the person turned it off. `bogen serve` sets it; tests do not. */
  updateChecks?: boolean;
  /** Make the welcome file on the first start of an empty data folder. `bogen serve` does, unless BOGEN_WELCOME=0. */
  welcome?: boolean;
  /** Tests: the ports of the site and review listeners, 0 for any, and the HTTPS ports they are said to have. */
  sitePort?: number;
  reviewPort?: number;
  siteHttpsPort?: number;
  reviewHttpsPort?: number;
  /** Tests: a stand-in for the GitHub CLI. */
  gh?: GhCli;
  /** Tests: how a publish reaches the internet for fonts and images. Null for not at all. */
  publishFetch?: typeof fetchPublic | null;
}

interface Omarchy {
  getTheme(): unknown;
  reload(): unknown;
  close(): unknown;
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) {
      req.resume();
      return reject(new HttpError(413, `The body is larger than the limit of ${Math.round(limit / 1048576)} MB.`));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `The body is larger than the limit of ${Math.round(limit / 1048576)} MB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function jsonBody<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.output<S>> {
  const raw = await readBody(req, JSON_LIMIT);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

const NameBody = z.object({ name: z.string().trim().min(1).max(200) });
const CreateBody = z.object({ name: z.string().trim().min(1).max(200).optional() });
const VectorizeBody = z.object({ src: z.string().max(200), colors: z.number().int().min(MIN_COLORS).max(MAX_COLORS).optional(), detail: z.enum(VECTORIZE_DETAILS).optional() });
const ExportBody = z.object({
  fileId: z.string(), nodeIds: z.array(z.string()).max(200).default([]), pageId: z.string().optional(),
  format: z.enum(['png', 'jpg', 'webp', 'avif', 'svg', 'pdf', 'pptx', 'html', 'prototype', 'mp4', 'webm']), scale: z.number().min(0.1).max(4).optional(), transparent: z.boolean().optional(),
  duration: z.number().min(0.05).max(120).optional(), fps: z.number().int().min(1).max(60).optional(), encoder: z.enum(['ffmpeg', 'webcodecs']).optional(), svgMode: z.enum(['vector', 'foreignObject']).optional(),
});
const WidthCheckBody = z.object({ fileId: z.string(), nodeId: z.string(), widths: z.array(z.number().int().min(200).max(3000)).min(1).max(4) });
const UndoBody = z.object({ fileId: z.string(), agent: z.string().min(1).max(60) });
// These ids end up in the run's system prompt, so they stay plain.
const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const CaptureBody = z.object({
  url: z.string().url().max(2000), fileId: Id.optional(), pageId: Id.optional(), pageName: z.string().min(1).max(200).optional(), name: z.string().min(1).max(200).optional(),
  width: z.number().int().min(200).max(4000).optional(), height: z.number().int().min(200).max(4000).optional(), colorScheme: z.enum(['light', 'dark']).optional(), captureFonts: z.boolean().optional(),
});
/** A design content language for one request: a bounded language tag (checked again in core), and what to do with it. */
export const RunLanguage = z.object({
  tag: z.string().trim().max(20).regex(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,4}){0,2}$/).optional(),
  mode: z.enum(['write', 'translate', 'add']).optional(),
}).optional();
const RunBody = z.object({
  fileId: Id, pageId: Id.optional(), nodeIds: z.array(Id).max(200).default([]), prompt: z.string().min(1).max(20_000),
  /** What the run is called in the prompt, the queue, the run list and the History, when the prompt is a fuller brief than the person asked. */
  title: z.string().trim().min(1).max(200).optional(),
  runner: z.enum(RUNNER_IDS), model: z.string().regex(MODEL_ID).optional(), effort: z.string().regex(EFFORT_ID).or(z.literal('default')).optional(),
  review: z.enum(['direct', 'proposal', 'directions', 'critique']).optional(),
  /** What the request means for existing work. Read from the prompt when left out. */
  intent: z.enum(['edit', 'revise', 'new_page']).optional(),
  conversationId: Id.optional(),
  /** A paired device to run it on instead of this one. */
  device: Id.optional(),
  /** Stored images that go with the request, such as a photo from the phone: `bogen-asset:<hash>.<ext>`. */
  images: z.array(z.string().max(120)).max(4).optional(),
  /** The design content language for this request, over the file's. Starts nothing by itself. */
  language: RunLanguage,
  /** For Propose: how many copies, how far they go, and which aspects they change. */
  variation: z.object({ count: z.number().int().min(1).max(6).optional(), range: z.enum(VARIATION_RANGES).default('explore'), vary: z.array(z.enum(VARIATION_ASPECTS)).max(4).default([]) }).optional(),
  /** A design playbook chosen with / in the chat. */
  discipline: z.enum(DISCIPLINE_IDS).optional(),
  /** Layers, components and tokens mentioned with @, checked against the file before the run starts. */
  mentions: z.array(z.object({ kind: z.enum(['layer', 'component', 'token']), id: z.string().min(1).max(200) })).max(20).optional(),
});
const Lane = z.object({ runner: z.enum(RUNNER_IDS), model: z.string().regex(MODEL_ID).optional(), effort: z.string().regex(EFFORT_ID).or(z.literal('default')).optional() });
const RaceBody = z.object({
  fileId: Id, pageId: Id.optional(), nodeId: Id, prompt: z.string().min(1).max(20_000), lanes: z.array(Lane).min(2).max(MAX_DIRECTION_LANES),
  who: z.string().trim().min(1).max(80).default('Someone'),
  language: RunLanguage,
  range: z.enum(VARIATION_RANGES).optional(),
  vary: z.array(z.enum(VARIATION_ASPECTS)).max(4).optional(),
  /** The lanes take sections of the layer instead of a copy each of all of it. */
  split: z.boolean().optional(),
});
const RebuildBody = z.object({ fileId: Id, nodeId: Id, runner: z.enum(RUNNER_IDS), model: z.string().regex(MODEL_ID).optional(), effort: z.string().regex(EFFORT_ID).or(z.literal('default')).optional(), prompt: z.string().max(4000).optional() });
const CommentBody = z.object({
  fileId: Id, text: z.string().trim().min(1).max(10_000), author: z.string().trim().min(1).max(80).default('Someone'),
  threadId: Id.optional(), pageId: Id.optional(), nodeId: Id.optional(), x: z.number().optional(), y: z.number().optional(),
  attachments: z.array(z.object({
    src: z.string().regex(/^bogen-asset:[a-f0-9]{64}\.[a-z0-9]{2,5}$|^bogen-voice:[a-f0-9]{24}\.(m4a|aac|webm|ogg|mp3|wav)$/), name: z.string().max(200).optional(), width: z.number().optional(), height: z.number().optional(),
    kind: z.enum(['image', 'audio']).optional(), duration: z.number().min(0).max(3600).optional(), device: z.string().max(100).optional(),
  })).max(12).optional(),
  model: z.string().regex(MODEL_ID).optional(), effort: z.string().regex(EFFORT_ID).or(z.literal('default')).optional(),
  /** Who a reply without a mention goes to; left out, it follows the thread's last request. */
  to: z.union([z.enum(RUNNER_IDS), z.literal('comment')]).optional(),
});

/**
 * True for a request made on this machine, directly: the machine itself may be used, its disk, its local
 * network, its configuration. A team member with the token, a paired device, a paired phone and anything behind
 * a local proxy are all somewhere else.
 */
export function fromThisDevice(req: IncomingMessage, guard: GuardOptions): boolean {
  if (guard.strict || guard.phone) return false;
  if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) return false;
  return /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? '');
}

/**
 * True for the owner of this machine, in person: at this machine, or on a phone paired with it. Such a person may
 * start agents, comment for them and waive brand rules. It says nothing about the machine: for its disk, its
 * local network and its configuration, ask `fromThisDevice`.
 */
export function fromOwner(req: IncomingMessage, guard: GuardOptions): boolean {
  // The phone guard only reaches routes after the phone listener has checked the login and the phone's token.
  return guard.phone === true || fromThisDevice(req, guard);
}

/** All of the server: storage, rooms, renderer, MCP, runs, and the HTTP and WebSocket front. */
export class BogenServer {
  readonly storage: Storage;
  readonly knowledge: KnowledgeLibrary;
  readonly hub = new EventHub();
  readonly fileEvents = new FileEvents();
  readonly rooms: Rooms;
  readonly renderer: Renderer;
  readonly designQuality: DesignQuality;
  readonly runs: Runs;
  readonly commentRuns: CommentRuns;
  readonly replyTargets: ReplyTargets;
  readonly brands: Brands;
  readonly scores: ScoreHistory;
  readonly libraries: Libraries;
  /** Browser extensions the person paired, which may add captures and nothing else. */
  readonly extensions: ExtensionPairings;
  /** The person's reference board on this device. */
  readonly references: References;
  readonly mcp: McpGateway;
  /** What Settings, Add to agent, runs to connect a client: `bogen install`. Tests put a stand-in here. */
  connectClients: (clients: Client[]) => Promise<InstallResult[]> = (clients) => install(clients);
  readonly peers: PeerManager;
  /** Commits of files. Not to be confused with `history`, which is about agent runs. */
  readonly commits: History;
  /** Every change to a file, by whom, and how to turn it around. */
  readonly timeline: Timeline;
  readonly timelineSync: TimelineSync;
  readonly gitBindings: GitBindings;
  readonly siteJobs = new SiteJobs();
  readonly runSettings: RunSettingsStore;
  readonly history: RunHistory;
  readonly traces: RunTraces;
  /** Chats with agents from the prompt bar and the phone, so that a run knows what came before it. */
  readonly conversations: Conversations;
  /** Agents asked of and for paired devices. */
  readonly remoteRuns: RemoteRuns;
  /** The last smoke test of the agents, while it runs and after, until the server stops. */
  agentsCheck: import('../agents-check.ts').AgentsCheck | null = null;
  /** What each run changed, with pictures, for its reply. */
  readonly runSummaries: RunSummaries;
  /** Several runs on one request, each in its own proposal. */
  readonly races: Races;
  /** What the person accepted and discarded, and the brand rules that suggests. */
  readonly memory: DecisionMemory;
  readonly steps = new AgentSteps();
  readonly away: AwayLog;
  readonly live: LiveSites;
  /** Folders of the person's own projects, for code components, and builds of their modules. */
  readonly codeProjects: CodeProjects;
  readonly codeBuilder: CodeBuilder;
  /** Pull requests from design changes and tokens, made in working folders of the person's repository. */
  readonly pulls: PullRequests;
  /** Brings imported Storybook stories up to date while their files change. */
  readonly storybook: StorybookWatch;
  readonly notifications: Notifications;
  /** The listener for paired phones, behind `tailscale serve`. */
  readonly phone: Phone;
  /** Notifications on paired phones, through their push service. */
  readonly push: PushNotices;
  /** Updates of a paired device to this build, from the sync indicator. */
  readonly deploys: PeerDeploys;
  /** What the last release check found, for the editor and the bar widget. */
  readonly updates: UpdateWatch;
  readonly welcome: Welcome;
  /** Versions of pages and artboards as static websites, and where they are published. */
  readonly publisher: Publisher;
  /** Review links and the inbox of comments from clients. */
  readonly shares: Shares;
  readonly clientRuns: ClientRuns;
  /** The listener of the published site, and the one of review links: static files only, each on its own port. */
  readonly siteListener: StaticListener;
  readonly reviewListener: StaticListener;
  private phoneGuard: GuardOptions;
  private phoneTailscale: TailscaleCli;
  private http: Server;
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private guard: GuardOptions;
  private omarchy: Omarchy | null = null;
  private thumbTimers = new Map<string, NodeJS.Timeout>();
  private thumbTried = new Set<string>();
  private thumbQueue = new Set<string>();
  /** Files that never had a preview: rendered only when the edited ones are done, one at a time with a gap. */
  private thumbBacklog = new Set<string>();
  private thumbActive: Promise<void> | null = null;
  private thumbPaused: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  /** Free memory, so that background previews wait and no browser starts while the machine is short of it. */
  readonly screenPreviews: ScreenPreviews;
  readonly memoryGauge: MemoryGauge;
  private closing = false;
  port = 0;

  constructor(readonly options: ServerOptions) {
    this.memoryGauge = new MemoryGauge(options.memory);
    this.storage = new Storage(options.home);
    this.knowledge = new KnowledgeLibrary(options.home);
    this.welcome = new Welcome(this);
    const historyEvent = (fileId: string) => {
      this.peers.hintChanged(fileId);
      this.hub.broadcast({ t: 'history', fileId });
    };
    this.commits = new History(this.storage, (id) => this.rooms.peek(id)?.doc, { deviceId: () => this.peers.deviceId, deviceName: () => this.peers.deviceName, onCommit: (id) => historyEvent(id), ...options.versions });
    this.timeline = new Timeline(this.storage, {
      deviceId: () => this.peers.deviceId || 'local', deviceName: () => this.peers.deviceName || 'This device', onSealed: historyEvent,
      peerName: (id) => this.peers.status().find((p) => p.id === id)?.name, ...options.timeline,
      onRecorded: (id, entry) => {
        if (rememberEdit(this.storage, id, entry, this.rooms.peek(id)?.doc)) this.rooms.noteFilesChanged();
        options.timeline?.onRecorded?.(id, entry);
      },
    });
    this.timelineSync = new TimelineSync({ storage: this.storage, timeline: this.timeline, commits: this.commits, changed: (id) => this.hub.broadcast({ t: 'history', fileId: id }) });
    this.gitBindings = new GitBindings(options.home);
    this.rooms = new Rooms(this.storage, this.hub, { idleMs: options.idleMs, agentExpiryMs: options.agentExpiryMs, onChange: (id) => { this.screenPreviews?.invalidate(id); this.scheduleThumbnail(id); this.commits.noteChange(id); }, onUpdate: (id, update, origin) => {
        this.peers.onRoomUpdate(id, update, origin);
        this.noteAway(id, origin);
      },
      onRoomLoaded: (room) => {
        this.fileEvents.watch(room);
        this.timeline.watch(room);
        // Older logs lack location hints. Enrich only the file being opened, once, without rendering it.
        if (!this.storage.get(room.id)?.recentEdits?.length) void this.timeline.recent(room.id).then(entries => {
          let changed = false;
          for (const entry of entries.slice(-40)) changed = rememberEdit(this.storage, room.id, entry, room.doc) || changed;
          if (changed) this.hub.broadcast({ t: 'files' });
        }).catch(() => {});
        void this.commits.baseline(room.id, room.doc);
        this.brands.watch(room);
        this.memory.watch(room);
        this.libraries.watch(room);
        this.steps.watch(room);
        this.peers.presence.watch(room);
      },
      onUndoManager: (room, agent, manager) => this.steps.manage(room, agent, manager),
      onAgentIdle: (room, agent) => this.fileEvents.append(room.id, 'agent_idle', { source: 'agent', actor: agent }, { agent }),
    });
    this.renderer = new Renderer((name) => this.storage.readAsset(name));
    this.designQuality = new DesignQuality(this);
    this.screenPreviews = new ScreenPreviews(this);
    // A render that needs a new browser while memory is critical fails with the reason, before Chromium allocates.
    this.renderer.launchGuard = () => (this.memoryGauge.level() === 'critical' ? `This computer is very low on memory (${this.memoryGauge.describe()}), so Bogen does not start its browser now. Close something, then try again.` : null);
    this.runs = new Runs(this.hub, () => ({ url: `${this.localUrl()}/mcp`, token: options.token }), (end) => {
      this.live.runEnded(end.runId);
      void this.pulls.runEnded(end);
      this.fileEvents.append(end.fileId, 'agent_finished', { source: 'agent', actor: end.runner }, { agent: end.runner, run_id: end.runId, status: end.status, ...(end.error ? { error: end.error.slice(0, 500) } : {}), ...(end.threadId ? { thread_id: end.threadId } : {}) });
      this.commentRuns.runEnded(end);
      this.clientRuns.runEnded(end);
      this.races.runEnded(end);
      void this.brands.runEnded(end);
      void this.commitRun(end);
      void settleRunRevision(this, end).catch((e) => console.error(`bogen: revision of run ${end.runId}: ${errorMessage(e)}`));
    });
    this.scores = new ScoreHistory(options.home);
    this.brands = new Brands({ storage: this.storage, rooms: this.rooms, hub: this.hub, fileEvents: this.fileEvents, renderer: this.renderer, scores: this.scores, peers: () => this.peers, forgetFile: (id) => { this.fileEvents.forget(id); this.commentRuns.forget(id); this.away.forget(id); this.peers.conflicts.forget(id); this.races?.forget(id); void this.history.forget(id); void this.conversations.forget(id); void this.replyTargets.forget(id); void this.runSummaries?.forget(id); } });
    // Every run passes the intent check before its CLI starts: a redo opens (or continues) a revision with a checkpoint.
    // The design language comes before the intent: adding a language version decides where the run works.
    this.runs.prepare = async (req) => prepareRunKnowledge(this, await this.conversations.prepare(await prepareRunIntent(this, await prepareRunLanguage(this, await this.brands.prepareRun({ ...req, ...(req.language ? { language: cleanRunLanguage(req.language) } : {}) })))));
    this.runs.beforeFinish = (req, runId, touched) => this.designQuality.beforeFinish(req, runId, touched);
    this.runs.replyOf = async (req, agent, since) => {
      const room = await this.rooms.get(req.fileId);
      return room.doc.getComments().find((t) => t.id === req.threadId)?.messages.filter((m) => m.author === agent && m.at >= since).at(-1)?.text;
    };
    this.libraries = new Libraries({ storage: this.storage, rooms: this.rooms, hub: this.hub });
    this.extensions = new ExtensionPairings(options.home, () => this.hub.broadcast({ t: 'extension' }));
    this.references = new References(options.home, () => this.hub.broadcast({ t: 'references' }));
    this.runSettings = new RunSettingsStore(options.home);
    // One probe cache for listings, catalogs and runs, so that a CLI is asked at most once in a while.
    this.runs.probes = this.runSettings.probes;
    this.history = new RunHistory(options.home, this.hub);
    this.conversations = new Conversations(options.home, this.hub);
    this.runSummaries = new RunSummaries({ home: options.home, rooms: this.rooms, renderer: this.renderer, history: this.history });
    this.traces = new RunTraces(options.home, this.hub);
    this.traces.instructions = runInstructions;
    const runObserver = observers(this.history, this.conversations, this.runSummaries, this.traces);
    const started = runObserver.started;
    runObserver.started = (runId, req) => {
      const room = this.rooms.peek(req.fileId);
      if (room && !req.live) this.designQuality.beginRun(req.fileId, runId, room.doc);
      started?.(runId, req);
    };
    this.runs.observer = runObserver;
    this.remoteRuns = new RemoteRuns(this);
    this.memory = new DecisionMemory({
      home: options.home, hub: this.hub,
      request: async (fileId, runId) => {
        const record = await this.history.get(fileId, runId);
        return record ? { request: record.title || record.prompt, runner: record.runner, ...(record.model ? { model: record.model } : {}) } : undefined;
      },
    });
    this.races = new Races({
      rooms: this.rooms, runs: this.runs, hub: this.hub, storage: this.storage, renderer: this.renderer,
      choice: (runner, asked) => this.runSettings.resolve(runner, 'prompt', asked),
      limit: (runner) => this.runSettings.get().limits[runner],
      // The copies not picked are kept in a branch inside the same file, not checked out: a snapshot of the file with
      // every lane's copy, taken before the accept (design-branches.ts). Never another file.
      branch: async (fileId, name) => {
        const { startBranch } = await import('../design-branches.ts');
        const room = await this.rooms.get(fileId);
        const { branch } = await startBranch(this, room, { name, by: 'person', kind: 'person', checkout: false });
        return { id: branch.id, name: branch.name, fileId, internal: true };
      },
      noteOrigin: (fileId, proposalId, origin) => this.memory.noteOrigin(fileId, proposalId, origin),
      beforeDecision: (fileId) => this.memory.refresh(fileId),
    });
    this.away = new AwayLog(options.home);
    this.codeProjects = new CodeProjects(options.home);
    this.codeBuilder = new CodeBuilder(this.codeProjects, join(options.home, 'cache', 'code'));
    this.renderer.codeFrames = (url) => frameFromUrl(this.codeBuilder, url);
    this.live = new LiveSites({ home: options.home, runs: this.runs, localUrl: () => this.localUrl(), recordFiles: (runId, files) => { this.history.noteFiles(runId, files); this.traces.noteFiles(runId, files); }, traces: this.traces });
    this.pulls = new PullRequests(this);
    this.storybook = new StorybookWatch({
      loaded: () => this.rooms.loaded(), projects: this.codeProjects, intervalMs: options.storybookIntervalMs,
      sync: (fileId, project) => this.rooms.get(fileId).then((room) => syncStories(this, fileId, project, (fn) => room.doc.transact(fn, agentOrigin('storybook')))),
    });
    this.updates = new UpdateWatch(options.home);
    this.notifications = new Notifications({ hub: this.hub, storage: this.storage, rooms: this.rooms, fileEvents: this.fileEvents });
    this.replyTargets = new ReplyTargets(options.home);
    this.commentRuns = new CommentRuns({
      rooms: this.rooms, runs: this.runs, hub: this.hub, storage: this.storage, choice: (runner, asked) => this.runSettings.resolve(runner, 'comment', asked),
      earlier: async (fileId, threadId) => (await this.history.list(fileId)).filter((r) => r.threadId === threadId && r.status !== 'running').reverse(),
      store: this.replyTargets,
      // The newest comment run of each thread: where its next reply goes after a restart. Newest first in the history.
      addressed: async (fileId) => {
        const out = new Map<string, { runner: string; model?: string; effort?: string; at: number }>();
        for (const r of await this.history.list(fileId)) if (r.threadId && r.source === 'comment' && !r.race && !out.has(r.threadId)) out.set(r.threadId, { runner: r.runner, ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), at: r.startedAt });
        return out;
      },
      files: async (_fileId, thread, messageId) => {
        const { threadFiles } = await import('../comment-files.ts');
        return threadFiles({ storage: this.storage, raster: async (doc, nodeId) => (await this.renderer.screenshot(doc, { nodeIds: [nodeId] }, { format: 'png', scale: 1, maxDimension: 1568 })).bytes }, thread, messageId);
      },
    });
    this.mcp = new McpGateway(this);
    this.runs.revoke = (runId) => this.mcp.revokeRun(runId);
    this.guard = { port: () => this.port, token: options.token, dev: options.dev, allowedOrigins: options.allowedOrigins, deniedOrigin: (origin) => this.live.isProxyOrigin(origin) };
    this.phoneGuard = { port: () => this.phone.boundPort, phone: true };
    this.phoneTailscale = options.tailscale ?? tailscaleCli();
    this.phone = new Phone({
      home: options.home, tailscale: this.phoneTailscale, port: options.phonePort, httpsPort: options.phoneHttpsPort,
      changed: () => this.hub.broadcast({ t: 'phone' }),
      removed: (id) => void this.push.forget(id),
      pushOn: (id) => this.push.isOn(id),
      createServer: () => {
        const server = createServer((req, res) => void this.onRequest(req, res, this.phoneGuard));
        server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head, this.phoneGuard));
        // tailscale serve connects as root. Another user could otherwise send it a Tailscale-User-Login of their choosing.
        keepToOwnUser(server);
        return server;
      },
    });
    this.push = new PushNotices({
      home: options.home, storage: this.storage, fileEvents: this.fileEvents, activeRun: (id) => Boolean(this.runs.activeFor(id)),
      paired: (id) => this.phone.isPaired(id), ...(options.pushFetch ? { fetch: options.pushFetch } : {}),
    });
    this.deploys = new PeerDeploys({
      home: options.home, version: options.reportVersion ?? FULL_VERSION, peers: () => this.peers.statusWithUrls(),
      ...(options.deployScript !== undefined ? { script: options.deployScript } : {}), ...(options.deployEnv ? { env: options.deployEnv } : {}),
    });
    const tailscale = this.phoneTailscale;
    const publishChanged = () => this.hub.broadcast({ t: 'publish' });
    this.publisher = new Publisher({
      home: options.home, storage: this.storage, renderer: this.renderer, codeBuilder: this.codeBuilder, gh: options.gh ?? ghCli(),
      ...(options.publishFetch === null ? {} : { fetch: options.publishFetch ?? fetchPublic }),
      doc: async (id) => {
        this.requireFile(id);
        return (await this.rooms.get(id)).doc;
      },
      fileName: (id) => this.storage.get(id)?.name, changed: publishChanged, inUse: () => this.shares.inUse(),
      shot: async (doc, rootId) => {
        const shot = await this.renderer.screenshot(doc, { nodeIds: [rootId] }, { format: 'png', maxDimension: 1280 });
        return { png: shot.bytes, width: Math.round(shot.width / shot.scale) };
      },
    });
    this.clientRuns = new ClientRuns(this);
    this.shares = new Shares({
      home: options.home, publisher: this.publisher, changed: publishChanged,
      doc: async (id) => {
        this.requireFile(id);
        return (await this.rooms.get(id)).doc;
      },
    });
    this.siteListener = new StaticListener({
      kind: 'site', settingsPath: join(options.home, 'publish', 'site-listener.json'), defaults: { port: 29992, httpsPort: 10000 }, tailscale,
      port: options.sitePort, httpsPort: options.siteHttpsPort, changed: publishChanged, handle: (req, res, gate) => this.publisher.handleSite(req, res, gate),
    });
    this.reviewListener = new StaticListener({
      kind: 'review', settingsPath: join(options.home, 'review', 'review-listener.json'), defaults: { port: 29993, httpsPort: 8443 }, tailscale,
      port: options.reviewPort, httpsPort: options.reviewHttpsPort, changed: publishChanged,
      postAllowed: (segments) => this.shares.postAllowed(segments), handle: (req, res, gate) => this.shares.handle(req, res, gate),
    });
    this.http = createServer((req, res) => void this.onRequest(req, res));
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    // Without a token, loopback is the only key, and every user of this machine has it. A token
    // server may sit behind a proxy that runs as another user, and the token is its key instead.
    if (!options.token) keepToOwnUser(this.http);
    this.peers = new PeerManager({
      home: options.home, storage: this.storage, rooms: this.rooms, hub: this.hub,
      port: () => this.port, localUrl: () => this.localUrl(), onFileArrived: (id) => {
        this.scheduleThumbnail(id);
        void this.brands.classify(id);
      },
      shareCursors: () => this.runSettings.get().shareCursors,
      timelineSync: () => this.timelineSync,
      remoteRuns: (peer, req, res, parts) => this.remoteRuns.handlePeer(peer, req, res, parts),
      phoneUrl: () => (this.phone.listening ? this.phone.url : null),
      createTailnetServer: () => {
        const server = createServer((req, res) => void this.onRequest(req, res, this.peers.guard));
        server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head, this.peers.guard));
        return server;
      },
    }, options);
  }

  localUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async omarchyTheme(): Promise<unknown> {
    return (await this.omarchy?.getTheme()) ?? null;
  }

  /** An editor asks when it connects what happened to a file while nobody had it open. */
  private noteAway(id: string, origin: unknown): void {
    if (this.rooms.peek(id)?.conns.size || typeof origin !== 'string') return;
    let who: string | null = null;
    if (origin.startsWith('agent:')) who = origin.slice(6);
    else if (origin.startsWith('person:')) who = origin.slice(7);
    else if (origin.startsWith('peer:')) who = this.peers.status().find((p) => p.id === origin.slice(5))?.name ?? 'another device';
    if (who) this.away.note(id, who);
  }

  get exportDir(): string | undefined {
    return this.options.exportDir;
  }

  async listen(): Promise<void> {
    await this.storage.init();
    await this.runSettings.load();
    await this.away.load();
    await this.live.load();
    await this.codeProjects.load();
    await this.remoteRuns.load();
    this.storybook.start();
    await this.loadOmarchy();
    if (this.options.welcome) await this.welcome.firstRun().catch((e) => console.error(`bogen: no welcome file: ${errorMessage(e)}`));
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.options.port ?? DEFAULT_PORT, this.options.host ?? '127.0.0.1', () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    const address = this.http.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.http.on('error', (e) => console.error(`bogen: ${errorMessage(e)}`));
    await this.peers.start().catch((e) => console.error(`bogen: device sync is off: ${errorMessage(e)}`));
    await this.push.load();
    await this.phone.start().catch((e) => console.error(`bogen: the phone listener is off: ${errorMessage(e)}`));
    await this.publisher.load();
    await this.shares.load();
    await mkdir(join(this.options.home, 'publish'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.options.home, 'review'), { recursive: true, mode: 0o700 });
    await this.siteListener.start();
    await this.reviewListener.start();
    if (this.options.updateChecks) this.updates.start();
    await writeFile(join(this.options.home, 'server.json'), JSON.stringify({ pid: process.pid, port: this.port, host: this.options.host ?? '127.0.0.1', version: FULL_VERSION }), { mode: 0o600 });
  }

  private async loadOmarchy(): Promise<void> {
    try {
      // @ts-ignore The module is optional: it belongs to the Omarchy integration.
      const mod = await import('../omarchy.ts');
      this.omarchy = mod.createOmarchy({ broadcast: (event: BogenEvent) => this.hub.broadcast(event) }) as Omarchy;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') console.error(`bogen: Omarchy integration is off: ${errorMessage(e)}`);
    }
  }

  async close(): Promise<void> {
    await this.screenPreviews.close();
    if (this.closing) return;
    this.closing = true;
    await this.peers.close();
    await this.phone.close();
    await this.push.close();
    await this.siteListener.close();
    await this.reviewListener.close();
    this.updates.close();
    this.brands.close();
    await this.scores.flush();
    this.notifications.close();
    this.commentRuns.close();
    this.storybook.close();
    await this.live.close();
    this.races.close();
    this.pulls.close();
    this.remoteRuns.close();
    this.runs.close();
    await this.history.close();
    await this.conversations.close();
    await this.traces.flush();
    await this.away.close();
    for (const timer of this.thumbTimers.values()) clearTimeout(timer);
    if (this.thumbPaused) clearTimeout(this.thumbPaused);
    this.thumbQueue.clear();
    this.thumbBacklog.clear();
    await this.thumbActive;
    this.fileEvents.close();
    await this.mcp.close();
    await this.timeline.close();
    await this.commits.close();
    await Promise.resolve(this.omarchy?.close()).catch(() => {});
    this.hub.close();
    await this.rooms.close();
    await this.storage.flushAll();
    await this.renderer.close();
    for (const ws of this.sockets.clients) ws.terminate();
    this.sockets.close();
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
    await rm(join(this.options.home, 'server.json'), { force: true });
  }

  // Files, shared by REST and MCP

  createFile(name?: string): FileEntry {
    const entry = this.storage.create(name ?? `Untitled ${this.storage.list().length + 1}`);
    this.hub.broadcast({ t: 'files' });
    return entry;
  }

  async deleteFile(id: string): Promise<void> {
    this.requireFile(id);
    await this.peers.recordDelete(id);
    this.rooms.drop(id);
    this.fileEvents.forget(id);
    this.commentRuns.forget(id);
    this.away.forget(id);
    this.peers.conflicts.forget(id);
    void this.history.forget(id);
    void this.conversations.forget(id);
    void this.replyTargets.forget(id);
    void this.runSummaries.forget(id);
    await this.timeline.forget(id);
    await this.commits.forget(id);
    await this.screenPreviews.remove(id);
    await this.storage.remove(id);
    await voiceNotes(this).forgetFile(id).catch(() => 0);
    this.hub.broadcast({ t: 'files' });
  }

  renameFile(id: string, name: string): void {
    this.requireFile(id);
    this.storage.update(id, { name, updatedAt: Date.now() });
    this.hub.broadcast({ t: 'files' });
  }

  requireFile(id: string): FileEntry {
    const entry = this.storage.get(id);
    if (!entry) throw new HttpError(404, `No file with id ${id}.`);
    return entry;
  }

  /** A finished agent run that changed something is a commit, with what it was asked as its message. */
  private async commitRun(end: RunEnd): Promise<void> {
    try {
      const record = await this.history.get(end.fileId, end.runId);
      const touched = await this.timeline.pick(end.fileId, { run: end.runId });
      if (!touched.length || !this.storage.get(end.fileId)) return;
      const prompt = (record?.title || record?.prompt || 'Agent run').replace(/\s+/g, ' ').trim().slice(0, 300);
      await createCommit(this, end.fileId, { message: end.status === 'done' ? prompt : `${prompt} (${end.status})`, author: end.runner, authorKind: 'agent', kind: 'run', run: end.runId });
    } catch (e) {
      console.error(`bogen: no commit for run ${end.runId}: ${errorMessage(e)}`);
    }
  }

  /** Files that never got a picture, say from before thumbnails or another device, get one when someone looks. */
  private ensureThumbnails(): void {
    if (!this.options.thumbnails) return;
    let added = false;
    for (const e of this.storage.list()) {
      const outdatedThemeCover = (e.theme?.target === 'desktop' && !e.thumbnail?.includes(`cover=${THEME_THUMBNAIL_REVISION}`)) || !e.thumbnail?.includes(`preview=${THUMBNAIL_REVISION}`);
      if ((e.thumbnail && !outdatedThemeCover) || this.thumbTried.has(e.id) || this.thumbTimers.has(e.id)) continue;
      this.thumbTried.add(e.id);
      this.thumbBacklog.add(e.id);
      added = true;
    }
    if (!added) return;
    // The editor first: the backlog starts once the server has been up a while, never in the first seconds of a start.
    const wait = Math.max(1500, this.startedAt + (this.options.thumbnailStartupMs ?? THUMBNAIL_STARTUP_MS) - Date.now());
    const timer = setTimeout(() => this.pumpThumbnails(), wait);
    timer.unref();
  }

  private scheduleThumbnail(id: string): void {
    if (!this.options.thumbnails) return;
    const existing = this.thumbTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.thumbTimers.delete(id);
      this.queueThumbnail(id);
    }, this.options.thumbnailDelayMs ?? THUMBNAIL_DELAY_MS);
    timer.unref();
    this.thumbTimers.set(id, timer);
  }

  /** Background previews share one slot, and repeated edits coalesce while another file renders. */
  private queueThumbnail(id: string): void {
    if (this.closing) return;
    this.thumbQueue.add(id);
    this.pumpThumbnails();
  }

  /**
   * Works through edited files first, then the backlog, one at a time. Before each it reads the memory left: short of
   * it, the queue keeps its files and waits, and an idle browser is closed now rather than in a minute. Nothing is lost:
   * the files stay queued and render once memory is back.
   */
  private pumpThumbnails(): void {
    if (this.closing || this.thumbActive || this.thumbPaused) return;
    if (!this.thumbQueue.size && !this.thumbBacklog.size) return;
    this.thumbActive = (async () => {
      while (!this.closing && (this.thumbQueue.size || this.thumbBacklog.size)) {
        if (this.memoryGauge.level() !== 'ok') {
          console.error(`bogen: background previews wait: ${this.memoryGauge.describe()}. ${this.thumbQueue.size + this.thumbBacklog.size} queued.`);
          await this.renderer.releaseIdle();
          this.thumbPaused = setTimeout(() => {
            this.thumbPaused = null;
            this.pumpThumbnails();
          }, this.options.thumbnailPauseMs ?? THUMBNAIL_PAUSE_MS);
          this.thumbPaused.unref();
          return;
        }
        const edited = this.thumbQueue.size > 0;
        // The backlog keeps to the start-up delay even when an edited file got the queue going early.
        const startup = this.startedAt + (this.options.thumbnailStartupMs ?? THUMBNAIL_STARTUP_MS) - Date.now();
        if (!edited && startup > 0) {
          const timer = setTimeout(() => this.pumpThumbnails(), startup);
          timer.unref();
          return;
        }
        const next = (edited ? this.thumbQueue : this.thumbBacklog).values().next().value!;
        (edited ? this.thumbQueue : this.thumbBacklog).delete(next);
        await this.renderThumbnail(next);
        if (!edited && this.thumbBacklog.size) await new Promise<void>((done) => setTimeout(done, BACKLOG_GAP_MS).unref());
      }
    })().finally(() => { this.thumbActive = null; });
  }

  /** What is waiting for a background preview, for status and tests. */
  thumbnailStatus(): { queued: number; backlog: number; paused: boolean; rendering: boolean } {
    return { queued: this.thumbQueue.size, backlog: this.thumbBacklog.size, paused: this.thumbPaused !== null, rendering: this.thumbActive !== null };
  }

  private async renderThumbnail(id: string): Promise<void> {
    if (!this.storage.get(id)) return;
    // A file that is open renders from its live room, edits included. Any other file renders from a private copy of what
    // is saved, which nobody else can reach and which goes as soon as the picture is taken: a preview never loads a room,
    // so it neither warms the cache with dozens of files nor can it unload one that someone else holds.
    const live = this.rooms.peek(id);
    let doc: BogenDoc | null = null;
    let own = false;
    try {
      if (live) doc = (await this.rooms.get(id)).doc;
      else {
        const saved = await this.storage.readDoc(id);
        doc = new BogenDoc();
        own = true;
        if (saved) Y.applyUpdate(doc.y, saved, 'thumbnail');
      }
      const target = thumbnailTarget(doc);
      if (!target) return;
      const shot = await this.renderer.screenshot(doc, target, { format: 'webp', maxDimension: 640, scale: 1, quality: 82 });
      await this.storage.writeThumb(id, shot.bytes);
      const cover = this.storage.get(id)?.theme?.target === 'desktop' ? `&cover=${THEME_THUMBNAIL_REVISION}` : '';
      this.storage.update(id, { thumbnail: `/api/files/${id}/thumbnail?v=${Date.now()}${cover}&preview=${THUMBNAIL_REVISION}` });
      this.hub.broadcast({ t: 'files' });
    } catch (e) {
      console.error(`bogen: no thumbnail for ${id}: ${errorMessage(e)}`);
      // A preview that timed out may have left a page eating memory: let the browser go now if nothing else renders.
      await this.renderer.releaseIdle();
    } finally {
      if (own) doc?.y.destroy();
    }
  }

  // HTTP

  private async onRequest(req: IncomingMessage, res: ServerResponse, guard: GuardOptions = this.guard): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://bogen.invalid');
    if (guard.phone) return this.onPhoneRequest(req, res, url, guard);
    if (isPeerPath(url.pathname)) return this.peers.handleHttp(req, res, url);
    try {
      // Opening `/?token=` exchanges the secret for a cookie, and takes it out of the address bar.
      const given = url.searchParams.get('token');
      if (req.method === 'GET' && url.pathname === '/' && given && !guard.strict && tokenMatches(guard, given)) {
        res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${encodeURIComponent(given)}; HttpOnly; SameSite=Strict; Path=/` });
        res.end();
        return;
      }
      const verdict = checkRequest(req, guard, url);
      if (!verdict.ok) return sendJson(res, verdict.status, { error: verdict.message });
      if (guard.strict && isLocalOnlyPath(url.pathname)) return sendJson(res, 403, { error: 'Only from this machine.' });
      if (EXTENSION_ROUTE.test(url.pathname) && extensionCors(req, res)) return;
      await this.route(req, res, url, guard);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`bogen: ${req.method} ${url.pathname}: ${errorMessage(e)}`);
      sendJson(res, status, { error: errorMessage(e) });
    }
  }

  /** The phone listener: its own checks, then the same routes as here, less what belongs to the machine. */
  private async onPhoneRequest(req: IncomingMessage, res: ServerResponse, url: URL, guard: GuardOptions): Promise<void> {
    try {
      const verdict = this.phone.check(req, url);
      if (!verdict.ok) return Phone.refuse(req, res, verdict.status, verdict.message);
      if (phoneRefusedPath(url.pathname)) return sendJson(res, 403, { error: 'Only from the computer itself.' });
      if (await this.phone.handlePhoneRoute(req, res, url, verdict.device, () => readBody(req, JSON_LIMIT))) return;
      if (await this.push.handle(req, res, url, verdict.device, () => readBody(req, JSON_LIMIT))) return;
      if (url.pathname === '/api/phone/hosts' && req.method === 'GET') return sendJson(res, 200, phoneHosts(this, this.options.reportVersion ?? FULL_VERSION));
      if (url.pathname === '/api/phone/hosts') throw new HttpError(405, 'Method not allowed.');
      await this.route(req, res, url, guard);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`bogen: phone ${req.method} ${url.pathname}: ${errorMessage(e)}`);
      sendJson(res, status, { error: errorMessage(e) });
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL, guard: GuardOptions): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/mcp') return this.mcp.handle(req, res, (limit = MCP_LIMIT) => readBody(req, limit));
    const liveMcp = /^\/live-mcp\/([\w-]{20,64})$/.exec(path);
    if (liveMcp) {
      // Started by this server, for one run, on this machine. Nothing a page can send gets past the Origin rule before this.
      if (req.headers.origin !== undefined || !fromThisDevice(req, guard)) throw new HttpError(403, 'Only for the run it was made for.');
      return this.live.handleMcp(req, res, liveMcp[1]!, () => readBody(req, MCP_LIMIT));
    }

    if (path.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) {
      const name = path.slice('/assets/'.length);
      if (Storage.isAssetName(name)) return serveAsset(req, res, this.storage, name, { privateCache: Boolean(this.options.token) || guard.phone === true });
    }

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return serveEditor(path, res, guard.phone ? { host: this.peers.device().name } : undefined);
    }

    const parts = path.split('/').filter(Boolean).slice(1);
    const [a, b, c, d, e] = parts;
    if (a === 'design-knowledge' && method === 'PATCH') {
      if (!fromOwner(req, guard)) throw new HttpError(403, 'Only from this machine or a paired phone.');
      return sendJson(res, 200, this.knowledge.change(await jsonBody(req, KnowledgeChange), 'person'));
    }
    if (a === 'design-knowledge' && method === 'GET') {
      const args = z.object({ download: z.literal('1').optional(), action: z.enum(KNOWLEDGE_ACTIONS).optional(), discipline: z.string().max(60).optional(), query: z.string().max(300).optional(), id: z.string().max(100).optional(), offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(30).optional() }).safeParse(Object.fromEntries(url.searchParams));
      if (!args.success) throw new HttpError(400, 'Invalid design knowledge query.');
      try {
        const result = fromOwner(req, guard) ? this.knowledge.read(args.data) : readKnowledge(args.data);
        if (args.data.download) {
          if (args.data.action !== 'skill' || !('markdown' in result)) throw new Error('Choose a discipline and action skill to download Markdown.');
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="bogen-${args.data.discipline}-SKILL.md"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(result.markdown); return;
        }
        return sendJson(res, 200, result);
      }
      catch (error) { throw new HttpError(400, errorMessage(error)); }
    }
    if (await agentRoutes(this, req, res, url, parts, { json: jsonBody, send: sendJson, local: (r) => fromThisDevice(r, guard), owner: (r) => fromOwner(r, guard) })) return;
    if (await clientRoutes(req, res, parts, { send: sendJson, local: (r) => fromThisDevice(r, guard) }, this.connectClients)) return;

    if (a === 'status' && method === 'GET') {
      return sendJson(res, 200, { version: this.options.reportVersion ?? FULL_VERSION, port: this.port, pid: process.pid, files: this.storage.list().length, agents: this.rooms.agentInfos(), device: this.peers.device(), peers: this.peers.status(), conflicts: this.peers.conflicts.all().length, update: this.updates.note() });
    }

    if (await handleDesignBranches(this, req, res, parts)) return;
    if (await handleTransfer(this, req, res, url, parts, guard)) return;
    if (await handleReplayRoute(this, req, res, parts)) return;
    if (await handleFolders(this, req, res, url)) return;
    if (await handleTomacco(this, req, res, parts, guard)) return;
    if (await handleDriftRoutes(this, req, res, url, parts, fromThisDevice(req, guard))) return;
    if (await handleComplianceRoutes(this, req, res, parts)) return;

    if (a === 'extension') return handleExtensionRoute(this, req, res, url, parts, { local: fromThisDevice(req, guard), send: sendJson, readBody, json: jsonBody });
    if (a === 'references') {
      // The person's own board, on this device: the editor here or on a paired phone. Agents use reference_add and reference_search.
      if (!fromOwner(req, guard)) throw new HttpError(403, 'Only from this machine or a paired phone.');
      if (!b && method === 'GET') return sendJson(res, 200, this.references.list());
      if (!b && method === 'POST') {
        const body = await jsonBody(req, z.object({ image: z.string().regex(/^bogen-asset:[a-f0-9]{64}\.[a-z0-9]{2,5}$/), title: z.string().max(200).default(''), tags: z.array(z.string().max(40)).max(12).default([]), note: z.string().max(1000).optional() }));
        let palette: Awaited<ReturnType<typeof imagePalette>> = [];
        try { palette = await imagePalette(this.storage, this.renderer, body.image); } catch (err) { throw new HttpError(400, errorMessage(err)); }
        return sendJson(res, 201, this.references.add({ title: body.title || 'Picture', source: 'image', image: body.image, tags: cleanTags(body.tags), palette, ...(body.note ? { note: body.note } : {}) }));
      }
      if (b && !c && method === 'PATCH') {
        const body = await jsonBody(req, z.object({ title: z.string().max(200).optional(), tags: z.array(z.string().max(40)).max(12).optional(), note: z.string().max(1000).optional() }));
        try { return sendJson(res, 200, this.references.update(b, body)); } catch (err) { throw new HttpError(404, errorMessage(err)); }
      }
      if (b && !c && method === 'DELETE') {
        if (!this.references.remove(b)) throw new HttpError(404, 'No such reference.');
        return sendJson(res, 200, { removed: b });
      }
      throw new HttpError(405, 'Method not allowed.');
    }

    if (a === 'capture' && !b && method === 'POST') {
      const body = await jsonBody(req, CaptureBody);
      const entry = body.fileId ? this.requireFile(body.fileId) : this.createFile(body.name ?? new URL(body.url).hostname);
      const placed = await this.capturePageInto(entry.id, { ...body, allowLocal: fromThisDevice(req, guard) });
      return sendJson(res, 201, { fileId: entry.id, ...placed });
    }

    if (a === 'peers' && b && c === 'deploy' && !d) {
      // It runs ssh and copies this build to another machine: the person at this one, and nobody else.
      if (!fromThisDevice(req, guard)) throw new HttpError(403, 'Only at this machine.');
      if (method === 'GET') return sendJson(res, 200, await this.deploys.info(decodeURIComponent(b)));
      if (method === 'POST') {
        const body = await jsonBody(req, z.object({ host: z.string().trim().min(1).max(300), dryRun: z.boolean(), plan: z.string().max(40).optional() }));
        return sendJson(res, 200, await this.deploys.run(decodeURIComponent(b), body));
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    if (a === 'peers') return this.peers.handleAdmin(req, res, parts);
    if (a === 'inbox' && !b && method === 'GET') return sendJson(res, 200, await inbox(this));
    // A phone's edits from while it was offline, compared with what changed here before they merge.
    if (a === 'files' && b && c === 'catch-up' && !d) {
      if (!fromOwner(req, guard)) throw new HttpError(403, 'Only from this machine or a paired phone.');
      this.requireFile(b);
      if (method === 'GET') return sendJson(res, 200, { sv: Buffer.from(Y.encodeStateVector((await this.rooms.get(b)).doc.y)).toString('base64') });
      if (method === 'POST') {
        let body: z.output<typeof CatchUpBody>;
        try {
          body = CatchUpBody.parse(JSON.parse((await readBody(req, 128 * 1024 * 1024)).toString('utf8') || '{}'));
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, 'Send {"update": "<base64>", "sv": "<base64>"}.');
        }
        const device = guard.phone ? this.phone.check(req, url) : null;
        const name = device?.ok && device.device ? device.device.name : 'This browser';
        return sendJson(res, 200, await phoneCatchUp(this, b, body, name));
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    if (a === 'files' && b && c === 'proposals' && d && (e === 'accept' || e === 'discard') && method === 'POST') {
      if (!fromOwner(req, guard)) throw new HttpError(403, 'Only the person can accept or discard a proposal, here or on a paired phone.');
      const { who } = await jsonBody(req, z.object({ who: z.string().trim().min(1).max(80).default('Someone') }));
      return sendJson(res, 200, await decideProposal(this, b, d, e, who));
    }
    if (a === 'publish' || a === 'shares') return handlePublishRoute(this, req, res, url, parts, guard, { json: jsonBody, send: sendJson });
    if (a === 'phone') {
      if (!fromThisDevice(req, guard)) throw new HttpError(403, 'Only from this machine.');
      return this.phone.handleAdmin(req, res, parts, (schema) => jsonBody(req, schema));
    }

    // The welcome file, opened again or made anew when it was deleted: Help in the editor, and `bogen welcome`.
    if (a === 'welcome' && !b) {
      if (method === 'POST') return sendJson(res, 200, await this.welcome.open());
      throw new HttpError(405, 'Method not allowed.');
    }
    // Examples to start from, each with its own small brand: "Start from an example" on the home screen.
    if (a === 'examples') {
      if (!b && method === 'GET') return sendJson(res, 200, exampleList());
      if (b && !c && method === 'POST') {
        if (!EXAMPLES.some((ex) => ex.id === b)) throw new HttpError(404, `There is no example "${b}".`);
        const { by } = await jsonBody(req, z.object({ by: z.string().trim().max(80).optional() }));
        try {
          const out = await runTemplate(this, { template: b, newFile: true, actor: by || 'editor', origin: `person:${by || 'editor'}` });
          return sendJson(res, 201, out);
        } catch (err) {
          throw err instanceof HttpError ? err : new HttpError(400, errorMessage(err));
        }
      }
      throw new HttpError(405, 'Method not allowed.');
    }

    if (a === 'fonts' && !b && method === 'GET') {
      const list = await listFonts(url.searchParams.get('q') ?? '');
      return sendJson(res, 200, list);
    }

    if (a === 'code') return handleCodeRoute(this, req, res, url, parts, fromThisDevice(req, guard), { json: jsonBody, send: sendJson });
    if (a === 'brands' || (a === 'files' && c === 'brand')) return handleBrandRoute(this, req, res, url, parts, fromOwner(req, guard));

    if (a === 'kits') {
      // The kit registry for the Assets panel. The editor links the library and writes the tokens itself, as its own undo step.
      if (!b && method === 'GET') return sendJson(res, 200, allKits().filter((k) => k.components.every((c) => c.html)).map((k) => ({ ...kitSummary(k), tokenValues: k.tokens })));
      if (b && c === 'library' && method === 'POST') {
        const kit = allKits().find((k) => k.id === b);
        if (!kit) throw new HttpError(404, `There is no kit "${b}".`);
        return sendJson(res, 200, await ensureKitLibrary(this, kit));
      }
    }
    if (a === 'libraries' && method === 'GET') {
      if (!b) return sendJson(res, 200, await this.libraries.list());
      const found = FILE_ID.test(b) ? await this.libraries.get(b) : null;
      if (!found) throw new HttpError(404, 'That library is not on this device, or publishes nothing.');
      return sendJson(res, 200, found);
    }
    if (a === 'files' && c === 'libraries' && method === 'GET' && b && FILE_ID.test(b)) {
      this.requireFile(b);
      return sendJson(res, 200, await this.libraries.status(b, (await this.rooms.get(b)).doc));
    }

    if (a === 'files' && b && c === 'glyph-fonts' && d && e === 'build' && method === 'POST') {
      // Build font in the editor's Font panel: the same build as font_build, as the person's own step.
      this.requireFile(b);
      const room = await this.rooms.get(b);
      const font = getGlyphFont(room.doc, d);
      if (!font) throw new HttpError(404, 'That font is not in this file.');
      try {
        const { font: next, built } = await buildGlyphFontInto(this.storage, room.doc, font, (fn) => room.doc.transact(fn, 'person:editor'));
        return sendJson(res, 200, { family: next.family, glyphs: built.glyphs, kerning: built.kerning, otf: next.build!.otf, woff2: next.build!.woff2, notes: built.notes, glyphNotes: built.glyphNotes, empty: built.empty });
      } catch (err) {
        throw new HttpError(400, errorMessage(err));
      }
    }

    if (a === 'files' && b && c === 'checks' && d === 'run' && !e && method === 'POST') {
      this.requireFile(b);
      const body = await jsonBody(req, z.object({ node_id: Id, check_ids: z.array(z.string().min(1).max(80)).min(1).max(8).optional(), expected: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.string().max(50000)).refine((value) => Object.keys(value).length <= 8).optional() }));
      const room = await this.rooms.get(b);
      if (body.expected) {
        const expected = body.expected;
        const matches = () => Object.entries(expected).every(([id, value]) => room.doc.meta.get(`check:${id}`) === value);
        if (!matches()) await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); room.doc.meta.unobserve(changed); resolve(); };
          const changed = () => { if (matches()) done(); };
          const timer = setTimeout(done, 1000);
          room.doc.meta.observe(changed);
        });
        if (!matches()) throw new HttpError(409, 'The check changed or has not synced yet. Reload it before running.');
      }
      return sendJson(res, 200, await runSavedChecks(room.doc, this.renderer, body.node_id, body.check_ids));
    }

    if (a === 'files') {
      if (!b) {
        if (method === 'GET') {
          this.ensureThumbnails();
          return sendJson(res, 200, this.storage.list().map(({ id, name, updatedAt, createdAt, thumbnail, brandId, folder, project, theme, recentEdits }) => ({ id, name, updatedAt, createdAt, ...(recentEdits?.[0] ? { lastEdit: recentEdits[0] } : {}), ...(thumbnail ? { thumbnail } : {}), ...(brandId ? { brandId } : {}), ...(folder ? { folder } : {}), ...(project ? { project } : {}), ...(theme ? { theme } : {}) })));
        }
        if (method === 'POST') {
          const { name } = await jsonBody(req, CreateBody);
          const entry = this.createFile(name);
          await this.brands.applyDefault(entry.id, 'person:editor');
          return sendJson(res, 201, { id: entry.id, name: entry.name });
        }
      } else if (b === 'import' && method === 'POST') {
        return this.importFile(req, res);
      } else {
        if (!FILE_ID.test(b)) throw new HttpError(404, 'No such file.');
        if (c === 'download' && method === 'GET') return this.downloadFile(b, url, res);
        if (!c && method === 'PATCH') {
          const { name } = await jsonBody(req, NameBody);
          this.renameFile(b, name);
          return sendJson(res, 200, { id: b, name });
        }
        if (!c && method === 'DELETE') {
          await this.deleteFile(b);
          return sendJson(res, 200, { ok: true });
        }
        if (c === 'duplicate' && method === 'POST') return this.duplicateFile(b, res);
        if (c === 'screen-previews' && method === 'GET') {
          this.requireFile(b);
          if (!fromOwner(req, guard)) throw new HttpError(403, 'Only the owner can request canvas previews.');
          if (d) {
            const image = await this.screenPreviews.image(b, d, url.searchParams.get('small') === '1');
            if (!image) throw new HttpError(404, 'No current screen preview.');
            res.writeHead(200, { 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
            res.end(image); return;
          }
          const page = url.searchParams.get('page');
          if (!page || !/^[\w-]{1,80}$/.test(page)) throw new HttpError(400, 'Say which page.');
          const offset = Number(url.searchParams.get('offset') ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new HttpError(400, 'Invalid preview offset.');
          try { return sendJson(res, 200, await this.screenPreviews.catalog(b, page, offset)); }
          catch (e) { throw new HttpError(400, errorMessage(e)); }
        }
        if (c === 'thumbnail' && method === 'GET') {
          this.requireFile(b);
          const bytes = await readFile(this.storage.thumbPath(b)).catch(() => null);
          if (!bytes) throw new HttpError(404, 'No thumbnail yet.');
          res.writeHead(200, { 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=60' });
          res.end(bytes);
          return;
        }
      }
    }

    if (a === 'voice') return handleVoiceRoute(this, req, res, url, parts, fromOwner(req, guard), sendJson);
    if (a === 'assets' && !b && method === 'POST') return sendJson(res, 201, await receiveAsset(req, res, this.storage, String(req.headers['content-type'] ?? '')));
    // A PDF or SVG dropped on the canvas: the layers it makes, for the editor to place as one undo step of its own.
    if (a === 'layers' && b === 'import' && !c && method === 'POST') {
      const raw = await readBody(req, MAX_IMPORT_BYTES);
      const header = req.headers['x-bogen-filename'];
      const name = typeof header === 'string' ? (() => { try { return decodeURIComponent(header); } catch { return header; } })().slice(0, 200) : '';
      const kind = sniffLayerFile(raw, name);
      if (!kind) throw new HttpError(415, 'Only a PDF or an SVG file can come in as layers.');
      const out = await (kind === 'pdf' ? importPdf(this.storage, this.renderer, raw, { name: name.replace(/\.pdf$/i, '') || undefined }) : Promise.resolve(importSvg(raw, name || 'Vector'))).catch((e) => {
        throw new HttpError(400, errorMessage(e));
      });
      return sendJson(res, 200, { ...out, summary: importSummary(out) });
    }
    if (a === 'assets' && b === 'vectorize' && method === 'POST') {
      // Only a stored asset is traced: nothing here fetches an address for anyone.
      const body = await jsonBody(req, VectorizeBody);
      const out = await vectorizeAsset(this.storage, this.renderer, body.src, { colors: body.colors, detail: body.detail }).catch((e) => {
        throw new HttpError(400, errorMessage(e));
      });
      return sendJson(res, 200, out);
    }

    if (a === 'export' && method === 'POST') {
      const body = await jsonBody(req, ExportBody);
      this.requireFile(body.fileId);
      const room = await this.rooms.get(body.fileId);
      const pageId = body.pageId ?? room.doc.getPages()[0]?.id;
      const out = await exportTarget(room.doc, this.renderer, this.storage, body.nodeIds.length ? { nodeIds: body.nodeIds } : { pageId }, body.format, body.scale, body.transparent, { duration: body.duration, fps: body.fps, encoder: body.encoder, svgMode: body.svgMode, title: this.storage.get(body.fileId)?.name }).catch((e) => {
        throw e instanceof HttpError ? e : new HttpError(/^No layer|^The page is empty|^Nothing to/.test(errorMessage(e)) ? 400 : 500, errorMessage(e));
      });
      const name = (this.storage.get(body.fileId)?.name ?? 'export').replace(/[^\w.-]+/g, '-');
      const report = reportHeader(out.report);
      res.writeHead(200, { 'Content-Type': out.mime, 'Content-Disposition': `attachment; filename="${name}.${out.ext}"`, 'X-Content-Type-Options': 'nosniff', ...(report ? { 'X-Bogen-Export-Report': report } : {}) });
      res.end(out.bytes);
      return;
    }

    // The editor's responsive section: what still sticks out at each width, as responsive_check says it.
    if (a === 'responsive-check' && method === 'POST') {
      const body = await jsonBody(req, WidthCheckBody);
      this.requireFile(body.fileId);
      const room = await this.rooms.get(body.fileId);
      if (!room.doc.getNode(body.nodeId)) throw new HttpError(404, `No layer with id ${body.nodeId}.`);
      return sendJson(res, 200, (await checkWidths(room.doc, this.renderer, body.nodeId, body.widths)).report);
    }

    if (a === 'agents' && b === 'undo' && method === 'POST') {
      const { fileId, agent } = await jsonBody(req, UndoBody);
      this.requireFile(fileId);
      const room = await this.rooms.get(fileId);
      return sendJson(res, 200, { undone: room.undoAgent(agent) });
    }

    if (a === 'runners' && method === 'GET') return sendJson(res, 200, await this.runs.runners());

    if (a === 'runs') {
      if (!b && method === 'POST') {
        if (!fromOwner(req, guard)) throw new HttpError(403, 'Agents only start for a person on the device that runs them, or on a phone paired with it.');
        const body = await jsonBody(req, RunBody);
        const entry = this.requireFile(body.fileId);
        if (body.device) {
          const { device, ...asked } = body;
          return sendJson(res, 201, await this.remoteRuns.start(device, asked));
        }
        try {
          const choice = await this.runSettings.resolve(body.runner, 'prompt', { ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) });
          const { model: _model, effort: _effort, device: _device, images: sources, mentions: asked, variation: varied, ...rest } = body;
          const images = sources?.length ? await runImages(this.storage, sources) : [];
          const mentions = asked?.length ? resolveMentions((await this.rooms.get(body.fileId)).doc, asked) : [];
          const variation = varied ? { ...cleanVariation(varied)!, ...(varied.count ? { count: varied.count } : {}) } : undefined;
          const runId = await this.runs.start({ ...rest, ...choice, fileName: entry.name, ...(images.length ? { images } : {}), ...(mentions.length ? { mentions } : {}), ...(variation ? { variation } : {}) });
          return sendJson(res, 201, { runId });
        } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(409, errorMessage(e));
        }
      }
      if (b === 'rebuild' && !c && method === 'POST') {
        if (!fromOwner(req, guard)) throw new HttpError(403, 'Agents only start for a person on the device that runs them, or on a phone paired with it.');
        const { rebuildRun } = await import('../rebuild.ts');
        return sendJson(res, 201, await rebuildRun(this, await jsonBody(req, RebuildBody)));
      }
      if (b && c === 'stop' && method === 'POST') {
        if (!this.runs.stop(b) && !(await this.remoteRuns.stop(b).catch((e) => { throw new HttpError(502, errorMessage(e)); }))) throw new HttpError(404, 'No such run is active.');
        return sendJson(res, 200, { ok: true });
      }
    }

    if (a === 'races') {
      if (!b && method === 'GET') {
        const fileId = url.searchParams.get('fileId') ?? '';
        this.requireFile(fileId);
        return sendJson(res, 200, this.races.list(fileId));
      }
      if (!fromOwner(req, guard)) throw new HttpError(403, 'Only the person starts and decides races, here or on a paired phone.');
      if (!b && method === 'POST') {
        const body = await jsonBody(req, RaceBody);
        this.requireFile(body.fileId);
        const lanes = body.lanes.map((l) => ({ runner: l.runner, ...(l.model ? { model: l.model } : {}), ...(l.effort ? { effort: l.effort } : {}) }));
        const { range, vary, split, ...rest } = body;
        const variation = range || vary?.length ? cleanVariation({ range: range ?? 'explore', vary: vary ?? [] }) : undefined;
        return sendJson(res, 201, await this.races.start({ ...rest, lanes, ...(variation ? { variation } : {}), ...(split ? { split } : {}) }));
      }
      if (b && c === 'stop' && method === 'POST') {
        const { laneId } = await jsonBody(req, z.object({ laneId: z.string().max(8).optional() }));
        return sendJson(res, 200, { stopped: this.races.stop(b, laneId).map((l) => l.id) });
      }
      if (b && c === 'accept' && method === 'POST') {
        const { laneId, keep, who } = await jsonBody(req, z.object({ laneId: z.string().max(8), keep: z.enum(['discard', 'branch']).default('discard'), who: z.string().trim().min(1).max(80).default('Someone') }));
        return sendJson(res, 200, await this.races.accept(b, laneId, { keep, who }));
      }
      if (b && c === 'discard' && method === 'POST') {
        const { laneId, who } = await jsonBody(req, z.object({ laneId: z.string().max(8), who: z.string().trim().min(1).max(80).default('Someone') }));
        await this.races.discard(b, laneId, who);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (a === 'comments') {
      if (!b && method === 'POST') {
        const body = await jsonBody(req, CommentBody);
        this.requireFile(body.fileId);
        return sendJson(res, 201, await this.commentRuns.submit(body, fromOwner(req, guard)));
      }
      if (b === 'runs' && method === 'GET') {
        const fileId = url.searchParams.get('fileId') ?? '';
        this.requireFile(fileId);
        return sendJson(res, 200, this.commentRuns.list(fileId));
      }
      // Where each thread's next reply goes, for the composer. Only what the server itself recorded counts.
      if (b === 'targets' && method === 'GET') {
        const fileId = url.searchParams.get('fileId') ?? '';
        this.requireFile(fileId);
        return sendJson(res, 200, await this.commentRuns.targetsOf(fileId));
      }
    }

    if (a === 'theme' && method === 'GET') return sendJson(res, 200, (await this.omarchy?.getTheme()) ?? platformTheme());
    // The desktop's language for the editor's "Automatic" choice, read only, and only for the person at this machine:
    // a phone or another computer picks from its own browser's languages.
    if (a === 'language' && !b && method === 'GET') return sendJson(res, 200, fromThisDevice(req, guard) ? await platformLanguage() : NO_PLATFORM_LANGUAGE);
    if (a === 'omarchy' && b === 'reload' && method === 'POST') {
      await this.omarchy?.reload();
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(404, `No route for ${method} ${path}.`);
  }

  private async duplicateFile(id: string, res: ServerResponse): Promise<void> {
    const source = this.requireFile(id);
    // The state comes first: a paired device may ask for a listed file at once, and an empty one would get a page.
    const copyId = newId();
    const live = this.rooms.peek(id);
    if (live) {
      await atomicWrite(this.storage.docPath(copyId), Y.encodeStateAsUpdate(live.doc.y));
    } else await this.storage.duplicateDoc(id, copyId);
    const copy = this.storage.create(`${source.name} copy`, copyId);
    this.hub.broadcast({ t: 'files' });
    sendJson(res, 201, { id: copy.id, name: copy.name });
  }

  /** Captures a page onto a new artboard. Local pages need `allowLocal`, which agents never get. */
  async capturePageInto(fileId: string, options: { url: string; width?: number; height?: number; colorScheme?: 'light' | 'dark'; name?: string; pageId?: string; pageName?: string; allowLocal?: boolean; captureFonts?: boolean; mode?: string; pairWith?: string }, origin: unknown = 'capture'): Promise<{ modes?: ModeReport; pageId: string; nodeId: string; layers: number; images: number; failedImages: string[]; tokens: number; title: string; original: string; fonts: FontReport; interactionRules: number }> {
    const room = await this.rooms.get(fileId);
    const { doc } = room;
    const plan = planModeCapture(doc, options);
    const capture = await capturePage(this.renderer, this.storage, doc, { ...options, allowLocal: options.allowLocal ?? true, ...(plan ? { liveTokens: true } : {}) });
    const modes = plan ? fillMode(doc, plan, capture, origin) : undefined;
    let pageId = options.pageId;
    if (!pageId && options.pageName) pageId = doc.getPages().find((p) => p.name === options.pageName)?.id ?? doc.createPage(options.pageName, origin);
    pageId ??= doc.getPages()[0]!.id;
    const { nodeId } = this.placeCapture(fileId, doc, capture, { name: options.name, pageId, url: options.url }, origin);
    recordCapture(doc, nodeId, options.url, options.colorScheme ?? 'dark', origin);
    const original = await this.storage.putAsset(capture.original, 'image/png');
    return { ...(modes ? { modes } : {}), pageId, nodeId, ...capture.stats, tokens: doc.getTokens().length, title: capture.title, original: original.url, fonts: capture.fonts, interactionRules: capture.rules.length };
  }

  /** The tokens of a capture, for a file that has none yet. */
  adoptCaptureTokens(doc: BogenDoc, capture: CaptureResult, origin: unknown): void {
    if (doc.getTokens().length) return;
    doc.transact(() => {
      for (const t of capture.tokens) doc.setToken(t.name, t.kind, t.value);
    }, origin);
  }

  /** One artboard from a finished capture, with its fonts and interaction rules. */
  placeCapture(_fileId: string, doc: BogenDoc, capture: CaptureResult, options: { name?: string; pageId: string; url: string }, origin: unknown): { nodeId: string } {
    const nodeId = doc.transact(() => {
      this.adoptCaptureTokens(doc, capture, origin);
      capture.root.name = options.name ?? (capture.title || new URL(options.url).hostname);
      capture.root.style = { ...capture.root.style, left: `${nextArtboardX(doc, options.pageId)}px`, top: '0px' };
      addFontFaces(doc, capture.fontFaces);
      return doc.insert(options.pageId, capture.root);
    }, origin);
    // After the transaction, as the tree can only be read back once it has ended.
    const rules = resolveRuleLayers(doc, nodeId, capture.root, capture.rules);
    if (rules.length) setInteractionRecord(doc, nodeId, { url: capture.url, rules }, origin);
    return { nodeId };
  }

  /** `?brand=0` leaves the linked brand out. What happened to it is in `X-Bogen-Brand`, as URI-encoded JSON. */
  private async downloadFile(id: string, url: URL, res: ServerResponse): Promise<void> {
    this.requireFile(id);
    const out = await exportBogen(this, id, { brand: url.searchParams.get('brand') !== '0' });
    const safeName = out.name.replace(/[^\w .-]+/g, '_').slice(0, 80) || 'design';
    res.writeHead(200, {
      'Content-Type': 'application/x-bogen', 'Content-Disposition': `attachment; filename="${safeName}.bogen"`, 'X-Content-Type-Options': 'nosniff',
      ...(out.brand ? { 'X-Bogen-Brand': encodeURIComponent(JSON.stringify(out.brand)) } : {}),
    });
    res.end(out.bytes);
  }

  /** The answer keeps `id` and `name` of what to open: the file, or the brand when that came on its own. */
  private async importFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, IMPORT_LIMIT);
    const header = req.headers['x-bogen-filename'];
    const out = await importBogen(this, raw, typeof header === 'string' ? header : '', 'person:editor');
    const opened = out.file ?? (out.brand ? { id: out.brand.id, name: out.brand.name } : null);
    if (!opened) throw new HttpError(400, 'This file is empty.');
    sendJson(res, 201, { ...opened, kind: out.file ? 'file' : 'brand', ...(out.brand ? { brand: out.brand } : {}) });
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, guard: GuardOptions = this.guard): void {
    const refuse = (status: number, message: string) => {
      socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url ?? '/', 'http://bogen.invalid');
    let phone: PhoneDevice | null = null;
    if (guard.phone) {
      const verdict = this.phone.check(req, url);
      if (!verdict.ok) return refuse(verdict.status, verdict.status === 401 ? 'Unauthorized' : verdict.status === 503 ? 'Service Unavailable' : 'Forbidden');
      if (phoneRefusedPath(url.pathname) || !verdict.device) return refuse(403, 'Forbidden');
      phone = verdict.device;
    } else {
      if (isPeerPath(url.pathname)) return this.peers.handleUpgrade(req, socket, head, url);
      const verdict = checkRequest(req, guard, url);
      if (!verdict.ok) return refuse(verdict.status, verdict.status === 401 ? 'Unauthorized' : 'Forbidden');
    }
    const accepted = (ws: WebSocket) => {
      if (phone) this.phone.attach(phone, ws);
    };
    if (url.pathname === '/events') {
      this.sockets.handleUpgrade(req, socket, head, (ws) => {
        accepted(ws);
        this.hub.add(ws);
      });
      return;
    }
    const match = /^\/sync\/([^/]+)$/.exec(url.pathname);
    if (!match || !FILE_ID.test(match[1]!) || !this.storage.get(match[1]!)) return refuse(404, 'Not Found');
    this.sockets.handleUpgrade(req, socket, head, (ws) => {
      accepted(ws);
      void this.rooms.connect(ws, match[1]!);
    });
  }
}
