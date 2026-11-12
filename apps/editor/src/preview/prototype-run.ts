import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { protoMachine, protoModel, protoScreens, type ProtoMachine, type ProtoRunState, type ProtoTransition } from '@bogen/core';
import type { Session } from '../doc/session.ts';
import { layerChain, protoViews } from './preview-model.ts';

type Saved = ReturnType<ProtoMachine['enter']>['saved'];
type Nav = { to: string; transition: string; duration: number } | null;
type Go = (id: string, transition?: ProtoTransition, ms?: number) => void;

const machine = protoMachine();

/**
 * The prototype running in preview mode: the same model and state machine as the export, with what the
 * state shows put on screen as views that are never stored, so that clicking around changes nothing in
 * the file.
 */
export function usePrototype(session: Session, version: number, screen: string | undefined, go: Go) {
  const model = useMemo(() => protoModel(session.doc, protoScreens(session.doc)), [session, version]);
  const [state, setState] = useState<ProtoRunState>(() => machine.init(model, screen));
  const live = useRef(state);
  live.current = state;
  const entered = useRef(new Map<string, Saved>());

  // A variable made or removed while previewing joins or leaves the running state; the others keep their value.
  useEffect(() => {
    setState((s) => {
      const vars: ProtoRunState['vars'] = {};
      for (const [name, v] of Object.entries(model.variables)) vars[name] = name in s.vars && typeof s.vars[name] === typeof v.value ? s.vars[name]! : v.value;
      return { ...s, vars };
    });
  }, [model]);

  // Moving with the bar or the keys is moving too.
  useEffect(() => {
    if (screen && screen !== live.current.screen) setState((s) => ({ ...s, screen }));
  }, [screen]);

  useEffect(() => {
    session.snap.setLocal(protoViews(session.doc, model, machine, state));
  }, [session, model, state]);
  useEffect(() => () => session.snap.setLocal(new Map()), [session]);

  // Fields show their variable, except the one being typed in.
  useLayoutEffect(() => {
    for (const [id, l] of Object.entries(model.layers)) {
      if (!l.bind) continue;
      const value = state.vars[l.bind.variable];
      for (const el of document.querySelectorAll<HTMLInputElement>(`.pv-stage [data-bogen-id="${CSS.escape(id)}"]`)) {
        if (l.bind.kind === 'checkbox') el.checked = Boolean(value);
        else if (document.activeElement !== el && el.value !== String(value ?? '')) el.value = String(value ?? '');
      }
    }
  });

  const step = useCallback((next: ProtoRunState, nav: Nav) => {
    live.current = next;
    setState(next);
    if (nav) go(nav.to, nav.transition as ProtoTransition, nav.duration);
  }, [go]);

  /** A click: true when the prototype answered it. */
  const click = useCallback((target: EventTarget | null): boolean => {
    const out = machine.dispatch(model, live.current, layerChain(target), 'click');
    if (!out.handled) return false;
    step(out.state, out.nav);
    return true;
  }, [model, step]);

  const submit = useCallback((target: EventTarget | null) => {
    const out = machine.dispatch(model, live.current, layerChain(target), 'submit');
    if (out.handled) step(out.state, out.nav);
  }, [model, step]);

  /** The pointer moved to another layer: what it left undoes its hover, what it came over runs its own. */
  const hover = useCallback((target: EventTarget | null) => {
    const chain = new Set(layerChain(target).filter((id) => model.layers[id]?.on?.hover?.length));
    let s = live.current;
    let nav: Nav = null;
    for (const [id, saved] of [...entered.current].reverse()) {
      if (chain.has(id)) continue;
      s = machine.leave(s, saved);
      entered.current.delete(id);
    }
    for (const id of [...chain].reverse()) {
      if (entered.current.has(id)) continue;
      const out = machine.enter(model, s, id);
      entered.current.set(id, out.saved);
      s = out.state;
      nav = out.nav ?? nav;
    }
    if (s !== live.current) step(s, nav);
  }, [model, step]);

  const field = useCallback((target: EventTarget | null) => {
    const el = target instanceof HTMLElement ? target.closest<HTMLInputElement>('[data-bogen-id]') : null;
    const id = el?.getAttribute('data-bogen-id');
    const bind = id ? model.layers[id]?.bind : undefined;
    if (!el || !id || !bind) return;
    step(machine.field(model, live.current, id, bind.kind === 'checkbox' ? el.checked : el.value), null);
  }, [model, step]);

  const restart = useCallback(() => {
    entered.current.clear();
    const fresh = machine.init(model);
    step(fresh, null);
    if (fresh.screen) go(fresh.screen);
  }, [model, step, go]);

  const names = Object.keys(model.variables);
  const summary = names.map((n) => `${n} ${JSON.stringify(state.vars[n])}`).join(', ');
  return { click, submit, hover, field, restart, summary, stateful: names.length > 0 || Object.values(model.layers).some((l) => l.on && Object.keys(l.on).some((t) => t !== 'click') || l.showWhen || l.bind || l.variant) };
}
