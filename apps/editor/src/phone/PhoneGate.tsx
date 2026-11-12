import { useEffect, useState, type ReactNode } from 'react';
import { reconnectEvents } from '../lib/events.ts';
import { isStandalone, pairPhone, phonePairing, type PhonePairing } from '../lib/phone.ts';
import { useT } from '../i18n/react.ts';

/** `#/pair/ABCD-EFGH`, which the QR code of `bogen phone pair` carries. The fragment never reaches a server. */
function codeFromHash(): string {
  return /^#\/pair\/([A-Za-z0-9-]{4,12})$/.exec(location.hash)?.[1]?.toUpperCase() ?? '';
}

function PairScreen({ onPaired }: { onPaired: () => void }) {
  const t = useT();
  const fromLink = codeFromHash();
  const installed = isStandalone();
  const [code, setCode] = useState(installed ? fromLink : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (value: string) => {
    setBusy(true);
    setError('');
    const result = await pairPhone(value);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    if (location.hash.startsWith('#/pair/')) history.replaceState(null, '', '/');
    // The socket was refused before the cookie existed, and waits longer after each refusal.
    reconnectEvents();
    onPaired();
  };

  // In Safari with the code from the QR: the app on the Home Screen has storage of its own, so pairing here
  // would pair Safari only. Show the code to type there, and offer Safari as the second choice.
  if (fromLink && !installed) {
    return (
      <main className="pair" data-testid="pair-install">
        <h1>{t('Add Bogen to your Home Screen')}</h1>
        <ol>
          <li>{t.rich('Tap Share {hint}, then {homeScreen}, then {add}.', { hint: <span aria-hidden="true">{t('(the square with the arrow)')}</span>, homeScreen: <b>{t('Add to Home Screen')}</b>, add: <b>{t('Add')}</b> })}</li>
          <li>{t('Open Bogen from your Home Screen.')}</li>
          <li>{t('Type this code there:')}</li>
        </ol>
        <p className="pair-code" data-testid="pair-code">{fromLink}</p>
        <p className="pair-hint">{t('It works once, for ten minutes.')}</p>
        <button type="button" className="pair-secondary" disabled={busy} onClick={() => void submit(fromLink)}>{t('Use Bogen in Safari instead')}</button>
        {error ? <p className="pair-error" role="alert">{error}</p> : null}
      </main>
    );
  }

  return (
    <main className="pair" data-testid="pair">
      <h1>{/iPad/.test(navigator.userAgent) ? t('Pair this iPad') : t('Pair this phone')}</h1>
      <p>{t.rich('On your computer, run {command}, or open the Agents tab of Bogen there and choose {pair}. Then type the code here.', { command: <code>bogen phone pair</code>, pair: <b>{t('Pair a phone')}</b> })}</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(code); }}>
        <label htmlFor="pair-code">{t('Pairing code')}</label>
        <input
          id="pair-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH"
          autoComplete="one-time-code" autoCapitalize="characters" autoCorrect="off" spellCheck={false} inputMode="text" maxLength={12} data-testid="pair-input"
        />
        <button type="submit" disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length !== 8} data-testid="pair-submit">{busy ? t('Pairing') : t('Pair')}</button>
      </form>
      {error ? <p className="pair-error" role="alert" data-testid="pair-error">{error}</p> : null}
    </main>
  );
}

/**
 * On the phone listener, the app waits for the answer to "is this phone paired?". Offline it cannot ask, and
 * shows what the phone kept; a removed phone finds out when it is back online.
 */
export function PhoneGate({ children }: { children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<PhonePairing | null>(null);
  const check = () => void phonePairing().then(setState);
  useEffect(() => {
    check();
    // Back online, or back to the front: the pairing may have been removed meanwhile.
    const again = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', again);
    };
  }, []);
  if (!state) return <div className="loading"><span>{t('Connecting to your computer')}</span></div>;
  if ('paired' in state && !state.paired) return <PairScreen onPaired={check} />;
  return <>{children}</>;
}
