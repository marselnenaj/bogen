import { exactAppText, motionHandoff, nodeToHtml, RESET_CSS, textStyleCssFor, toExactApp, toReact, tokensCss, type BogenDoc, type MotionMode } from '@bogen/core';

/** `exact` is experimental: an Exact app in Contract (core's exact-export.ts). */
export type HandoffFormat = 'html' | 'react-inline' | 'react-tailwind' | 'exact';

/** A layer as code to hand off, with the token, text style and motion CSS it relies on: what `code_get` returns, and what a pull request run reads. */
export function handoffCode(doc: BogenDoc, nodeId: string, format: HandoffFormat, base: string, motionMode: MotionMode = 'css'): string {
  if (!doc.getNode(nodeId)) throw new Error(`No layer with id ${nodeId}.`);
  const resolve = (src: string) => (src.startsWith('bogen-asset:') ? `${base}/assets/${src.slice('bogen-asset:'.length)}` : src);
  // Exact's files carry their own notes; motion is left out of them and listed with what else is.
  if (format === 'exact') return exactAppText(toExactApp(doc, nodeId), resolve);
  if (format === 'html' && motionMode === 'framer') throw new Error('Framer Motion is for React: use format react-inline or react-tailwind, or motion css for html.');
  const motion = format === 'html' ? motionHandoff(doc, [nodeId], motionMode) : undefined;
  const code = format === 'html'
    ? nodeToHtml(doc, nodeId, { resolve, indent: true, stripRootPosition: true, ...(motion?.layers.size ? { motion } : {}) })
    : toReact(doc, nodeId, format === 'react-inline' ? 'inline' : 'tailwind', resolve, motionMode);
  const usesTokens = code.includes('var(--') || code.includes('(--');
  const hasShader = [doc.getNode(nodeId)!, ...doc.descendants(nodeId)].some((n) => n.type === 'shader');
  return [
    code,
    // The canvas draws on these, so inline styles alone lay out differently without them. Tailwind has its preflight instead.
    format === 'react-tailwind' ? '' : `/* Base styles the design assumes. Leave them out if your project has its own reset, such as Tailwind's preflight. */\n${RESET_CSS}`,
    usesTokens ? `/* Tokens this code relies on */\n${tokensCss(doc)}` : '',
    textStyleCssFor(doc, code) ? `/* Text styles this code relies on */\n${textStyleCssFor(doc, code)}` : '',
    motion?.css ? `/* Motion: put this in your style sheet */\n${motion.css}` : '',
    motion?.notes.length ? `/* ${motion.notes.join(' ').replace(/\*\//g, '* /')} */` : '',
    hasShader ? '/* Shader layers come out as an empty element with data-shader. Mount them with @paper-design/shaders-react, using the parameters from layer_get. */' : '',
  ].filter(Boolean).join('\n\n');
}
