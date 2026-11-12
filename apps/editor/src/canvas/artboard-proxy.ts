/** App-only proxy paint. Geometry stays measurable; offscreen wallpaper/effects must not keep GPU assets live. */
export function artboardProxyStyle(style: Record<string, string>, height?: number): Record<string, string> {
  const proxy = { ...style };
  for (const key of Object.keys(proxy)) if (/background|mask|filter|shadow|animation|transition|willChange|borderImage/i.test(key)) delete proxy[key];
  return { ...proxy, backgroundColor: style.backgroundColor ?? 'var(--ui-bg)', outline: '1px solid var(--ui-border)', ...(height === undefined ? {} : { height: `${height}px` }) };
}
