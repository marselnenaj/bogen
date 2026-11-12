import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import type { BogenNode } from '@bogen/core';
import { resolveAsset } from '../lib/api.ts';
import { DEFAULT_SHADER, parseShaderAttrs, shaderComponent, shaderPresets, presetToAttrs } from '../lib/shaders.ts';
import { invalidateStill, joinPool, slotOf, type ShaderSlot } from './shader-pool.ts';

const FILL: CSSProperties = { width: '100%', height: '100%', display: 'block' };
const STILL: CSSProperties = { width: '100%', height: '100%', display: 'block', objectFit: 'cover', pointerEvents: 'none' };

/**
 * A live GPU layer, when it has a place in the budget, and a picture of itself when it does not. The
 * element itself is always one real DOM node that can be styled and moved.
 */
export function ShaderLayer({ id, node, style, refCallback }: { id: string; node: BogenNode; style: CSSProperties; refCallback: (el: HTMLElement | null) => void }) {
  const type = node.attrs?.type ?? DEFAULT_SHADER;
  const [Comp, setComp] = useState<ComponentType<Record<string, unknown>> | null>(null);
  const [defaults, setDefaults] = useState<Record<string, unknown>>({});
  const [slot, setSlot] = useState<ShaderSlot>({ live: false, still: null });
  const elRef = useRef<HTMLDivElement | null>(null);
  const leave = useRef<(() => void) | null>(null);

  const ref = useCallback((el: HTMLDivElement | null) => {
    refCallback(el);
    elRef.current = el;
    leave.current?.();
    leave.current = el ? joinPool(id, el, () => setSlot(slotOf(id))) : null;
  }, [id, refCallback]);

  useEffect(() => {
    let alive = true;
    void Promise.all([shaderComponent(type), shaderPresets(type)]).then(([c, presets]) => {
      if (!alive) return;
      setComp(() => c);
      const first = presets[0];
      setDefaults(first ? parseShaderAttrs(presetToAttrs(type, first)) : {});
    });
    return () => { alive = false; };
  }, [type]);

  const params = useMemo(() => {
    const merged: Record<string, unknown> = { ...defaults, ...parseShaderAttrs(node.attrs) };
    for (const key of ['image', 'src']) {
      const v = merged[key];
      if (typeof v === 'string') merged[key] = resolveAsset(v);
    }
    return merged;
  }, [node.attrs, defaults]);

  useEffect(() => invalidateStill(id), [id, params]);

  return (
    <div ref={ref} data-bogen-id={id} data-shader={type} style={style}>
      {Comp && slot.live ? <Comp {...params} style={FILL} /> : null}
      {!slot.live && slot.still ? <img src={slot.still} alt="" draggable={false} style={STILL} data-shader-still="" /> : null}
    </div>
  );
}
