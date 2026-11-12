import { kebabCss } from '@bogen/core';
import { msg } from '../i18n/core.ts';

/** A long list of computed styles, sorted the way people think about them. Pure. */
const GROUPS: { title: string; test: RegExp }[] = [
  { title: msg('Layout'), test: /^(display|position|left|top|right|bottom|inset|zIndex|float|clear|flex|grid|align|justify|order|gap|rowGap|columnGap|place|verticalAlign|tableLayout|borderCollapse|borderSpacing|captionSide|emptyCells)/ },
  { title: msg('Size'), test: /^(width|height|minWidth|minHeight|maxWidth|maxHeight|aspectRatio|boxSizing|overflow|objectFit|objectPosition|contain|blockSize|inlineSize|minBlockSize|minInlineSize|maxBlockSize|maxInlineSize|resize)/ },
  { title: msg('Spacing'), test: /^(padding|margin)/ },
  { title: msg('Typography'), test: /^(font|lineHeight|letterSpacing|wordSpacing|text(?!Shadow)|color|whiteSpace|wordBreak|overflowWrap|hyphens|direction|writingMode|listStyle|tabSize|unicodeBidi|lineBreak|quotes|WebkitText|WebkitLine|WebkitFont|caretColor|accentColor|counter)/ },
  { title: msg('Background'), test: /^(background|WebkitBackground)/ },
  { title: msg('Border'), test: /^(border|outline)/ },
  { title: msg('Effects'), test: /^(boxShadow|textShadow|opacity|filter|backdropFilter|WebkitBackdrop|mixBlendMode|isolation|clipPath|mask|WebkitMask|shapeOutside|imageRendering)/ },
  { title: msg('Transform'), test: /^(transform|rotate|scale|translate|perspective|backfaceVisibility|willChange)/ },
  { title: msg('Motion'), test: /^(animation|transition|offset)/ },
  { title: msg('Interaction'), test: /^(cursor|pointerEvents|userSelect|touchAction|visibility|scroll|WebkitTap|WebkitUser|appearance|WebkitAppearance)/ },
  { title: msg('Vector'), test: /^(fill|stroke|paintOrder|markerStart|markerEnd|markerMid|vectorEffect)/ },
];

export function groupOf(key: string): string {
  if (key.startsWith('--')) return msg('Variables');
  return GROUPS.find((g) => g.test.test(key))?.title ?? msg('Other');
}

const SIDES: { short: string; keys: [string, string, string, string] }[] = [
  { short: 'padding', keys: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] },
  { short: 'margin', keys: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] },
  { short: 'inset', keys: ['top', 'right', 'bottom', 'left'] },
  { short: 'borderWidth', keys: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] },
  { short: 'borderColor', keys: ['borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'] },
  { short: 'borderStyle', keys: ['borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle'] },
  { short: 'borderRadius', keys: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] },
];

function foldSides(top: string, right: string, bottom: string, left: string): string {
  if (top === right && right === bottom && bottom === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  if (right === left) return `${top} ${right} ${bottom}`;
  return `${top} ${right} ${bottom} ${left}`;
}

export interface StyleRow {
  /** The property to write. */
  key: string;
  /** What the row shows on the left. */
  label: string;
  value: string;
  /** What a change has to clear, when the row folds several properties into one. */
  sources?: string[];
  /** The value is the browser's default for it anyway. */
  quiet: boolean;
}
export interface StyleGroup { title: string; rows: StyleRow[] }

const QUIET = /^(normal|none|auto|0|0px|0%|visible|static|initial|unset|inherit|transparent|baseline|start|stretch|nowrap|ltr|rgba\(0, 0, 0, 0\)|0s|ease|running|repeat|border-box|padding-box|medium|1)$/;

/** Rows by group, with the four sides of a property read as one where they can be. */
export function groupStyle(style: Record<string, string>): StyleGroup[] {
  const left = new Set(Object.keys(style));
  const rows: StyleRow[] = [];
  for (const { short, keys } of SIDES) {
    if (short === 'inset') continue;
    if (keys.every((k) => left.has(k)) && !left.has(short)) {
      for (const k of keys) left.delete(k);
      const value = foldSides(style[keys[0]]!, style[keys[1]]!, style[keys[2]]!, style[keys[3]]!);
      rows.push({ key: short, label: kebabCss(short), value, sources: keys, quiet: QUIET.test(value) });
    }
  }
  for (const key of left) rows.push({ key, label: kebabCss(key), value: style[key]!, quiet: QUIET.test(style[key]!) });
  const byGroup = new Map<string, StyleRow[]>();
  for (const r of rows) {
    const g = groupOf(r.key);
    const list = byGroup.get(g);
    if (list) list.push(r);
    else byGroup.set(g, [r]);
  }
  const order = [...GROUPS.map((g) => g.title), msg('Variables'), msg('Other')];
  return order.flatMap((title) => {
    const list = byGroup.get(title);
    return list ? [{ title, rows: list.sort((a, b) => a.label.localeCompare(b.label)) }] : [];
  });
}
