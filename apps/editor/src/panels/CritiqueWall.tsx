import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { critiqueApi, type CritiqueJob } from '../lib/critique.ts';

/**
 * The pin-up wall while a review runs: the person's own screens side by side, as the very pictures the reviewer got
 * (a screen not rendered yet is its outline at the artboard's ratio), a soft reading light that walks along them and
 * a pencil mark where it has been. The light and the marks are decoration, never a claim about where the model
 * looks; the stage under the wall says what is really happening. Designed in Bogen: "Bogen Brand System", page
 * "Design critique", artboard D2.
 */

export interface WallBoard { id: string; name: string; width: number; height: number }

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function CritiqueWall({ job, boards, compact = false, preview }: { job: CritiqueJob | null; boards: WallBoard[]; compact?: boolean; /** Before a review: a small picture of each screen as it is now. */ preview?: (id: string) => string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cells = useRef<(HTMLDivElement | null)[]>([]);
  const [width, setWidth] = useState(640);
  const [at, setAt] = useState(0);
  // The screens the light has passed: each gets a quiet tick under it, which judges nothing.
  const [passed, setPassed] = useState<Set<number>>(new Set());
  // The screen that is bright: the one the light has arrived at, never one it is still travelling to.
  const [lit, setLit] = useState(-1);
  const [jumps, setJumps] = useState(0);
  const last = useRef(-1);
  const [light, setLight] = useState<{ x: number; y: number } | null>(null);
  // Previews load one after the other, so they never hold up the browser's few connections to the server.
  const [previewed, setPreviewed] = useState(0);
  const still = useMemo(reduced, []);
  const step = job?.state === 'running' ? job.step ?? 'rules' : null;
  const rendered = job?.rendered ?? 0;

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The boards at one height that fits the wall, in one row, or two when one would make them too small.
  const gap = compact ? 10 : 16;
  const maxH = compact ? 120 : 168;
  const ratio = boards.map((b) => Math.min(1.8, Math.max(0.35, (b.width || 1) / (b.height || 1))));
  const rowFit = (list: number[]) => (width - 48 - gap * Math.max(0, list.length - 1)) / Math.max(0.1, list.reduce((s, r) => s + r, 0));
  let rows = 1;
  let height = Math.min(maxH, rowFit(ratio));
  if (height < 64 && boards.length > 3) {
    rows = 2;
    const half = Math.ceil(boards.length / 2);
    height = Math.min(maxH * 0.7, rowFit(ratio.slice(0, half)), rowFit(ratio.slice(half)));
  }
  height = Math.max(28, Math.floor(height));

  // Where the light is: on the screen being rendered, then walking from screen to screen while the reviewer looks,
  // settled in the middle while it writes. With reduced motion it rests on the middle screen.
  useEffect(() => {
    if (!step || still || step !== 'reviewer') return;
    const id = window.setInterval(() => {
      setAt((i) => {
        setPassed((p) => (p.has(i) ? p : new Set([...p, i])));
        return (i + 1) % Math.max(1, boards.length);
      });
    }, 4000);
    return () => window.clearInterval(id);
  }, [step, still, boards.length]);

  const target = still || step === 'writing' || !step ? Math.floor((boards.length - 1) / 2) : step === 'pictures' ? Math.max(0, Math.min(boards.length - 1, rendered)) : step === 'rules' ? 0 : at;
  // Forward, the light travels and the screen lights when it arrives; back to the start, it fades out and in.
  useEffect(() => {
    const from = last.current;
    last.current = target;
    if (from === target) return;
    if (from < 0 || target < from) { setJumps((n) => n + 1); setLit(target); return; }
    const id = window.setTimeout(() => setLit(target), 2300);
    return () => window.clearTimeout(id);
  }, [target]);
  useLayoutEffect(() => {
    const cell = cells.current[target];
    const box = wrap.current;
    if (!cell || !box) return;
    const c = cell.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    setLight({ x: c.left - b.left + c.width / 2, y: c.top - b.top + c.height / 2 });
  }, [target, width, height, boards.length, rows]);

  // Reduced motion: no light and no ticks; every screen is lit evenly, so the still wall claims nothing.
  const lightSize = Math.round(height * (compact ? 1.25 : 1.15));
  const perRow = rows === 2 ? Math.ceil(boards.length / 2) : boards.length;

  return (
    <div ref={wrap} className={`crit-wall${compact ? ' is-compact' : ''}${still ? ' is-still' : ''}`} data-step={step ?? 'idle'} aria-hidden="true" data-testid="critique-wall">
      <div className="crit-wall-rows" style={{ gap }}>
        {[0, 1].slice(0, rows).map((row) => (
          <div key={row} className="crit-wall-row" style={{ gap }}>
            {boards.slice(row * perRow, (row + 1) * perRow).map((b, j) => {
              const i = row * perRow + j;
              const has = Boolean(job && i < rendered);
              const src = has ? critiqueApi.picture(job!.id, i + 1) : !job && preview && i <= previewed ? preview(b.id) : null;
              const ready = has || (!job && i < previewed);
              const w = Math.round(height * ratio[i]!);
              const bright = !still && (step === 'pictures' || step === 'reviewer' || step === 'writing') && i === lit;
              return (
                <div key={b.id} ref={(el) => { cells.current[i] = el; }} className={`crit-print${ready ? ' is-in' : ''}${!job && src ? ' is-preview' : ''}${bright ? ' is-lit' : ''}`} style={{ width: w, height }} data-testid="critique-print">
                  {src ? <img src={src} alt="" draggable={false} decoding="async" onLoad={!job ? () => setPreviewed((n) => Math.max(n, i + 1)) : undefined} onError={!job ? () => setPreviewed((n) => Math.max(n, i + 1)) : undefined} /> : null}
                  {!still && passed.has(i) ? <span className="crit-passed" /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {light && step && !still ? <span key={jumps} className="crit-light" style={{ width: lightSize, height: lightSize, transform: `translate(${Math.round(light.x - lightSize / 2)}px, ${Math.round(light.y - lightSize / 2)}px)` }} /> : null}
    </div>
  );
}
