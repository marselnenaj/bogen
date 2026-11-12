import { artboardProxyStyle } from './artboard-proxy.ts';
import { createElement, memo, useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import { renderSpec } from '@bogen/core';
import { useChildren, useNode } from '../doc/hooks.ts';
import { resolveAsset } from '../lib/api.ts';
import { VOID_TAGS } from '../ops/ops.ts';
import { registerEl } from './measure.ts';
import { showRules } from './layer-rules.ts';
import { ShaderLayer } from './ShaderLayer.tsx';

const ATTR_RENAMES: Record<string, string> = { class: 'className', for: 'htmlFor', colspan: 'colSpan', rowspan: 'rowSpan', datetime: 'dateTime', tabindex: 'tabIndex', srcset: 'srcSet', crossorigin: 'crossOrigin' };
const BOOLEAN_ATTRS: Record<string, string> = { open: 'open', muted: 'muted', loop: 'loop', autoplay: 'autoPlay', playsinline: 'playsInline', controls: 'controls', disabled: 'disabled', checked: 'defaultChecked', readonly: 'readOnly', required: 'required', hidden: 'hidden' };
const SAFE_TAG = /^[a-z][a-z0-9-]*$/;
const BLOCKED_TAGS = new Set(['script', 'style', 'link', 'meta', 'base', 'object', 'applet', 'frame', 'frameset', 'html', 'head', 'body', 'title', 'template', 'noscript']);

function reactProps(attrs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const k = key.toLowerCase();
    if (k.startsWith('on') || k === 'id' || k === 'style' || k === 'srcdoc' || k === 'dangerouslysetinnerhtml' || k === 'ref' || k === 'key') continue;
    if ((k === 'src' || k === 'href') && /^\s*javascript:/i.test(value)) continue;
    const bool = BOOLEAN_ATTRS[k];
    if (bool) {
      if (value !== 'false') out[bool] = true;
      continue;
    }
    if (k === 'value') {
      out.defaultValue = value;
      continue;
    }
    out[ATTR_RENAMES[k] ?? key] = value;
  }
  return out;
}

/** The same element object for a layer every time, which lets React skip it without comparing anything. */
const elements = new Map<string, ReactNode>();
function childElement(id: string): ReactNode {
  let el = elements.get(id);
  if (!el) {
    if (elements.size > 50000) elements.clear();
    el = <NodeView key={id} id={id} />;
    elements.set(id, el);
  }
  return el;
}

/** One layer, one real DOM element. Re-renders only when this layer or its child list changed. */
export const NodeView = memo(function NodeView({ id, renderChildren = true, onElement, deferredHeight, deferredHint }: { id: string; renderChildren?: boolean; onElement?: (el: HTMLElement | null) => void; deferredHeight?: number; deferredHint?: string }) {
  const node = useNode(id);
  const kids = useChildren(id);
  const ref = useCallback((el: HTMLElement | null) => { registerEl(id, el); onElement?.(el); }, [id, onElement]);
  const spec = useMemo(() => (node ? renderSpec(node, resolveAsset) : null), [node]);
  const props = useMemo(() => (spec ? reactProps(spec.attrs) : null), [spec]);
  const hasRules = Boolean(node?.rules);
  // The canvas style sheet holds this layer's pseudo-elements and conditions while it is on screen.
  useEffect(() => (hasRules ? showRules(id) : undefined), [id, hasRules, node]);
  if (!node || !spec || !props) return null;

  if (node.type === 'shader') return <ShaderLayer id={id} node={node} style={spec.style as CSSProperties} refCallback={ref} />;

  let tag = spec.tag.toLowerCase();
  if (!SAFE_TAG.test(tag) || BLOCKED_TAGS.has(tag)) tag = 'div';

  const full: Record<string, unknown> = { ...props, style: renderChildren ? spec.style : artboardProxyStyle(spec.style, deferredHeight), ref, 'data-bogen-id': id, 'data-bogen-deferred': renderChildren ? undefined : '', 'data-bogen-estimated': !renderChildren && deferredHeight !== undefined ? '' : undefined };
  if (tag === 'img') full.draggable = false;

  if (spec.html !== undefined) {
    full.dangerouslySetInnerHTML = { __html: spec.html };
    // Going between plain text and ranges swaps the element, so that React never sees its children change kind.
    if (spec.runs) full.key = 'rich';
    return createElement(tag, full);
  }
  if (VOID_TAGS.has(tag) || tag === 'video' || tag === 'iframe') return createElement(tag, full);
  let children: ReactNode;
  if (spec.text !== undefined) children = spec.text;
  else if (renderChildren && kids.length) children = kids.map(childElement);
  else if (!renderChildren && deferredHint) children = <div aria-hidden="true" data-ui="deferred-screen" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ui-fg-2)', fontFamily: 'system-ui, sans-serif', fontSize: '16px', pointerEvents: 'none' }}>{deferredHint}</div>;
  return createElement(tag, full, children);
});
