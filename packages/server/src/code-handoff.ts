import { codeFilesText, exactAppText, motionHandoff, nodeToHtml, RESET_CSS, textStyleCssFor, toExactApp, toReact, toSfc, toSwiftUI, tokensCss, type BogenDoc, type CodeFile, type MotionMode } from '@bogen/core';

/** `exact` is experimental: an Exact app in Contract (core's exact-export.ts). vue, svelte and swiftui are files of components. */
export type HandoffFormat = 'html' | 'react-inline' | 'react-tailwind' | 'exact' | 'vue' | 'svelte' | 'swiftui';

/** The formats whose code is several files: a component per file, the page or screen, and the tokens. */
export type HandoffFilesFormat = 'vue' | 'svelte' | 'swiftui';

/** A layer as the files of a framework, with what the code could not say, and for SwiftUI the SVGs for the asset catalog. */
export function handoffFiles(doc: BogenDoc, nodeId: string, format: HandoffFilesFormat, base: string): { files: CodeFile[]; entry: string; notes: string[] } {
  if (!doc.getNode(nodeId)) throw new Error(`No layer with id ${nodeId}.`);
  const resolve = (src: string) => (src.startsWith('bogen-asset:') ? `${base}/assets/${src.slice('bogen-asset:'.length)}` : src);
  if (format === 'swiftui') {
    const out = toSwiftUI(doc, nodeId, resolve);
    return { files: [...out.files, ...out.assets.map((a) => ({ path: `Assets/${a.name}.svg`, text: `${a.svg}\n` }))], entry: out.entry, notes: out.notes };
  }
  const out = toSfc(doc, nodeId, format, resolve);
  return { files: out.files, entry: out.entry, notes: out.notes };
}

/** A layer as code to hand off, with the token, text style and motion CSS it relies on: what `code_get` returns, and what a pull request run reads. */
export function handoffCode(doc: BogenDoc, nodeId: string, format: HandoffFormat, base: string, motionMode: MotionMode = 'css'): string {
  if (!doc.getNode(nodeId)) throw new Error(`No layer with id ${nodeId}.`);
  const resolve = (src: string) => (src.startsWith('bogen-asset:') ? `${base}/assets/${src.slice('bogen-asset:'.length)}` : src);
  // Exact's files carry their own notes; motion is left out of them and listed with what else is.
  if (format === 'exact') return exactAppText(toExactApp(doc, nodeId), resolve);
  if (format === 'vue' || format === 'svelte' || format === 'swiftui') {
    if (motionMode === 'framer') throw new Error('Framer Motion is for React: use format react-inline or react-tailwind, or motion css.');
    const out = handoffFiles(doc, nodeId, format, base);
    // The SVGs for the asset catalog are long and named in the notes: export_file writes them.
    return codeFilesText(out.files.filter((f) => !f.path.startsWith('Assets/')), out.notes);
  }
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
