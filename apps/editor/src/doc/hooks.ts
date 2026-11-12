import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BogenNode } from '@bogen/core';
import { session } from './session.ts';
import { useEditor } from '../state/store.ts';

// Stable subscribe functions: with a new one each render, React unsubscribes and subscribes again every
// time, which shows up in a big document with an agent writing.
export function useNode(id: string): BogenNode | undefined {
  const { snap } = session();
  const subscribe = useCallback((fn: () => void) => snap.subscribeNode(id, fn), [snap, id]);
  const read = useCallback(() => snap.node(id), [snap, id]);
  return useSyncExternalStore(subscribe, read);
}

export function useChildren(id: string): readonly string[] {
  const { snap } = session();
  const subscribe = useCallback((fn: () => void) => snap.subscribeChildren(id, fn), [snap, id]);
  const read = useCallback(() => snap.children(id), [snap, id]);
  return useSyncExternalStore(subscribe, read);
}

export function useStructureVersion(): number {
  const { snap } = session();
  return useSyncExternalStore((fn) => snap.subscribeStructure(fn), () => snap.structureVersion);
}

/**
 * The structure version, at most once a frame and backing off when reacting to it is slow. For lists
 * that read the whole tree, so that an agent writing hundreds of layers does not rebuild them each time.
 */
export function useThrottledStructure(): number {
  const { snap } = session();
  const [version, setVersion] = useState(snap.structureVersion);
  useEffect(() => {
    let frame = 0;
    let timer = 0;
    let last = 0;
    const run = () => {
      frame = 0;
      timer = 0;
      last = performance.now();
      setVersion(snap.structureVersion);
    };
    const off = snap.subscribeStructure(() => {
      if (frame || timer) return;
      // A quiet document answers on the next frame; one that keeps changing gets a frame or two of air.
      const quiet = performance.now() - last > 40;
      if (quiet) frame = requestAnimationFrame(run);
      else timer = window.setTimeout(run, 60);
    });
    setVersion(snap.structureVersion);
    return () => { off(); cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [snap]);
  return version;
}

/**
 * The document version, at most once a frame. For what reads layout to show it, such as the inspector:
 * reading layout on every change of a document an agent is writing to forces it hundreds of times.
 */
export function useFrameVersion(): number {
  const { snap } = session();
  const [version, setVersion] = useState(snap.version);
  useEffect(() => {
    let frame = 0;
    const off = snap.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setVersion(snap.version); });
    });
    return () => { off(); cancelAnimationFrame(frame); };
  }, [snap]);
  return version;
}

export function useSnapVersion(): number {
  const { snap } = session();
  return useSyncExternalStore((fn) => snap.subscribe(fn), () => snap.version);
}

export function usePages() {
  const { snap } = session();
  return useSyncExternalStore((fn) => snap.subscribe(fn), () => snap.pages);
}

export function useTokens() {
  const { snap } = session();
  return useSyncExternalStore((fn) => snap.subscribe(fn), () => snap.tokens);
}

export function useModes() {
  const { snap } = session();
  return useSyncExternalStore((fn) => snap.subscribe(fn), () => snap.modes);
}

export function useTextStyles() {
  const { snap } = session();
  return useSyncExternalStore((fn) => snap.subscribe(fn), () => snap.textStyles);
}

export function useComments() {
  const { snap } = session();
  return useSyncExternalStore((fn) => snap.subscribe(fn), () => snap.comments);
}

/** The selected nodes; the array identity only changes when one of them changed. */
export function useSelectedNodes(): BogenNode[] {
  const { snap } = session();
  const selection = useEditor((s) => s.selection);
  const last = useRef<BogenNode[]>([]);
  const get = useMemo(() => () => {
    const next: BogenNode[] = [];
    for (const id of selection) {
      const n = snap.node(id);
      if (n) next.push(n);
    }
    const prev = last.current;
    if (prev.length === next.length && prev.every((n, i) => n === next[i])) return prev;
    last.current = next;
    return next;
  }, [snap, selection]);
  return useSyncExternalStore((fn) => snap.subscribe(fn), get);
}
