import type { Token } from '@bogen/core';
import { maybeSession } from '../doc/session.ts';

const VAR = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;

/**
 * A CSS value with each `var(--token)` replaced by the token's value, through tokens that refer to other
 * tokens, for the swatches of the chrome: the file's tokens are defined on the canvas, not in the panels,
 * so `background: var(--night)` would show nothing there. Unknown names keep their fallback.
 */
export function withTokenValues(css: string, tokens: readonly Token[] | undefined = maybeSession()?.snap.tokens): string {
  if (!css.includes('var(') || !tokens) return css;
  const byName = new Map(tokens.map((t) => [t.name, t.value]));
  const expand = (value: string, depth: number): string => {
    if (depth > 8) return value;
    return value.replace(VAR, (whole, name: string, fallback: string | undefined) => {
      const known = byName.get(name);
      if (known !== undefined) return expand(known, depth + 1);
      return fallback !== undefined ? expand(fallback.trim(), depth + 1) : whole;
    });
  };
  return expand(css, 0);
}
