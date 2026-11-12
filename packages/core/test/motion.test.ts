import { describe, expect, it } from 'vitest';
import { BogenDoc, createComponent, createInstance, framerAnimation, framerValues, motionCss, motionFramer, nodeToHtml, parseKeyframes, parseTransitions, toJsx, toReact } from '../src/index.ts';

function animated() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  doc.meta.set('keyframes', ['@keyframes rise{0%{opacity:0;translate:0 16px}100%{opacity:1;translate:0 0}}', '@keyframes spin{from{rotate:0deg}to{rotate:1turn}}']);
  const board = doc.insert(page, { type: 'frame', name: 'Hero', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '800px', display: 'flex' } });
  const title = doc.insert(board, { type: 'text', tag: 'h1', name: 'Hero title', text: 'Hello', style: { fontSize: '48px', animation: 'rise 600ms cubic-bezier(.2,.8,.2,1) 100ms both' } });
  const badge = doc.insert(board, { type: 'frame', name: 'Badge', style: { width: '20px', height: '20px', animationName: 'spin', animationDuration: '1s', animationTimingFunction: 'linear', animationIterationCount: 'infinite' } });
  const button = doc.insert(board, { type: 'text', tag: 'button', name: 'Buy', text: 'Buy', style: { transition: 'transform 200ms ease-out' } });
  doc.updateRules(button, ':hover', { transform: 'translateY(-2px) scale(1.02)' });
  return { doc, page, board, title, badge, button };
}

describe('motion as clean CSS', () => {
  it('writes the keyframes used, and animation and transition on a class per layer, only without reduced motion', () => {
    const { doc, board, title, badge, button } = animated();
    const out = motionCss(doc, [board]);
    expect(out.css).toContain('@keyframes rise {\n  0% {\n    opacity: 0;\n    translate: 0 16px;\n  }');
    expect(out.css).toContain('@keyframes spin');
    expect(out.css).toContain('@media (prefers-reduced-motion: no-preference) {');
    expect(out.css).toContain('.motion-hero-title {\n    animation: rise 600ms cubic-bezier(.2,.8,.2,1) 100ms both;');
    expect(out.css).toContain('.motion-badge {\n    animation: spin 1000ms linear infinite;');
    expect(out.css).toContain('.motion-buy {\n    transition: transform 200ms ease-out;');
    // The keyframes come before the media block, and nothing moves outside it.
    const media = out.css.indexOf('@media');
    expect(out.css.slice(0, media)).not.toMatch(/animation:|transition:/);
    expect(out.layers.get(title)).toEqual({ className: 'motion-hero-title', strip: ['animation'] });
    expect(out.layers.get(badge)?.strip.sort()).toEqual(['animationDuration', 'animationIterationCount', 'animationName', 'animationTimingFunction']);
    expect(out.layers.get(button)?.className).toBe('motion-buy');
  });

  it('takes motion out of the inline style of the HTML and puts the class on', () => {
    const { doc, board } = animated();
    const motion = motionCss(doc, [board]);
    const html = nodeToHtml(doc, board, { motion, indent: true });
    expect(html).not.toMatch(/animation|transition/);
    expect(html).toContain('class="motion-hero-title"');
    expect(html).toMatch(/class="bgn-[\w-]+ motion-buy"/);
  });

  it('carries it in the React component\'s style element', () => {
    const { doc, board } = animated();
    const code = toJsx(doc, board, 'inline', undefined, 'css');
    expect(code).toContain('className="motion-hero-title"');
    expect(code).toContain('prefers-reduced-motion: no-preference');
    expect(code).not.toMatch(/animation: "rise/);
  });

  it('says so when a layer uses keyframes the file does not have', () => {
    const { doc, board, title } = animated();
    doc.updateStyle(title, { animation: 'wobble 1s' });
    expect(motionCss(doc, [board]).notes.join(' ')).toContain('wobble');
  });
});

describe('motion as Framer Motion', () => {
  it('turns stops into keyframe arrays with x, y, scale and rotate', () => {
    expect(framerValues({ opacity: '0', translate: '0 16px' })).toEqual({ opacity: 0, x: 0, y: 16 });
    expect(framerValues({ transform: 'translateY(-2px) scale(1.02)' })).toEqual({ y: -2, scale: 1.02 });
    expect(framerValues({ transform: 'matrix(1,0,0,1,0,0)' })).toEqual({ transform: 'matrix(1,0,0,1,0,0)' });
    expect(framerValues({ rotate: '1turn', backgroundColor: '#fff' })).toEqual({ rotate: 360, backgroundColor: '#fff' });
    const rise = parseKeyframes('@keyframes rise{0%{opacity:0;translate:0 16px}60%{opacity:1}100%{opacity:1;translate:0 0}}')!;
    const out = framerAnimation({ name: 'rise', duration: 600, delay: 100, easing: 'cubic-bezier(.2,.8,.2,1)', iterations: 1, direction: 'normal', fill: 'both' }, rise);
    expect(out.animate).toEqual({ opacity: [0, 1, 1], x: [0, 0, 0], y: [16, 16, 0] });
    expect(out.initial).toEqual({ opacity: 0, x: 0, y: 16 });
    expect(out.transition).toEqual({ duration: 0.6, delay: 0.1, ease: [0.2, 0.8, 0.2, 1], times: [0, 0.6, 1] });
    const loop = framerAnimation({ name: 'rise', duration: 1000, delay: 0, easing: 'steps(4)', iterations: 'infinite', direction: 'alternate', fill: 'none' }, rise);
    expect(loop.transition).toMatchObject({ repeat: Infinity, repeatType: 'reverse' });
    expect(loop.notes.join(' ')).toContain('steps(4)');
  });

  it('writes motion components in the React export, with reduced motion left to MotionConfig', () => {
    const { doc, board, button } = animated();
    const handoff = motionFramer(doc, [board]);
    expect(handoff.layers.get(button)?.dropBlocks).toEqual([':hover']);
    const code = toJsx(doc, board, 'tailwind', undefined, 'framer');
    expect(code.startsWith("import { motion, MotionConfig } from 'framer-motion';")).toBe(true);
    expect(code).toContain('<MotionConfig reducedMotion="user">');
    expect(code).toContain('<motion.h1');
    expect(code).toContain('initial={{ opacity: 0, x: 0, y: 16 }}');
    expect(code).toContain('animate={{ opacity: [0, 1], x: [0, 0], y: [16, 0] }}');
    expect(code).toContain('transition={{ duration: 0.6, delay: 0.1, ease: [0.2, 0.8, 0.2, 1] }}');
    expect(code).toContain('animate={{ rotate: [0, 360] }}');
    expect(code).toContain('repeat: Infinity');
    expect(code).toContain('whileHover={{ y: -2, scale: 1.02 }}');
    expect(code).toContain('<motion.button');
    expect(code).not.toContain('hover:');
    expect(code).not.toMatch(/animation|transition: "/);
  });

  it('works through components too', () => {
    const { doc, page, title } = animated();
    const card = doc.insert(page, { type: 'frame', name: 'Card', style: { position: 'absolute', left: '0px', top: '600px', width: '200px', animation: 'rise 300ms ease both' } });
    createComponent(doc, card);
    const board = doc.insert(page, { type: 'frame', name: 'Grid', artboard: true, style: { position: 'absolute', left: '1000px', top: '0px', width: '400px' } });
    createInstance(doc, card, board);
    const code = toReact(doc, board, 'inline', undefined, 'framer');
    expect(code).toContain("import { motion, MotionConfig } from 'framer-motion';");
    expect(code).toMatch(/export function Card[\s\S]*<motion\.div/);
    expect(code).toContain('<MotionConfig reducedMotion="user">');
    void title;
  });

  it('reads transitions from the shorthand and the longhands', () => {
    expect(parseTransitions({ transition: 'opacity 150ms, transform .2s ease-in 50ms' })).toEqual([
      { property: 'opacity', duration: 150, delay: 0, easing: 'ease' },
      { property: 'transform', duration: 200, delay: 50, easing: 'ease-in' },
    ]);
    expect(parseTransitions({ transitionProperty: 'color', transitionDuration: '1s' })).toEqual([{ property: 'color', duration: 1000, delay: 0, easing: 'ease' }]);
  });
});
