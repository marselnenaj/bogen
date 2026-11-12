import { brandDataOf, Paint, type BrandSpec } from './brand-spec.ts';
import { BrandKit, h, t, type Style, type TemplateEnv } from './kit.ts';
import type { BoardPlan, TemplatePlan } from './types.ts';

/**
 * Bogen's own brand, as far as the welcome file needs it. The same values as the Bogen brand on the founder's
 * machine: ink, paper and blue, the fold in blue deep, tomato only for an agent's cursor, Archivo with its width axis.
 */
export const BOGEN_BRAND: BrandSpec = {
  name: 'Bogen',
  positioning: 'An open source design canvas where every layer is real HTML and CSS. You draw on it with the coding agent you already pay for. No account, no subscription.',
  audience: 'Developers and designers who use Claude Code or Codex.',
  tone: 'Plain and confident, from the user\'s side. Short sentences, concrete facts, no hype.',
  fields: { container: 1440, gradients: 'none', shadows: 'none' },
  colors: [
    { name: 'Blue', role: 'primary', value: '#2b3df2', token: 'blue', note: 'Bogen\'s own colour: the sheet.' },
    { name: 'Blue deep', role: 'primary-shade', value: '#1b27a8', token: 'blue-deep', note: 'The folded corner of the sheet, and only that.' },
    { name: 'Ink', role: 'text', value: '#0e0e0c', token: 'ink' },
    { name: 'Paper', role: 'background', value: '#f4f2ec', token: 'paper' },
    { name: 'Dim', role: 'text-secondary', value: '#5f5d55', token: 'dim' },
    { name: 'Dim on ink', role: 'text-secondary-dark', value: '#a8a69c', token: 'dim-dark' },
    { name: 'Rule', role: 'border', value: '#c9c6bb', token: 'rule' },
    { name: 'Paper deep', role: 'surface', value: '#ebe8df', token: 'paper-deep' },
    { name: 'Ink raised', role: 'surface-dark', value: '#1b1b18', token: 'ink-raised' },
    { name: 'Blue on ink', role: 'accent-on-dark', value: '#7d8bff', token: 'blue-light', note: 'The prompt sign on ink.' },
    { name: 'Tomato', role: 'agent cursor', value: '#f2361f', token: 'tomato', note: 'Only for an agent\'s cursor.' },
  ],
  pairings: [
    { fg: 'paper', bg: 'blue', verdict: 'allow' }, { fg: 'ink', bg: 'paper', verdict: 'allow' }, { fg: 'paper', bg: 'ink', verdict: 'allow' },
    { fg: 'dim', bg: 'paper', verdict: 'allow' }, { fg: 'dim-dark', bg: 'ink', verdict: 'allow' }, { fg: 'ink', bg: 'tomato', verdict: 'allow' },
    { fg: 'ink', bg: 'blue', verdict: 'forbid', note: 'No text. Ink shapes on blue are fine.' }, { fg: 'blue', bg: 'ink', verdict: 'forbid' },
  ],
  families: [
    { family: 'Archivo', role: 'display', fallback: '"Helvetica Neue", Arial, sans-serif', weights: [400, 700, 800, 900], token: 'sans', license: 'OFL' },
    { family: 'ui-monospace', role: 'mono', fallback: 'Menlo, Consolas, monospace', weights: [400], token: 'code' },
  ],
  typeScale: [
    { name: 'Wordmark', role: 'display', size: 236, weight: 900, lineHeight: '0.8', tracking: '-0.02em', family: 'Archivo', token: 'text-wordmark' },
    { name: 'Hero', role: 'h1', size: 112, weight: 800, lineHeight: '0.92', tracking: '-0.035em', family: 'Archivo', token: 'text-hero' },
    { name: 'Statement', role: 'h2', size: 72, weight: 900, lineHeight: '0.92', tracking: '-0.04em', family: 'Archivo', token: 'text-statement' },
    { name: 'Claim', role: 'h3', size: 48, weight: 900, lineHeight: '0.92', tracking: '-0.04em', family: 'Archivo', token: 'text-claim' },
    { name: 'Question', role: 'h4', size: 30, weight: 800, lineHeight: '1.05', tracking: '-0.025em', family: 'Archivo', token: 'text-question' },
    { name: 'Lead', role: 'lead', size: 22, weight: 400, lineHeight: '1.45', family: 'Archivo', token: 'text-lead' },
    { name: 'Body', role: 'body', size: 20, weight: 400, lineHeight: '1.45', family: 'Archivo', token: 'text-body' },
    { name: 'Small', role: 'small', size: 15, weight: 400, lineHeight: '1.4', family: 'Archivo', token: 'text-small' },
  ],
  spacing: [8, 16, 24, 32, 48, 64, 96, 160],
  radius: [0],
  logos: [{ name: 'Mark', background: 'any', minWidth: 16, clearSpace: 8, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#2b3df2" d="M10 4H66L92 30V96H10Z"/><path fill="#1b27a8" d="M66 4V30H92Z"/><path d="M26 48 48 64 26 80" fill="none" stroke="#f4f2ec" stroke-width="10.5" stroke-miterlimit="8"/><rect fill="#f4f2ec" x="55" y="73" width="25" height="10.5"/></svg>' }],
  rules: [
    { text: 'Square corners everywhere. Bogen is a sheet of paper.', kind: 'do', severity: 'hard', topic: 'layout' },
    { text: 'No all caps, except the BOGEN wordmark.', kind: 'dont', severity: 'hard', topic: 'type' },
    { text: 'No glow, gradients or shadows.', kind: 'dont', severity: 'hard', topic: 'general', check: { type: 'no-gradient' } },
    { text: 'Tomato appears only as an agent\'s cursor.', kind: 'do', severity: 'soft', topic: 'color' },
    { text: 'Every sheet has one folded top-right corner in Blue deep.', kind: 'do', severity: 'soft', topic: 'layout' },
    { text: 'Bands alternate blue, ink and paper. Never two of the same colour in a row.', kind: 'do', severity: 'soft', topic: 'color' },
    { text: 'No eyebrow labels over headings, no rows of identical cards.', kind: 'dont', severity: 'soft', topic: 'layout' },
  ],
  words: [{ word: 'AI-powered', use: 'avoid', instead: 'with your agent' }, { word: 'seamless', use: 'avoid' }, { word: 'magic', use: 'avoid' }],
  voice: [
    { good: 'Give your agent a canvas.', bad: 'Unleash AI-powered design magic.' },
    { good: 'Your plan, not ours.', bad: 'Save money with our revolutionary pricing model.' },
  ],
};

export const WELCOME_NAME = 'Welcome to Bogen';
const DOCS = 'https://github.com/marselnenaj/bogen/blob/main/docs/guide';
const GUTTER = '48px';

/** The brand data the welcome file is drawn from, made once. */
let bogenData: ReturnType<typeof brandDataOf> | null = null;
export function bogenBrandData() {
  bogenData ??= brandDataOf(BOGEN_BRAND);
  return bogenData;
}

/** The welcome file: one board, a stack of sheets in Bogen's colours, each with its fold. */
export function welcomePlan(env: Omit<TemplateEnv, 'data'>): TemplatePlan {
  const k = new BrandKit({ ...env, data: bogenBrandData() });
  const p = new Paint(k);
  const sans = p.f('sans');
  const code = p.f('code');
  const display = (size: number, extra: Style = {}): Style => ({ margin: 0, fontFamily: sans, fontSize: `${size}px`, fontWeight: 900, fontStretch: '112%', letterSpacing: '-0.04em', lineHeight: 0.92, ...extra });
  const body = (size = 20, extra: Style = {}): Style => ({ margin: 0, fontFamily: sans, fontSize: `${size}px`, fontWeight: 400, lineHeight: 1.45, ...extra });
  const chevron = (w: number, token: string) => `<svg data-name="Prompt" width="${w}" height="${Math.round(w * 1.2)}" viewBox="0 0 42 50" style="flex:none"><path d="M5 5 35 25 5 45" fill="none" stroke="${p.hex(token)}" stroke-width="10" stroke-miterlimit="8"/></svg>`;

  /** A sheet with its folded corner: the cut shows the sheet before it, the underside is blue deep. */
  const band = (name: string, bg: string, under: string, fg: string, children: string[], { fold = 96, pad = `96px ${GUTTER}`, tag = 'section' } = {}) => h(tag, { position: 'relative', display: 'flex', flexDirection: 'column', gap: '48px', padding: pad, background: p.c(bg), color: p.c(fg) }, [
    h('div', { position: 'absolute', right: 0, top: 0, width: `${fold}px`, height: `${fold}px`, background: p.c(under) }, [
      h('div', { width: '100%', height: '100%', background: p.c('blue-deep'), clipPath: 'polygon(0 0,0 100%,100% 100%)' }, [], { 'data-name': 'Underside' }),
    ], { 'data-name': 'Fold' }),
    ...children,
  ], { 'data-name': name });
  const terminal = (lines: string[], bg = 'ink-raised') => h('div', { display: 'flex', flexDirection: 'column', gap: '16px', padding: '32px', background: p.c(bg) }, lines.map((l) =>
    h('p', { margin: 0, fontFamily: code, fontSize: '20px', lineHeight: 1.3, color: p.c('paper'), whiteSpace: 'pre' }, [h('span', { color: p.c('blue-light') }, '$ '), t(l)], { 'data-name': 'Command' })), { 'data-name': 'Terminal' });
  const words = (heading: string, text: string, muted: string | null, extra: string[] = [], size = 72) => h('div', { display: 'flex', flexDirection: 'column', gap: '24px' }, [
    h('h2', display(size), t(heading), { 'data-name': 'Heading' }),
    h('p', body(20, { maxWidth: '540px', ...(muted ? { color: p.c(muted) } : {}) }), t(text), { 'data-name': 'Body' }),
    ...extra,
  ], { 'data-name': 'Words' });
  const columns = (children: string[], align = 'start') => h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '64px', alignItems: align }, children, { 'data-name': 'Two columns' });
  const steps: string[] = [];

  // What Bogen is: the wordmark over the blue sheet.
  steps.push(band('What Bogen is', 'blue', 'paper', 'paper', [
    h('div', { ...display(236, { fontStretch: '125%', letterSpacing: '-0.02em', lineHeight: 0.8 }), marginLeft: '-8px', whiteSpace: 'nowrap' }, 'BOGEN', { 'data-name': 'Wordmark' }),
    h('div', { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '48px', marginTop: '120px' }, [
      h('div', { display: 'flex', alignItems: 'flex-end', gap: '32px' }, [
        h('div', { display: 'flex', alignItems: 'flex-end', gap: '24px' }, [chevron(84, 'paper'), h('div', { width: '96px', height: '26px', background: p.c('paper'), marginBottom: '8px', flex: 'none' }, [], { 'data-name': 'Cursor' })], { 'data-name': 'Prompt sign' }),
        h('h1', display(112, { fontWeight: 800, letterSpacing: '-0.035em' }), 'Welcome.', { 'data-name': 'Headline' }),
      ], { 'data-name': 'Title' }),
      h('p', body(20, { maxWidth: '460px' }), 'Bogen is a design canvas where every layer is real HTML and CSS. You draw here, and your own coding agent draws here too, on the plan you already pay for. No account, no subscription.', { 'data-name': 'What it is' }),
    ], { 'data-name': 'Under the wordmark' }),
  ], { fold: 160, pad: `64px ${GUTTER}`, tag: 'header' }));

  // Connect an agent, and the first thing to ask it.
  steps.push(band('Connect your agent', 'ink', 'blue', 'paper', [columns([
    words('Connect your agent.', 'One command adds Bogen to Claude Code. Codex, Cursor, VS Code, OpenCode, Gemini CLI and Zed take the same command with their own name.', 'dim-dark'),
    h('div', { display: 'flex', flexDirection: 'column', gap: '32px', paddingTop: '8px' }, [
      terminal(['bogen install claude-code']),
      h('div', { display: 'flex', flexDirection: 'column', gap: '16px' }, [
        h('p', body(20, { color: p.c('dim-dark') }), 'Then ask Claude Code:', { 'data-name': 'Label' }),
        h('div', { display: 'flex', alignItems: 'center', gap: '16px' }, [chevron(22, 'blue-light'), h('p', display(30, { fontWeight: 800, letterSpacing: '-0.025em', lineHeight: 1.05 }), 'Design a pricing page in Bogen.', { 'data-name': 'First prompt' })], { 'data-name': 'Prompt' }),
        h('p', body(20, { color: p.c('dim-dark'), maxWidth: '560px' }), 'Keep this canvas open and watch it draw. With the claude CLI installed, Ctrl+K asks from the canvas too.', { 'data-name': 'Note' }),
      ], { 'data-name': 'First ask' }),
    ], { 'data-name': 'How' }),
  ])]));

  // A comment for an agent, on a drawn piece of canvas.
  const handle = (pos: Style) => h('div', { position: 'absolute', width: '12px', height: '12px', background: p.c('paper'), border: `2px solid ${p.c('blue')}`, ...pos }, [], { 'data-name': 'Handle' });
  const canvasPiece = h('div', { position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '64px', minHeight: '440px', background: p.c('paper-deep') }, [
    h('div', { position: 'relative', display: 'flex', flexDirection: 'column', gap: '16px', padding: '32px', width: '400px', background: p.c('paper'), outline: `2px solid ${p.c('blue')}` }, [
      handle({ left: '-7px', top: '-7px' }), handle({ right: '-7px', top: '-7px' }), handle({ left: '-7px', bottom: '-7px' }), handle({ right: '-7px', bottom: '-7px' }),
      h('p', display(30, { fontWeight: 800, color: p.c('ink'), letterSpacing: '-0.03em', lineHeight: 1 }), 'Fresh bread, every morning from six', { 'data-name': 'Their headline' }),
      h('p', body(15, { color: p.c('dim') }), 'Order by ten, pick it up warm.', { 'data-name': 'Their line' }),
    ], { 'data-name': 'Selected layer' }),
    h('div', { display: 'flex', alignItems: 'flex-start', gap: '16px', marginTop: '32px', marginLeft: '120px' }, [
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', flex: 'none', background: p.c('ink'), color: p.c('paper'), fontFamily: sans, fontWeight: 700, fontSize: '15px' }, 'M', { 'data-name': 'Avatar' }),
      h('div', { display: 'flex', flexDirection: 'column', padding: '16px', maxWidth: '300px', background: p.c('ink') }, [
        h('p', body(15, { color: p.c('paper'), lineHeight: 1.35 }), [h('span', { color: p.c('blue-light'), fontWeight: 700 }, '@claude'), ' make the headline shorter'], { 'data-name': 'Text' }),
      ], { 'data-name': 'Thread' }),
    ], { 'data-name': 'Comment' }),
    h('div', { position: 'absolute', left: '474px', top: '178px', display: 'flex', alignItems: 'flex-start', gap: '8px' }, [
      `<svg data-name="Arrow" width="22" height="26" viewBox="0 0 22 26" style="flex:none"><path d="M2 2 L2 22 L8 16 L12 25 L16 23 L12 15 L20 15 Z" fill="${p.hex('tomato')}" stroke="${p.hex('ink')}" stroke-width="1.5"/></svg>`,
      h('span', { marginTop: '16px', padding: '0 8px', background: p.c('tomato'), color: p.c('ink'), fontFamily: sans, fontWeight: 700, fontSize: '15px', lineHeight: 1.6 }, 'claude', { 'data-name': 'Name' }),
    ], { 'data-name': 'Agent cursor' }),
  ], { 'data-name': 'Drawn canvas' });
  steps.push(band('Comment @claude', 'paper', 'ink', 'ink', [columns([
    canvasPiece,
    words('Write @claude on any layer.', 'Press C, click a layer and write a comment that mentions @claude. Your own claude CLI starts on that spot, answers in the thread, and resolves it when the work is done. @codex works the same way.', 'dim'),
  ], 'center')]));

  // Brands, with a sheet of this file's own.
  const swatch = (name: string, token: string, border = false) => h('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [
    h('div', { width: '100%', height: '96px', background: p.c(token), border: border ? `1px solid ${p.c('rule')}` : undefined }, [], { 'data-name': 'Colour' }),
    h('p', body(15, { color: p.c('ink'), fontWeight: 700 }), name, { 'data-name': 'Name' }),
  ], { 'data-name': `Swatch ${name}` });
  const sheet = h('div', { display: 'flex', flexDirection: 'column', gap: '32px', padding: '48px', background: p.c('paper'), color: p.c('ink') }, [
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }, [
      h('p', display(30, { fontWeight: 800, letterSpacing: '-0.025em' }), 'This file’s brand', { 'data-name': 'Title' }),
      h('p', body(15, { color: p.c('dim') }), 'Bogen', { 'data-name': 'Brand name' }),
    ], { 'data-name': 'Head' }),
    h('div', { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '16px' }, [swatch('Blue', 'blue'), swatch('Blue deep', 'blue-deep'), swatch('Ink', 'ink'), swatch('Paper', 'paper', true)], { 'data-name': 'Palette' }),
    h('div', { display: 'flex', alignItems: 'baseline', gap: '16px', borderTop: `1px solid ${p.c('rule')}`, paddingTop: '24px' }, [
      h('p', display(72, { fontStretch: '125%', lineHeight: 0.8 }), 'Aa', { 'data-name': 'Specimen' }),
      h('p', body(15, { color: p.c('dim') }), 'Archivo, wide and heavy for headlines, plain at 400 for text.', { 'data-name': 'Type' }),
    ], { 'data-name': 'Type' }),
    h('div', { display: 'flex', alignItems: 'baseline', gap: '16px', borderTop: `1px solid ${p.c('rule')}`, paddingTop: '24px' }, [
      h('p', body(15, { fontWeight: 700, flex: 'none' }), 'Hard rule', { 'data-name': 'Kind' }),
      h('p', body(15), 'Square corners everywhere.', { 'data-name': 'Rule' }),
    ], { 'data-name': 'Rule' }),
  ], { 'data-name': 'Brand sheet' });
  steps.push(band('Brands', 'blue', 'paper', 'paper', [columns([
    words('Give it a brand.', 'A brand holds your logos, colours, type, spacing, voice and rules. Link a file to one, and your agent designs within it while Bogen checks the result. Make one under Brands on the home screen.', null, [
      h('a', body(20, { color: p.c('paper'), fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: '4px' }), 'How brands work', { href: `${DOCS}/brand.md`, 'data-name': 'Docs link' }),
    ]),
    sheet,
  ])]));

  // The keys to start with.
  const key = (k: string) => h('span', { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '40px', height: '40px', padding: '0 8px', flex: 'none', border: `2px solid ${p.c('paper')}`, color: p.c('paper'), fontFamily: sans, fontWeight: 700, fontSize: '15px' }, t(k), { 'data-name': 'Key' });
  const row = (keys: string[], what: string) => h('div', { display: 'flex', alignItems: 'center', gap: '16px', padding: '16px 0', borderTop: `1px solid ${p.c('dim')}` }, [
    h('div', { display: 'flex', gap: '8px', width: '116px', flex: 'none' }, keys.map(key), { 'data-name': 'Keys' }),
    h('p', body(20, { color: p.c('paper') }), t(what), { 'data-name': 'Does' }),
  ], { 'data-name': what });
  const col = (title: string, rows: [string[], string][]) => h('div', { display: 'flex', flexDirection: 'column' }, [
    h('h3', display(30, { fontWeight: 800, letterSpacing: '-0.025em', lineHeight: 1.05, paddingBottom: '24px' }), t(title), { 'data-name': 'Title' }),
    ...rows.map(([keys, what]) => row(keys, what)),
  ], { 'data-name': title });
  steps.push(band('Keys', 'ink', 'blue', 'paper', [
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '48px' }, [
      h('h2', display(72), 'The keys to start with.', { 'data-name': 'Heading' }),
      h('p', body(20, { color: p.c('dim-dark'), maxWidth: '420px' }), 'Ctrl+/ shows every shortcut. Ctrl+P finds any command, layer, page or file.', { 'data-name': 'Body' }),
    ], { 'data-name': 'Head' }),
    h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '48px' }, [
      col('Draw', [[['V'], 'Move and select'], [['F'], 'Frame'], [['T'], 'Text'], [['R'], 'Rectangle'], [['Shift', 'A'], 'Flex layout']]),
      col('Look around', [[['Space'], 'Hold and drag to pan'], [['Ctrl'], 'Hold and scroll to zoom'], [['Shift', '1'], 'Fit everything'], [['Shift', '2'], 'Fit the selection']]),
      col('Ask', [[['C'], 'Comment'], [['Ctrl', 'K'], 'Ask your agent'], [['Ctrl', 'P'], 'Command palette'], [['Ctrl', 'Z'], 'Undo']]),
    ], { 'data-name': 'Columns' }),
  ]));

  // The phone, drawn with its inbox.
  const headline = (text: string, outline: boolean) => h('div', { display: 'flex', flexDirection: 'column', padding: '8px', height: '150px', background: p.c('paper-deep'), outline: outline ? `2px solid ${p.c('blue')}` : undefined }, [
    h('p', display(15, { fontWeight: 800, color: p.c('ink'), letterSpacing: '-0.02em', lineHeight: 1.05 }), text, { 'data-name': 'Text' }),
  ], { 'data-name': outline ? 'After' : 'Before' });
  const phone = h('div', { display: 'flex', flexDirection: 'column', width: '320px', padding: '16px', flex: 'none', background: p.c('ink') }, [
    h('div', { display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px', background: p.c('paper') }, [
      h('p', display(30, { fontStretch: '125%', color: p.c('ink') }), 'Inbox', { 'data-name': 'Title' }),
      h('p', body(15, { color: p.c('dim') }), 'Proposal: a shorter headline', { 'data-name': 'Line' }),
      h('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }, [headline('Fresh bread, every morning from six', false), headline('Bread from six', true)], { 'data-name': 'Before and after' }),
      h('div', { display: 'flex', gap: '8px' }, [
        h('div', { flex: '1', padding: '16px 0', background: p.c('blue'), border: `2px solid ${p.c('blue')}`, color: p.c('paper'), fontFamily: sans, fontWeight: 700, fontSize: '15px', textAlign: 'center' }, 'Accept', { 'data-name': 'Accept' }),
        h('div', { flex: '1', padding: '16px 0', border: `2px solid ${p.c('ink')}`, color: p.c('ink'), fontFamily: sans, fontWeight: 700, fontSize: '15px', textAlign: 'center' }, 'Discard', { 'data-name': 'Discard' }),
      ], { 'data-name': 'Actions' }),
      ...[['claude answered', 'Make the headline shorter'], ['Run finished', 'Bakery landing, 390']].map(([what, where]) => h('div', { display: 'flex', flexDirection: 'column', gap: '2px', padding: '16px 0', borderTop: `1px solid ${p.c('rule')}` }, [
        h('p', body(15, { fontWeight: 700, color: p.c('ink') }), t(what!), { 'data-name': 'What' }),
        h('p', body(15, { color: p.c('dim') }), t(where!), { 'data-name': 'Where' }),
      ], { 'data-name': 'Inbox row' })),
    ], { 'data-name': 'Screen' }),
  ], { 'data-name': 'Drawn phone' });
  steps.push(band('The phone', 'paper', 'ink', 'ink', [columns([
    words('Take it on your phone.', 'Your phone opens the Bogen on this computer through Tailscale, as an app on its Home Screen. Accept or discard what your agent proposed, answer comments, or ask for a change while you are away.', 'dim', [
      terminal(['bogen phone on', 'bogen phone pair'], 'ink'),
      h('p', body(15, { color: p.c('dim'), maxWidth: '540px' }), 'Needs Tailscale on both, with the same login. Tried in Chromium, not yet on a real iPhone.', { 'data-name': 'Limits' }),
    ]),
    h('div', { display: 'flex', justifyContent: 'center' }, [phone], { 'data-name': 'Phone' }),
  ], 'center')]));

  // What to do with this file, and where to go next.
  steps.push(band('This file', 'blue', 'paper', 'paper', [columns([
    h('div', { display: 'flex', flexDirection: 'column', gap: '24px' }, [
      h('h2', display(48), 'This file is yours.', { 'data-name': 'Heading' }),
      h('p', body(20, { maxWidth: '540px' }), 'Draw on it, change it, delete it. Once deleted it stays gone. For a fresh copy, run bogen welcome, or choose Help, then Welcome to Bogen, at the top right of the editor.', { 'data-name': 'Body' }),
    ], { 'data-name': 'Delete' }),
    h('div', { display: 'flex', flexDirection: 'column', gap: '24px' }, [
      h('h2', display(48), 'Start from an example.', { 'data-name': 'Heading' }),
      h('p', body(20, { maxWidth: '540px' }), 'A landing page, app screens, a pitch deck and social images, each with a small brand of its own. They are on the home screen, and your agent finds them with template_list.', { 'data-name': 'Body' }),
    ], { 'data-name': 'Examples' }),
  ])]));

  const board: BoardPlan = { name: WELCOME_NAME, width: 1440, background: p.c('paper'), color: p.c('ink'), font: sans, steps: steps.map((html) => ({ html })) };
  return { page: 'Welcome', boards: [board], gaps: [] };
}
