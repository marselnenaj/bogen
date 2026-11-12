/** REST client for Drift and the restyle. See "Contracts between packages" in docs/SPEC.md. */
import { t } from '../i18n/store.ts';

export type DriftKind = 'spacing' | 'size' | 'color' | 'font' | 'text' | 'missing' | 'extra';
export interface DriftBox { x: number; y: number; width: number; height: number }
export interface Drift {
  kind: DriftKind;
  layer_id?: string;
  layer?: string;
  property?: string;
  design?: string;
  live?: string;
  brand?: { design: boolean; live: boolean; live_name?: string };
  live_element?: { selector: string; tag: string; text?: string; box: DriftBox };
  design_box?: DriftBox;
}
export interface DriftReport {
  node_id: string;
  url: string;
  width: number;
  color_scheme: 'light' | 'dark';
  pixels: { different_percent: number; bounds: DriftBox | null; overlay: { url: string; width: number; height: number }; live: string };
  matched: number;
  counts: Record<DriftKind, number>;
  drifts: Drift[];
  more?: number;
  notes: string[];
  at: number;
}
export interface DriftDefaults { node_id: string; name: string; url: string | null; width: number | null; color_scheme: 'light' | 'dark' }

export interface RestyleResult {
  file_id: string;
  created_file: boolean;
  node_id: string;
  page_id: string;
  brand: { id: string; name: string };
  kept: { text: boolean; images: boolean };
  restyle: { colors: { from: string; to: string; name: string }[]; fonts: { from: string; to: string }[]; font_sizes: number; spacing: number; radius: number; texts_replaced: number; images_replaced: number; notes: string[] };
  check: { score: number; hard: number; soft: number };
  notice: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const detail = await res.json().then((b: { error?: string }) => b.error).catch(() => null);
    throw new Error(detail ?? t('{method} {path} failed with {status}', { method: init?.method ?? 'GET', path, status: res.status }));
  }
  return (await res.json()) as T;
}

const post = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const driftApi = {
  defaults: (fileId: string, nodeId: string) => json<DriftDefaults>(`/api/files/${fileId}/drift?node=${encodeURIComponent(nodeId)}`),
  check: (fileId: string, body: { nodeId: string; url?: string }) => json<DriftReport>(`/api/files/${fileId}/drift`, post(body)),
  restyle: (fileId: string, body: { url: string; brandId?: string; width?: number; colorScheme?: 'light' | 'dark'; keepText?: boolean; keepImages?: boolean }) => json<RestyleResult>(`/api/files/${fileId}/restyle`, post(body)),
};
