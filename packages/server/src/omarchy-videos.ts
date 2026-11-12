// Videos of an Omarchy theme, as Omarchy 4.5 (v4.5.0, ac2690cd) reads them. Two different things share a folder:
//
// - An intro: `backgrounds/intros/<stem>.<ext>`, paired with the still `backgrounds/<stem>.<image ext>`. OWE plays it
//   muted when the theme is switched to (or at login) with that still selected, then hands back to the still. Five to
//   seven seconds, ending on the still. It lives in `intros/` so the background picker does not list it.
// - A loop wallpaper: a video directly in `backgrounds/`, which the picker lists like any background.
//
// Bogen never makes a video. It carries the ones a theme has: reads them, checks them, keeps the pairing, writes them
// back. Pure: bytes in, facts out.

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] as const;
export const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};
export const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
/** A theme video larger than this is left out on import and refused on export: a theme folder is not a video library. */
export const MAX_VIDEO = 96 * 1024 * 1024;

export type ThemeVideoKind = 'intro' | 'loop';

/** Stored in the theme meta. The bytes are an asset; the pairing is by board, so renaming a still keeps its intro. */
export interface ThemeVideo {
  kind: ThemeVideoKind;
  /** The file name it came with, such as 0-winding-road.mp4. */
  name: string;
  /** `bogen-asset:<sha256>.<ext>`. */
  src: string;
  /** For an intro: the Background board whose still it ends on. */
  board?: string;
  facts?: VideoFacts;
}

export interface VideoFacts {
  durationS?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  bytes: number;
}

/**
 * What an ISO media file (mp4, m4v, mov) says about itself: duration from `mvhd`, size from the video track's `tkhd`,
 * and whether any track is sound (`hdlr` of type `soun`). Other containers give only their size; nothing is guessed.
 */
export function probeVideo(bytes: Uint8Array, ext: string): VideoFacts {
  const facts: VideoFacts = { bytes: bytes.length };
  if (!['mp4', 'm4v', 'mov'].includes(ext.toLowerCase())) return facts;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk = (start: number, end: number, path: string[], depth: number): void => {
    let i = start;
    while (i + 8 <= end && depth < 8) {
      let size = b.readUInt32BE(i);
      const type = b.toString('latin1', i + 4, i + 8);
      let head = 8;
      if (size === 1 && i + 16 <= end) {
        size = Number(b.readBigUInt64BE(i + 8));
        head = 16;
      } else if (size === 0) size = end - i;
      if (size < head || i + size > end) return;
      const body = i + head;
      if (type === 'mvhd' && body + 20 <= end) {
        const v = b[body]!;
        const [scale, duration] = v === 1 && body + 32 <= end ? [b.readUInt32BE(body + 20), Number(b.readBigUInt64BE(body + 24))] : [b.readUInt32BE(body + 12), b.readUInt32BE(body + 16)];
        if (scale > 0) facts.durationS = Math.round((duration / scale) * 100) / 100;
      }
      if (type === 'hdlr' && body + 12 <= end) {
        const handler = b.toString('latin1', body + 8, body + 12);
        if (handler === 'soun') facts.hasAudio = true;
        if (handler === 'vide') facts.hasAudio ??= false;
      }
      if (type === 'tkhd' && body + 84 <= end) {
        const v = b[body]!;
        const at = body + (v === 1 ? 88 : 76);
        if (at + 8 <= end) {
          const w = b.readUInt32BE(at) / 65536;
          const h = b.readUInt32BE(at + 4) / 65536;
          if (w > 0 && h > 0 && !facts.width) {
            facts.width = Math.round(w);
            facts.height = Math.round(h);
          }
        }
      }
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta'].includes(type)) walk(body, i + size, [...path, type], depth + 1);
      i += size;
    }
  };
  walk(0, b.length, [], 0);
  return facts;
}

/** What to tell the person about an intro or a loop, against Omarchy's own advice. */
export function videoAdvice(video: Pick<ThemeVideo, 'kind' | 'name' | 'facts'>, still?: { width: number; height: number }): string[] {
  const f = video.facts;
  const out: string[] = [];
  if (!f) return out;
  if (video.kind === 'intro' && f.durationS !== undefined) {
    if (f.durationS < 3 || f.durationS > 10) out.push(`${video.name} runs ${f.durationS} s. Omarchy plays an intro before handing back to the still: five to seven seconds is what it is made for.`);
  }
  if (video.kind === 'intro' && f.hasAudio) out.push(`${video.name} has a sound track. Omarchy plays intros muted, so it only adds bytes.`);
  if (still && f.width && f.height && Math.abs(f.width / f.height - still.width / still.height) > 0.02) {
    out.push(`${video.name} is ${f.width} × ${f.height}, but its still is ${still.width} × ${still.height}: the hand-over from the last frame to the still will jump.`);
  }
  return out;
}

/** `name.ext` without the extension, as Omarchy pairs a still with its intro. */
export const stemOf = (file: string): string => file.replace(/\.[^.]+$/, '');
export const extOf = (file: string): string => (file.split('.').pop() ?? '').toLowerCase();

export function readVideos(raw: unknown): ThemeVideo[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is ThemeVideo => {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return (r.kind === 'intro' || r.kind === 'loop') && typeof r.name === 'string' && VIDEO.test(r.name) && !/[/\\]/.test(r.name)
      && typeof r.src === 'string' && /^bogen-asset:[a-f0-9]{64}\.[a-z0-9]{2,5}$/.test(r.src) && (r.board === undefined || typeof r.board === 'string');
  }).slice(0, 48);
}
