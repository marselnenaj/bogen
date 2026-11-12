import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, type ExampleEntry } from '../lib/api.ts';
import { useT } from '../i18n/react.ts';

const OPEN_KEY = 'bogen-home-examples';

function storedOpen(): boolean | null {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

/**
 * Finished designs to start from, each with a small brand of its own. Open while there are few files, folded away
 * once there are more, and remembered when the person opens or closes it.
 */
export function ExamplesSection({ fileCount }: { fileCount: number }) {
  const t = useT();
  const [examples, setExamples] = useState<ExampleEntry[] | null>(null);
  const [open, setOpen] = useState<boolean>(() => storedOpen() ?? fileCount < 4);
  const [making, setMaking] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    api.examples().then(setExamples).catch(() => setExamples([]));
  }, []);
  if (!examples?.length) return null;
  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem(OPEN_KEY, open ? '0' : '1'); } catch { /* for this visit */ }
  };
  const make = (ex: ExampleEntry) => {
    setMaking(ex.id);
    setFailed(null);
    void api.useExample(ex.id).then((out) => { location.hash = `#/file/${out.file_id}`; }).catch((e: Error) => setFailed(e.message)).finally(() => setMaking(null));
  };
  return (
    <section className="examples" data-testid="examples" aria-label={t('Examples')}>
      <div className="brands-head">
        <button type="button" className="examples-toggle" onClick={toggle} aria-expanded={open} data-testid="examples-toggle">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="brands-title">{t('Start from an example')}</span>
        </button>
        {failed ? <span className="examples-error" role="alert">{failed}</span> : null}
      </div>
      {open ? (
        <div className="example-list" role="list">
          {examples.map((ex) => (
            <button key={ex.id} type="button" role="listitem" className="example-row" onClick={() => make(ex)} disabled={making !== null} title={ex.description} data-testid="example" data-example-id={ex.id}>
              <span className="brand-swatches" aria-hidden="true">{ex.colors.map((c) => <span key={c} style={{ background: c }} />)}</span>
              <span className="example-kind">{ex.kind}</span>
              <span className="example-name">{ex.brand}</span>
              <span className="brand-facts">{making === ex.id ? t('Making the file and its brand…') : `${[...new Set(ex.parts.map((p) => p.size.replace(/, hugs content| wide/g, '')))].join(', ')}. ${ex.fonts.filter((f) => !f.startsWith('ui-')).join(' and ')}.`}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
