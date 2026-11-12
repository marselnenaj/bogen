/** Which styles the simplifier may try to remove at all. Pure. */
/** What sets the place or the behaviour of a layer goes only when it says what would be there anyway. */
const KEEP_UNLESS_INITIAL = /^(position|left|top|right|bottom|inset|width|height|minWidth|minHeight|maxWidth|maxHeight|flexBasis|flexGrow|flexShrink|alignSelf|gridColumn|gridRow|gridArea|aspectRatio|animation|transition)/;
const INITIAL = /^(auto|static|none|0s|normal|0|0px)$/;

/**
 * Whether two properties write to the same place, as a shorthand and what it stands for do. Taking one
 * away in the DOM can take the other with it, so such a pair is left alone.
 */
export function overlapping(a: string, b: string): boolean {
  if (a === b) return false;
  const inPrefix = (x: string, y: string) => y.startsWith(x) && /[A-Z]/.test(y[x.length] ?? '');
  if (inPrefix(a, b) || inPrefix(b, a)) return true;
  const family = (k: string): string | null => {
    if (/^border(Top|Right|Bottom|Left)?(Left|Right)?Radius$/.test(k)) return 'radius';
    if (/^border(Top|Right|Bottom|Left)?Width$/.test(k)) return 'border-width';
    if (/^border(Top|Right|Bottom|Left)?Color$/.test(k)) return 'border-color';
    if (/^border(Top|Right|Bottom|Left)?Style$/.test(k)) return 'border-style';
    if (k === 'gap' || k === 'rowGap' || k === 'columnGap') return 'gap';
    if (k === 'inset' || k === 'top' || k === 'right' || k === 'bottom' || k === 'left') return 'inset';
    if (k === 'font' || k === 'lineHeight' || k.startsWith('font')) return 'font';
    if (k === 'flexFlow' || k === 'flexDirection' || k === 'flexWrap') return 'flex-flow';
    return null;
  };
  const f = family(a);
  return f !== null && f === family(b);
}

export function removable(key: string, value: string): boolean {
  if (key.startsWith('--')) return false;
  if (KEEP_UNLESS_INITIAL.test(key)) return INITIAL.test(value);
  return true;
}
