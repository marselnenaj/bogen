import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';
import { agentApi } from '../lib/agent-api.ts';
import { editor, useEditor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';

/** Only on Omarchy: the colours of the active theme as tokens of this file. */
export function OmarchyPaletteButton() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    void agentApi.palette().then((p) => setName(p.tokens.length ? p.name : null), () => setName(null));
  }, []);
  if (!name) return null;
  const run = async () => {
    if (!fileId) return;
    try {
      const out = await agentApi.importPalette(fileId);
      editor().showToast(t.n(out.imported, '{count} tokens from {name}', '{count} tokens from {name}', { name: out.name ?? name }));
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  return <button type="button" className="btn btn-quiet" data-testid="token-import-omarchy" title={t('Make the colours of your Omarchy theme tokens of this file')} onClick={() => void run()}><Palette size={14} /> {t('Import {name} palette', { name })}</button>;
}
