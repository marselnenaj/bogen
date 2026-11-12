import { t } from '../i18n/store.ts';
export interface LocalUser { name: string; color: string }

const KEY = 'bogen-user';
const COLORS = ['#e5484d', '#e8772e', '#c98a00', '#30a46c', '#0e9aa7', '#3e8bd8', '#6e56cf', '#c2389b'];

export function pickColor(seed: number): string {
  return COLORS[Math.abs(Math.floor(seed)) % COLORS.length]!;
}

export function loadUser(): LocalUser {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as LocalUser;
  } catch {
    // Fall through to a fresh identity.
  }
  const n = Math.floor(Math.random() * 90) + 10;
  const user = { name: t('Guest {number}', { number: n }), color: pickColor(Math.random() * COLORS.length) };
  saveUser(user);
  return user;
}

export function saveUser(user: LocalUser): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    // Private mode. The identity lasts for this tab.
  }
}
