import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'danger';

const tones: Record<Tone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700',
  success: 'bg-emerald-100 text-emerald-800',
  danger: 'bg-red-100 text-red-800',
};

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'danger'; children?: ReactNode }) {
  return <span className={`inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}
