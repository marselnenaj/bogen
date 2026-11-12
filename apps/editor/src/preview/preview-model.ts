import type { BogenDoc, BogenNode, LayerProto, ProtoMachine, ProtoModel, ProtoRunState, ProtoTransition } from '@bogen/core';
import { protoInteractionCss, setMembers } from '@bogen/core';
import type { LocalView } from '../doc/snapshot.ts';
import { msg } from '../i18n/core.ts';

/** What preview mode needs from a document, without the DOM. Pure. */
export interface ArtboardEntry { id: string; name: string; pageId: string; pageName: string; width: number; height: number }

export { cleanHover } from '@bogen/core';

/** Real CSS for hover overrides and pointers: they have to beat inline styles, hence `!important`. The export writes the same. */
export function interactionCss(nodes: Iterable<BogenNode>): string {
  return protoInteractionCss(nodes, '.pv-world ');
}

export function clampDuration(ms: unknown): number {
  const n = Number(ms);
  return Number.isFinite(n) ? Math.max(0, Math.min(5000, n)) : 300;
}

/** Labels are English, shown through `t(label)`. */
export const TRANSITIONS: { value: ProtoTransition; label: string }[] = [
  { value: 'none', label: msg('Instant') }, { value: 'fade', label: msg('Fade') }, { value: 'slide-left', label: msg('Slide left') }, { value: 'slide-right', label: msg('Slide right') }, { value: 'slide-up', label: msg('Slide up') }, { value: 'slide-down', label: msg('Slide down') },
];

/** The first layer from here up that goes somewhere when clicked. */
export function linkTarget(start: string | null, get: (id: string) => BogenNode | undefined, exists: (id: string) => boolean): { proto: LayerProto; link: string } | null {
  let id = start;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const n = get(id);
    if (!n) return null;
    if (n.proto?.link && exists(n.proto.link)) return { proto: n.proto, link: n.proto.link };
    id = n.parent;
  }
  return null;
}

export function neighbour(list: { id: string }[], id: string, step: 1 | -1): string | null {
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return list[0]?.id ?? null;
  return list[i + step]?.id ?? null;
}

/**
 * What the prototype's state changes on screen, as views that are never stored: which layers show,
 * which variant an instance takes, and what a text layer bound to a variable says.
 */
export function protoViews(doc: BogenDoc, model: ProtoModel, m: ProtoMachine, state: ProtoRunState): Map<string, LocalView> {
  const out = new Map<string, LocalView>();
  const add = (id: string, v: LocalView) => out.set(id, { ...out.get(id), ...v });
  for (const [id, l] of Object.entries(model.layers)) {
    if (l.showWhen || l.hidden || id in state.visible) {
      const shown = m.visible(model, state, id);
      add(id, shown ? { hidden: false, ...(l.display ? { display: l.display } : {}) } : { hidden: true });
    }
    if (l.variant) {
      const value = m.variant(model, state, id);
      const node = doc.rawNode(id);
      const main = node?.instanceOf !== undefined ? doc.rawNode(node.instanceOf) : undefined;
      const set = main?.component?.set;
      if (value !== undefined && main && set && main.component?.variant?.[l.variant.prop] !== value) {
        const wanted = { ...main.component?.variant, [l.variant.prop]: value };
        const member = setMembers(doc.source, set).find((s) => Object.entries(wanted).every(([k, v]) => s.component?.variant?.[k] === v));
        if (member) add(id, { instanceOf: member.id });
      }
    }
    const text = m.text(model, state, id);
    if (text !== undefined) add(id, { text });
  }
  return out;
}

/** The layer under the pointer and every layer it is in, nearest first. */
export function layerChain(target: EventTarget | null): string[] {
  const out: string[] = [];
  let el = target instanceof Element ? target.closest('[data-bogen-id]') : null;
  while (el) {
    out.push(el.getAttribute('data-bogen-id')!);
    el = el.parentElement ? el.parentElement.closest('[data-bogen-id]') : null;
  }
  return out;
}
