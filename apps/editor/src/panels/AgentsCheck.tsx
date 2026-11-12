import { useEffect, useState } from 'react';
import { collabApi, type AgentsCheck, type CheckCase } from '../lib/collab-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

/** `asks` is filled with `quote`: the German words of the real request stay as they are. */
const CASE: Record<CheckCase['name'], { title: string; asks: string; quote?: string }> = {
  polite: { title: msg('Polite request'), asks: msg('{quote} changes the heading'), quote: '"kannst du die Überschrift größer machen?"' },
  question: { title: msg('Pure question'), asks: msg('asked for the button\'s label, it answers and changes nothing') },
  memory: { title: msg('Two-turn chat'), asks: msg('turn 2 says {quote} and means the paragraph from turn 1'), quote: '"ihn"' },
};

function verdict(c: CheckCase): string {
  if (c.name === 'polite') return c.ok ? (c.nudged ? t('Changed it (asked twice)') : t('Changed it')) : t('Did not change it');
  if (c.name === 'question') return c.ok ? t('Answered, changed nothing') : !c.answered ? t('Wrong answer') : t('Changed something');
  return c.ok ? t('Remembered') : t('Forgot');
}

/**
 * Check the agents: runs the person's real `claude` and `codex` on a throwaway file, in a throwaway server, with
 * the three requests that went wrong before. The same as `bogen agents check`.
 */
export function AgentsCheckSection() {
  const t = useT();
  const [check, setCheck] = useState<AgentsCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void collabApi.lastCheck().then(setCheck, () => {});
    load();
    return onServerEvent((e) => {
      if (e.t === 'agents-check') load();
    });
  }, []);
  const start = async () => {
    setError(null);
    try {
      setCheck(await collabApi.startCheck());
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const running = check?.status === 'running';
  return (
    <div className="section-plain agents-check" data-testid="agents-check">
      <div className="feed-title">{t('Check the agents')}</div>
      <p className="hint">{t.rich('Runs your real claude and codex on a throwaway file, apart from your files: a polite request, a question and a two-turn chat, on the cheap model comments use. About eight small runs on your plan, a few minutes. Same as {command}.', { command: <code>bogen agents check</code> })}</p>
      <button type="button" className="btn" disabled={running} onClick={() => void start()} data-testid="agents-check-start">{running ? t('Checking') : check ? t('Check again') : t('Check the agents')}</button>
      {error ? <div className="error">{error}</div> : null}
      {check?.error ? <div className="error">{check.error}</div> : null}
      {check?.runners.map((r) => (
        <div key={r.runner} className="check-runner" data-testid="agents-check-runner" data-runner={r.runner}>
          <div className="check-runner-head">{r.runner}{r.model ? ` · ${r.model}` : ''}{r.version ? ` · ${r.version}` : ''}</div>
          {r.error ? <div className="hint">{r.error}</div> : null}
          {(['polite', 'question', 'memory'] as const).map((name) => {
            const c = r.cases.find((x) => x.name === name);
            return (
              <div key={name} className={`check-case${c ? (c.ok ? ' is-ok' : ' is-bad') : ''}`} data-testid="agents-check-case" data-case={name} data-ok={c ? String(c.ok) : undefined} title={c?.reply ? t('Reply: {reply}', { reply: c.reply }) : t(CASE[name].asks, { quote: CASE[name].quote ?? '' })}>
                <span className="check-case-name">{t(CASE[name].title)}</span>
                <span className="check-case-verdict">{c ? t('{verdict} · {seconds} s', { verdict: verdict(c), seconds: c.seconds }) : r.available && running ? t('Running') : ''}</span>
                {c ? <span className="check-case-detail">{c.detail}{c.error ? ` ${c.error}` : ''}</span> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
