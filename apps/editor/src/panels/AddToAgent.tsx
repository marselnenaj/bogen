import { useEffect, useState } from 'react';
import { api, type AgentClient } from '../lib/api.ts';
import { useT } from '../i18n/react.ts';
import { msg } from '../i18n/core.ts';
import { formatList } from '../i18n/format.ts';

const TOOL_LISTS = { full: msg('Full tool list'), compact: msg('Short tool list'), grouped: msg('One tool per area') };

/**
 * Settings, Agents: the MCP clients `bogen setup` finds on this computer, whether Bogen is in each, and Connect, which
 * does what `bogen install <client>` does through the loopback API. Clients that are not here are named in one line.
 */
export function AddToAgent() {
  const t = useT();
  const [clients, setClients] = useState<AgentClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    api.clients().then((r) => { if (live) setClients(r.clients); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  const connect = (c: AgentClient) => {
    setBusy(c.client);
    setFailed(({ [c.client]: _, ...rest }) => rest);
    api.connectClient(c.client).then(({ client }) => {
      setClients((list) => list?.map((x) => (x.client === client.client ? client : x)) ?? null);
    }, (e: Error) => setFailed((f) => ({ ...f, [c.client]: e.message }))).finally(() => setBusy(null));
  };
  const here = clients?.filter((c) => c.found || c.connected) ?? [];
  const away = clients?.filter((c) => !c.found && !c.connected) ?? [];
  return (
    <section className="add-to-agent" data-testid="add-to-agent" aria-labelledby="add-to-agent-title">
      <h2 id="add-to-agent-title">{t('Add to agent')}</h2>
      <p className="settings-hint">{t('Puts Bogen in an agent\'s own settings, as {command} does, with the tool list that suits it. Start a new session in that agent afterwards.', { command: 'bogen install' })}</p>
      {error ? <p className="settings-hint" role="alert" dir="auto">{error}</p> : !clients ? <p className="settings-hint" role="status">{t('Reading…')}</p> : (
        <ul className="add-to-agent-list">
          {here.map((c) => {
            const problem = failed[c.client];
            const status = problem ?? (c.connected ? t('Connected') : c.connected === null ? t('Not known whether Bogen is in it') : t('Found, not connected'));
            return (
              <li key={c.client} className="add-to-agent-row" data-client={c.client} data-connected={c.connected ? 'yes' : 'no'}>
                <div className="add-to-agent-name"><strong>{c.label}</strong><span className={problem ? 'add-to-agent-problem' : 'settings-hint'} dir="auto" role={problem ? 'alert' : undefined}>{status}</span></div>
                <span className="settings-hint add-to-agent-tools">{t(TOOL_LISTS[c.tools])}</span>
                <button type="button" className={`btn ${c.connected && !problem ? 'btn-quiet' : 'btn-primary'}`} disabled={busy !== null} aria-busy={busy === c.client} onClick={() => connect(c)} data-testid={`add-to-agent-${c.client}`}>
                  {problem ? t('Try again') : c.connected ? t('Connect again') : t('Connect')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {away.length ? <p className="settings-hint">{t('Not on this computer: {agents}', { agents: formatList(away.map((c) => c.label)) })}</p> : null}
    </section>
  );
}
