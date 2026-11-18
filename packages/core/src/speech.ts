/**
 * The words side of a voice call with an agent: where streamed text breaks into sentences that can be spoken one by
 * one, what a spoken command means, and the turn-taking state machine. Audio, models and the network live elsewhere
 * (the server's `speech/` and the editor's `call/`), so this part runs the same in both and in tests.
 */

export type CallLanguage = 'de' | 'en';

/** Words before a full stop that do not end a sentence, lowercased, with their own dots. */
const ABBREVIATIONS: Record<CallLanguage, string[]> = {
  de: ['z.b.', 'd.h.', 'u.a.', 'usw.', 'bzw.', 'ca.', 'dr.', 'nr.', 'str.', 'evtl.', 'ggf.', 'inkl.', 'vgl.', 'etc.', 'bspw.', 'u.ä.', 'z.t.', 'o.ä.', 's.', 'abb.', 'max.', 'min.'],
  en: ['e.g.', 'i.e.', 'mr.', 'mrs.', 'ms.', 'dr.', 'vs.', 'etc.', 'no.', 'approx.', 'st.', 'fig.', 'max.', 'min.'],
};

/** Months, so that "am 3. Oktober" is one sentence. */
const MONTHS_DE = /^(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|jänner)\b/i;

/** Markdown and code that should not be read out: fences, inline code ticks, emphasis, headings, links. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, '$2')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function endsSentenceAt(text: string, i: number, language: CallLanguage): boolean {
  const ch = text[i];
  if (ch === '!' || ch === '?' || ch === '…') return true;
  if (ch !== '.' && ch !== ';') return false;
  const next = text[i + 1];
  // "1.250", "3.5", "v1.2", "bogen.dev": a dot inside a token.
  if (next !== undefined && !/[\s"'“”„«»)\]]/.test(next)) return false;
  if (ch === ';') return true;
  const before = text.slice(0, i + 1);
  const word = (/(\S+)$/.exec(before)?.[1] ?? '').toLowerCase();
  if (ABBREVIATIONS[language].includes(word)) return false;
  // Spaced abbreviations: "z. B.", "d. h.", "u. a.".
  if (/^[a-zäöü]\.$/.test(word)) return false;
  // A single capital letter as an initial ("J. Smith").
  if (/^[A-ZÄÖÜ]\.$/.test(/(\S+)$/.exec(before)?.[1] ?? '')) return false;
  // German ordinals: "am 3. Oktober", "der 2. Versuch" go on when a lowercase word or a month follows.
  if (/^\d{1,2}\.$/.test(word)) {
    const rest = text.slice(i + 1).trimStart();
    if (language === 'de' && (MONTHS_DE.test(rest) || /^[a-zäöüß]/.test(rest))) return false;
    if (language === 'en' && /^[a-z]/.test(rest)) return false;
  }
  return true;
}

/**
 * Splits streamed text into sentences to speak. `done` is false while more text may follow: the last piece then
 * stays in `rest` unless it already ended with a sentence mark. Very long sentences are cut at a comma or a space so
 * the first audio comes quickly.
 */
export function takeSentences(buffer: string, language: CallLanguage, done = false, maxChars = 220): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]!;
    if (ch === '\n' && buffer[i + 1] === '\n') {
      push(buffer.slice(start, i));
      start = i + 2;
      i++;
      continue;
    }
    if (endsSentenceAt(buffer, i, language)) {
      // Closing quotes and brackets stay with their sentence.
      let end = i + 1;
      while (end < buffer.length && /["'“”„«»)\]]/.test(buffer[end]!)) end++;
      if (end === buffer.length && !done) break;
      push(buffer.slice(start, end));
      start = end;
      i = end - 1;
    } else if (i - start >= maxChars) {
      const piece = buffer.slice(start, i);
      const cut = Math.max(piece.lastIndexOf(', '), piece.lastIndexOf(' '));
      if (cut > maxChars / 3) {
        push(piece.slice(0, cut + 1));
        start += cut + 1;
      }
    }
  }
  let rest = buffer.slice(start);
  if (done) {
    push(rest);
    rest = '';
  }
  return { sentences, rest };

  function push(raw: string): void {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (/[\p{L}\p{N}]/u.test(s)) sentences.push(s);
  }
}

export type CallCommand = 'stop' | 'undo' | 'hangup' | 'mute' | 'repeat';

/** What a short utterance asks for, when it is only a command. Longer sentences go to the agent. */
export function callCommand(text: string): CallCommand | null {
  const t = text.toLowerCase().replace(/[.,!?;:"„“”]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 6) return null;
  if (/^(stopp?|halt|warte|hör auf|aufhören|stop it|stop that|wait|hold on|cancel|abbrechen)( bitte| please)?$/.test(t)) return 'stop';
  if (/^(mach (das|es) rückgängig|rückgängig( machen)?|nimm das zurück|undo( that| this| it)?|take that back|revert (that|it))( bitte| please)?$/.test(t)) return 'undo';
  if (/^(auflegen|leg auf|tschüss|ende|bye|hang up|end (the )?call)( bitte| please)?$/.test(t)) return 'hangup';
  if (/^(stumm|mute|sei still|be quiet)( bitte| please)?$/.test(t)) return 'mute';
  if (/^(wie bitte|nochmal|noch ?mal bitte|sag das nochmal|repeat( that)?|say that again|pardon)$/.test(t)) return 'repeat';
  return null;
}

/** The language a short text is most likely in, from common words: for captions and for choosing a voice. */
export function guessLanguage(text: string, fallback: CallLanguage): CallLanguage {
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  const de = /^(ich|du|der|die|das|den|dem|und|ist|nicht|mach|bitte|ein|eine|mit|auf|für|größer|kleiner|jetzt|noch|doch|wie|was|bild|seite|überschrift|farbe|schrift|lass|uns|wir|er|es|vom|von|zum|zur|weiter|weitermachen|datei|hier|gerade|schon|aber|oder|mal|kannst|soll|wechsel|öffne)$/;
  const en = /^(i|you|the|and|is|not|make|please|a|an|with|on|for|bigger|smaller|now|still|how|what|image|page|headline|colour|color|font)$/;
  let score = 0;
  for (const w of words) score += de.test(w) ? 1 : en.test(w) ? -1 : 0;
  if (/[äöüß]/.test(text)) score += 2;
  return score > 0 ? 'de' : score < 0 ? 'en' : fallback;
}

/**
 * Turn-taking. `listening`: the mic is open and nobody speaks; `hearing`: the person speaks; `thinking`: their words
 * are being transcribed or the agent is working with nothing to say yet; `speaking`: the agent's voice plays;
 * `interrupted`: the person started speaking over the agent, whose voice stopped at once; `muted` and `ended`.
 */
export type TurnState = 'listening' | 'hearing' | 'thinking' | 'speaking' | 'interrupted' | 'muted' | 'ended';

export type TurnEvent =
  | { t: 'speech-start' }
  | { t: 'speech-end' }
  | { t: 'transcribed'; empty: boolean }
  | { t: 'voice-start' }
  | { t: 'voice-end'; queued: boolean }
  | { t: 'working' }
  | { t: 'idle' }
  | { t: 'mute'; on: boolean }
  | { t: 'hangup' };

/** What the caller must do on a transition, besides showing the new state. */
export interface TurnEffect { stopVoice?: boolean; transcribe?: boolean }

export function turn(state: TurnState, event: TurnEvent): { state: TurnState; effect: TurnEffect } {
  if (event.t === 'hangup') return { state: 'ended', effect: { stopVoice: true } };
  if (state === 'ended') return { state, effect: {} };
  if (event.t === 'mute') return { state: event.on ? 'muted' : 'listening', effect: {} };
  if (state === 'muted') {
    // A muted mic hears nothing, but the agent may still speak.
    if (event.t === 'voice-start') return { state: 'muted', effect: {} };
    return { state, effect: {} };
  }
  switch (event.t) {
    case 'speech-start':
      // Barge-in: the person speaks over the agent, who stops at once.
      if (state === 'speaking') return { state: 'interrupted', effect: { stopVoice: true } };
      return { state: 'hearing', effect: {} };
    case 'speech-end':
      if (state === 'hearing' || state === 'interrupted') return { state: 'thinking', effect: { transcribe: true } };
      return { state, effect: {} };
    case 'transcribed':
      return { state: event.empty ? 'listening' : 'thinking', effect: {} };
    case 'voice-start':
      // The person is talking: what the agent was about to say waits.
      if (state === 'hearing' || state === 'interrupted') return { state, effect: { stopVoice: true } };
      return { state: 'speaking', effect: {} };
    case 'voice-end':
      if (state !== 'speaking') return { state, effect: {} };
      return { state: event.queued ? 'speaking' : 'listening', effect: {} };
    case 'working':
      return { state: state === 'listening' ? 'thinking' : state, effect: {} };
    case 'idle':
      return { state: state === 'thinking' ? 'listening' : state, effect: {} };
    default:
      return { state, effect: {} };
  }
}

/** A short, spoken line for what the agent is doing, from an MCP tool name. Null for tools not worth narrating. */
export function narrateTool(tool: string, language: CallLanguage, layer?: string): string | null {
  const on = layer ? (language === 'de' ? ` an „${layer}“` : ` on ${layer}`) : '';
  const lines: Record<string, [string, string]> = {
    html_write: ['Ich zeichne das jetzt', 'I am drawing it now'],
    layer_style: [`Ich ändere den Stil${on}`, `Changing the style${on}`],
    layer_text: [`Ich ändere den Text${on}`, `Changing the text${on}`],
    canvas_screenshot: ['Ich schaue mir das Ergebnis an', 'Looking at the result'],
    design_lint: ['Ich prüfe das', 'Checking it'],
    design_review: ['Ich prüfe das', 'Checking it'],
    a11y_audit: ['Ich prüfe die Barrierefreiheit', 'Checking accessibility'],
    artboard_create: ['Ich lege ein neues Artboard an', 'Making a new artboard'],
    tokens_set: ['Ich passe die Tokens an', 'Updating the tokens'],
    image_treatment: ['Ich bearbeite das Bild', 'Treating the image'],
    layer_delete: [`Ich lösche etwas${on}`, `Removing something${on}`],
  };
  const pair = lines[tool];
  return pair ? `${pair[language === 'de' ? 0 : 1]}.` : null;
}

/** What the agent says the moment it heard a request, before it starts working. */
export function acknowledgement(language: CallLanguage, n: number): string {
  const de = ['Okay, mache ich.', 'Alles klar.', 'Gut, ich schaue es mir an.', 'Verstanden.'];
  const en = ['Okay, on it.', 'Got it.', 'Sure, let me look.', 'Understood.'];
  const list = language === 'de' ? de : en;
  return list[Math.abs(n) % list.length]!;
}
