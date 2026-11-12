import { readProject, type BogenDoc, type BogenNode } from '@bogen/core';

/** Old theme covers showed the entire authoring board. Rebuild them lazily, through the bounded preview queue. */
export const THEME_THUMBNAIL_REVISION = 'wallpaper-1';
export const THUMBNAIL_REVISION = 'screen-1';

/** Select artwork rather than palette boards and mockups. Does not load assets, render, or change the document. */
export function thumbnailTarget(doc: BogenDoc): { nodeIds: string[] } | { pageId: string } | null {
  const pages = doc.getPages();
  const chosen = doc.meta.get('canvasCover');
  if (typeof chosen === 'string') {
    const node = doc.getNode(chosen);
    if (node?.artboard && !node.hidden && !doc.ancestors(chosen).some(id => doc.getNode(id)?.hidden)) return { nodeIds: [chosen] };
  }
  const theme = doc.meta.get('omarchyTheme');
  if (readProject(doc).type === 'omarchy-theme' && theme && typeof theme === 'object' && (theme as { target?: unknown }).target !== 'mobile') {
    // The theme contract identifies the wallpaper component. Its surrounding artboard may have any user name.
    // Search every page: an agent may put a palette or process page before the actual backgrounds.
    const candidates: BogenNode[] = [];
    for (const page of pages) {
      for (const root of doc.getChildren(page.id)) {
        if (!root.artboard || root.hidden) continue;
        const width = Number.parseFloat(root.style.width ?? '');
        const height = Number.parseFloat(root.style.height ?? '');
        if (!(width > 0 && height > 0 && width >= height)) continue;
        if (doc.getChildren(root.id).some((n) => !n.hidden && n.component && n.name === 'Wallpaper')) candidates.push(root);
      }
    }
    if (candidates[0]) return { nodeIds: [candidates[0].id] };
  }
  const all = pages.flatMap(page => doc.getChildren(page.id).filter(n => n.artboard && !n.hidden));
  const populated = all.filter(n => doc.getChildren(n.id).some(child => !child.hidden) || n.src || n.svg || n.style.backgroundImage);
  const candidates = populated.length ? populated : all.length >= 2 ? all : [];
  const score = (n: BogenNode): number => {
    const width = /^\d+(?:\.\d+)?px$/.test(n.style.width ?? '') ? Number.parseFloat(n.style.width!) : NaN;
    const height = /^\d+(?:\.\d+)?px$/.test(n.style.height ?? '') ? Number.parseFloat(n.style.height!) : NaN;
    const aspect = width > 0 && height > 0 ? width / height : NaN;
    const technical = /^(components?|tokens?|palette|style guide|design system|process|notes?|archive)(?:$|[\s·:_-])/i.test(n.name);
    const namedCover = /^(cover|thumbnail|preview|overview|hero|title)(?:$|[\s·:_-])/i.test(n.name);
    return (Number.isFinite(aspect) ? Math.abs(Math.log(aspect / (16 / 9))) : 2) + (technical ? 3 : 0) - (namedCover ? .12 : 0);
  };
  const best = candidates.map((node,index) => ({node,index,score:score(node)})).sort((a,b) => a.score-b.score || a.index-b.index)[0];
  if (best) return { nodeIds: [best.node.id] };
  const page = pages.find(p => doc.getChildren(p.id).some(n => !n.hidden));
  return page ? { pageId: page.id } : null;
}
