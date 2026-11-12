import { settings, useSettings } from '../state/settings.ts';
import { api, type Theme } from './api.ts';
import { onServerEvent } from './events.ts';

const MONOSPACED = /mono|code|consol|courier|menlo|terminal|fixed|hack\b|iosevka|nerd font/i;

let systemTheme: Theme | null = null;
const FIXED = {
  light: { '--ui-bg':'#ffffff','--ui-bg-2':'#f6f6f5','--ui-bg-3':'#ecebea','--ui-fg':'#1d1d1c','--ui-fg-2':'#6d6c69','--ui-border':'#e4e3e1','--ui-accent':'#2f6fed','--ui-accent-fg':'#ffffff','--ui-danger':'#b3261e' },
  dark: { '--ui-bg':'#1c1c1b','--ui-bg-2':'#232322','--ui-bg-3':'#2d2d2c','--ui-fg':'#e8e7e4','--ui-fg-2':'#b4b3ae','--ui-border':'#3d3d38','--ui-accent':'#8bb4ff','--ui-accent-fg':'#10213d','--ui-danger':'#f28b82' },
};
let applied: string[] = [];
let settle = 0;
let first = true;

export function applyTheme(theme: Theme | null): void {
  systemTheme = theme;
  const preference = settings().appearance;
  if (preference !== 'system') theme = { mode: preference, vars: FIXED[preference] };
  const root = document.documentElement;
  if (!first && settings().motion !== 'reduced' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-changing');
    clearTimeout(settle);
    settle = window.setTimeout(() => root.classList.remove('theme-changing'), 320);
  }
  first = false;
  for (const key of applied) root.style.removeProperty(key);
  applied = [];
  root.style.removeProperty('--ui-font');
  if (!theme) {
    root.removeAttribute('data-theme-mode');
    return;
  }
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v);
    applied.push(k);
  }
  if (theme.mode) root.setAttribute('data-theme-mode', theme.mode);
  // A system font follows into the chrome, except a monospaced one: this UI is set in proportional
  // type at 12-13px, and terminal fonts (the usual Omarchy choice) neither read well nor fit there.
  if (theme.font && !MONOSPACED.test(theme.font)) root.style.setProperty('--ui-font', `"${theme.font}", "Source Sans 3 Variable", system-ui, sans-serif`);
}

export function startTheme(): void {
  useSettings.subscribe((next, previous) => { if (next.appearance !== previous.appearance) applyTheme(systemTheme); });
  api.theme().then(applyTheme).catch(() => applyTheme(null));
  onServerEvent((e) => {
    if (e.t === 'theme') applyTheme(e.theme);
  });
}
