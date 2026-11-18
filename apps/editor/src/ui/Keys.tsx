import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { keyParts } from '../commands/registry.ts';
import { useT } from '../i18n/react.ts';

const ARROWS = { arrowleft: [ArrowLeft, 'Left'], arrowright: [ArrowRight, 'Right'], arrowup: [ArrowUp, 'Up'], arrowdown: [ArrowDown, 'Down'] } as const;

/** One key cap, with arrow keys drawn as icons: arrow characters turn into emoji on phones. */
export function Key({ name }: { name: string }) {
  const t = useT();
  const arrow = ARROWS[name as keyof typeof ARROWS];
  if (!arrow) return <kbd>{name}</kbd>;
  const [Icon, label] = arrow;
  return <kbd aria-label={t(label)} title={t(label)}><Icon size={12} aria-hidden="true" /></kbd>;
}

/** A shortcut such as `shift+arrowup`, as a row of key caps. */
export function Keys({ combo, className }: { combo: string; className?: string }) {
  return <span className={className ? `keys ${className}` : 'keys'}>{keyParts(combo).map((part, i) => <Key key={i} name={part} />)}</span>;
}
