import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { useT } from '../i18n/react.ts';
import { msg } from '../i18n/core.ts';
import { copyText } from '../ui/controls.tsx';
import { editor } from '../state/store.ts';
import { keyStorageTone, withEverywhere, type KeyStorage, type Transports } from './teams-state.ts';

/**
 * Teams (feature teams-1): make or join a team, invite people with a role, see members and their devices, remove
 * them, and choose which connections this device listens on. Shown only when the server reports the feature.
 */

type Role = 'owner' | 'admin' | 'edit' | 'comment' | 'view';
interface Device { ed: string; name: string; fingerprint: string; login?: string; via?: string; lastSeen?: number }
interface Member { person: string; name: string; role: Role; you: boolean; devices: Device[] }
interface Team { id: string; fingerprint: string; name: string; role: Role | null; members: Member[]; invites: { id: string; role: Role; expires: number; uses: number; used: number }[]; files: { id: string; name: string }[]; removed: { person: string; at: number; now: boolean }[] }
interface View { me: { person: string; name: string; holdsPersonKey: boolean; phraseConfirmed: boolean; keyStorage?: KeyStorage }; teams: Team[]; transports: Transports; urls: string[]; lanAddresses: string[] }

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/teams${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? text ?? `HTTP ${res.status}`);
  return data as T;
}

const ROLE_WORDS: Record<Role, string> = { owner: msg('Owner'), admin: msg('Admin'), edit: msg('Edit'), comment: msg('Comment'), view: msg('View') };
const ROLE_HINTS: Record<Exclude<Role, 'owner'>, string> = {
  admin: msg('Invites and removes people, adds files'),
  edit: msg('Changes designs and comments'),
  comment: msg('Leaves comments, changes nothing else'),
  view: msg('Sees the files, changes nothing'),
};

export function TeamsSection() {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [phrase, setPhrase] = useState<string[] | null>(null);
  const [typed, setTyped] = useState('');
  const [name, setName] = useState('');
  const [yourName, setYourName] = useState('');
  const [link, setLink] = useState('');
  const [invite, setInvite] = useState<{ team: string; link: string } | null>(null);
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const load = useCallback(() => call<View>('').then(setView, (e: Error) => setError(e.message)), []);
  useEffect(() => { void load(); void api.files().then((list) => setFiles(list.map((f) => ({ id: f.id, name: f.name }))), () => {}); }, [load]);
  const run = (p: Promise<unknown>) => p.then(() => { setError(''); return load(); }, (e: Error) => setError(e.message));

  if (!view) return <p className="settings-hint" role="status">{error || t('Loading teams')}</p>;
  const tr = view.transports;
  const setTransports = (next: Transports) => run(call('/connections', 'PUT', next));

  return <div className="teams-settings" data-testid="teams-settings">
    {error ? <p className="settings-hint teams-error" role="alert">{error}</p> : null}

    {phrase ? <section className="teams-phrase" aria-labelledby="teams-phrase-title" data-testid="teams-phrase">
      <h3 id="teams-phrase-title">{t('Your recovery phrase')}</h3>
      <p className="settings-hint">{t('Write these 12 words down and keep them away from this computer. They give back your identity if every device is lost. Owners need them before they can invite anyone.')}</p>
      <ol className="teams-words">{phrase.map((w, i) => <li key={i}>{w}</li>)}</ol>
      <label className="settings-name" htmlFor="teams-phrase-check">{t('Type the 12 words to confirm')}</label>
      <textarea id="teams-phrase-check" rows={2} value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="teams-phrase-check" />
      <button type="button" className="btn" onClick={() => void run(call('/phrase', 'POST', { words: Object.fromEntries(typed.trim().split(/\s+/).map((w, i) => [String(i), w])) }).then(() => { setPhrase(null); setTyped(''); }))}>{t('Confirm')}</button>
    </section> : null}

    {view.me.person && view.me.holdsPersonKey && !view.me.phraseConfirmed && !phrase ? <div className="settings-row" data-testid="teams-phrase-pending">
      <div className="settings-label"><div className="settings-name">{t('Your recovery phrase')}</div><p className="settings-hint">{t('Confirm your recovery phrase to invite people. It was shown when you made your first team.')}</p></div>
      <div className="settings-control"><button type="button" className="btn" data-testid="teams-phrase-again" onClick={() => {
        if (!window.confirm(t('Show your recovery phrase again? Anyone who sees the 12 words can act as you. Make sure nobody can see your screen.'))) return;
        void call<{ words: string[] | null }>('/phrase').then((r) => { if (r.words?.length) setPhrase(r.words); else setError(t('Your recovery phrase was confirmed and is no longer kept on this device.')); }, (e: Error) => setError(e.message));
      }}>{t('Show recovery phrase again')}</button></div>
    </div> : null}
    {view.me.person && view.me.holdsPersonKey ? <div className="settings-row" data-testid="teams-key-storage">
      <div className="settings-label"><div className="settings-name">{t('Where your key is kept')}</div>
        <p className={keyStorageTone(view.me.keyStorage) === 'ok' ? 'settings-hint' : 'settings-hint teams-warning'} role={keyStorageTone(view.me.keyStorage) === 'ok' ? undefined : 'alert'}>{
          view.me.keyStorage === 'keyring' ? t('In the system keyring. The file on disk holds it only encrypted.')
            : view.me.keyStorage === 'locked' ? t('Locked: the system keyring did not give the key back. Unlock your keyring and restart Bogen.')
              : t('In a file on this computer, because no system keyring was found. Anyone who can read your files can act as you in your teams.')
        }</p>
        {view.me.phraseConfirmed ? <p className="settings-hint">{t('Your recovery phrase was confirmed and is no longer kept on this device.')}</p> : null}
      </div>
    </div> : null}

    <div className="settings-row"><div className="settings-label"><div className="settings-name">{t('Make a team')}</div><p className="settings-hint">{t('No accounts: your Bogen makes its own keys. You are the owner.')}</p></div>
      <div className="settings-control teams-form">
        <input aria-label={t('Team name')} placeholder={t('Team name')} value={name} onChange={(e) => setName(e.target.value)} data-testid="teams-name" />
        {!view.me.person ? <input aria-label={t('Your name')} placeholder={t('Your name')} value={yourName} onChange={(e) => setYourName(e.target.value)} /> : null}
        <button type="button" className="btn" disabled={!name.trim()} onClick={() => void call<{ phrase: string[] | null }>('', 'POST', { name, yourName: yourName || view.me.name || 'Me' }).then((r) => { setName(''); if (r.phrase) setPhrase(r.phrase); return load(); }, (e: Error) => setError(e.message))} data-testid="teams-create">{t('Make team')}</button>
      </div>
    </div>

    <div className="settings-row"><div className="settings-label"><div className="settings-name">{t('Join with an invite')}</div><p className="settings-hint">{t('Paste the link someone sent you. Compare the six safety words with them.')}</p></div>
      <div className="settings-control teams-form">
        <input aria-label={t('Invite link')} placeholder="bogen://join/..." value={link} onChange={(e) => setLink(e.target.value)} data-testid="teams-link" />
        {!view.me.person ? <input aria-label={t('Your name')} placeholder={t('Your name')} value={yourName} onChange={(e) => setYourName(e.target.value)} /> : null}
        <button type="button" className="btn" disabled={!link.trim()} onClick={() => void call<{ phrase: string[] | null }>('/join', 'POST', { link, yourName: yourName || view.me.name || 'Me' }).then((r) => { setLink(''); if (r.phrase) setPhrase(r.phrase); return load(); }, (e: Error) => setError(e.message))}>{t('Join')}</button>
      </div>
    </div>

    {view.teams.map((team) => {
      const admin = team.role === 'owner' || team.role === 'admin';
      return <section key={team.id} className="teams-team" aria-label={team.name} data-testid="teams-team">
        <h3 className="teams-title">{team.name} <span className="settings-hint" translate="no">{team.fingerprint}</span></h3>
        <ul className="teams-members">
          {team.members.map((m) => <li key={m.person} className="teams-member" data-testid="teams-member">
            <div className="teams-member-top">
              <span className="teams-member-name" translate="no">{m.name}{m.you ? ` (${t('you')})` : ''}</span>
              {admin && !m.you && m.role !== 'owner'
                ? <select aria-label={t('Role of {name}', { name: m.name })} value={m.role} onChange={(e) => void run(call(`/${team.fingerprint}/members/${m.person}/role`, 'POST', { role: e.target.value }))}>
                    {(['admin', 'edit', 'comment', 'view'] as const).map((r) => <option key={r} value={r}>{t(ROLE_WORDS[r])}</option>)}
                  </select>
                : <span className="teams-role">{t(ROLE_WORDS[m.role])}</span>}
            </div>
            <div className="teams-devices">{m.devices.map((d) => <span key={d.ed} className="teams-device" title={d.fingerprint}>{d.name}{d.via ? ` · ${d.via}` : ''}{d.login ? ` · ${d.login}` : ''}</span>)}</div>
            {admin && !m.you && m.role !== 'owner' ? <div className="teams-member-actions">
              <button type="button" className="btn btn-quiet" onClick={() => { if (window.confirm(t('Remove {name}? Their edits from before the removal still land for 7 days.', { name: m.name }))) void run(call(`/${team.fingerprint}/members/${m.person}/remove`, 'POST', { now: false })); }}>{t('Remove')}</button>
              <button type="button" className="btn btn-quiet" onClick={() => { if (window.confirm(t('Remove {name} now and refuse anything they send from here on?', { name: m.name }))) void run(call(`/${team.fingerprint}/members/${m.person}/remove`, 'POST', { now: true })); }}>{t('Remove now')}</button>
              <button type="button" className="btn btn-quiet" onClick={() => void call<{ words: string[] }>(`/${team.fingerprint}/members/${m.person}/safety`).then((r) => editor().showToast(t('Safety words: {words}', { words: r.words.join(' ') })), (e: Error) => setError(e.message))}>{t('Safety words')}</button>
            </div> : null}
          </li>)}
        </ul>
        {admin ? <div className="teams-invite">
          <InviteForm onMake={(role, days, uses) => call<{ link: string }>(`/${team.fingerprint}/invites`, 'POST', { role, days, uses }).then((r) => { setInvite({ team: team.id, link: r.link }); return load(); }, (e: Error) => setError(e.message))} />
          {invite?.team === team.id ? <div className="teams-link" data-testid="teams-invite-link"><code translate="no">{invite.link}</code><button type="button" className="btn" onClick={() => void copyText(invite.link).then(() => editor().showToast(t('Invite link copied')))}>{t('Copy')}</button></div> : null}
          {team.invites.length ? <p className="settings-hint">{t.n(team.invites.length, '{count} invite open', '{count} invites open')}</p> : null}
        </div> : null}
        <div className="teams-files">
          <div className="settings-name">{t('Files in this team')}</div>
          <ul>{team.files.map((f) => <li key={f.id} translate="no">{f.name}</li>)}</ul>
          {team.role && team.role !== 'view' && team.role !== 'comment' ? <select aria-label={t('Add a file to this team')} value="" onChange={(e) => { if (e.target.value) void run(call(`/${team.fingerprint}/files`, 'POST', { file: e.target.value })); }}>
            <option value="">{t('Add a file')}</option>
            {files.filter((f) => !view.teams.some((x) => x.files.some((y) => y.id === f.id))).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select> : null}
        </div>
      </section>;
    })}

    <section className="teams-connections" aria-labelledby="teams-connections-title">
      <h3 id="teams-connections-title">{t('Connections')}</h3>
      <p className="settings-hint">{t('Nothing listens until you turn a connection on. Everything between members is encrypted with TLS 1.3 and checked against the device keys in the team.')}</p>
      <label className="teams-toggle"><input type="checkbox" role="switch" checked={tr.lan.on} onChange={(e) => void setTransports({ ...tr, lan: { on: e.target.checked, address: tr.lan.address || view.lanAddresses[0] || '' } })} data-testid="teams-lan" />{t('Local network')}</label>
      {tr.lan.on && !tr.listenEverywhere ? <select aria-label={t('Address on the local network')} value={tr.lan.address} onChange={(e) => void setTransports({ ...tr, lan: { on: true, address: e.target.value } })}>{view.lanAddresses.map((a) => <option key={a} value={a}>{a}</option>)}</select> : null}
      <label className="teams-toggle"><input type="checkbox" role="switch" checked={tr.listenEverywhere === true} data-testid="teams-everywhere" onChange={(e) => {
        if (e.target.checked) {
          if (!window.confirm(t('Listen on every network of this device? Every network this computer joins (a café, a hotel, a guest network) can then reach the team connection. Members still need their keys, but strangers can try to connect. Pick one network instead unless you need this.'))) return;
          void setTransports(withEverywhere(tr, true, view.lanAddresses));
        } else void setTransports(withEverywhere(tr, false, view.lanAddresses));
      }} />{t('Listen on every network')}</label>
      {tr.listenEverywhere ? <p className="settings-hint teams-warning" role="alert">{t('Listening on every network of this device.')}</p> : null}
      <label className="teams-toggle"><input type="checkbox" role="switch" checked={tr.tailscale.on} onChange={(e) => void setTransports({ ...tr, tailscale: { on: e.target.checked } })} />Tailscale</label>
      <label className="teams-toggle"><input type="checkbox" role="switch" checked={tr.vpn.on} onChange={(e) => void setTransports({ ...tr, vpn: { on: e.target.checked, address: tr.vpn.address } })} />{t('Other VPN')}</label>
      {tr.vpn.on ? <input aria-label={t('This device\'s address in the VPN')} placeholder="10.8.0.2" defaultValue={tr.vpn.address} onBlur={(e) => void setTransports({ ...tr, vpn: { on: true, address: e.target.value.trim() } })} /> : null}
      <p className="settings-hint">{view.urls.length ? t('Reachable at {urls}', { urls: view.urls.join(', ') }) : t('Not reachable yet.')}</p>
      {view.me.holdsPersonKey ? <button type="button" className="btn btn-quiet" onClick={() => void call<{ added: number }>('/devices', 'POST').then((r) => { editor().showToast(t.n(r.added, 'Added {count} paired device to your teams', 'Added {count} paired devices to your teams')); return load(); }, (e: Error) => setError(e.message))}>{t('Add my paired devices')}</button> : null}
    </section>
  </div>;
}

function InviteForm({ onMake }: { onMake: (role: Exclude<Role, 'owner'>, days: number, uses: number) => void }) {
  const t = useT();
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('edit');
  const [days, setDays] = useState(7);
  const [uses, setUses] = useState(1);
  return <div className="teams-form" role="group" aria-label={t('Invite someone')}>
    <select aria-label={t('Role')} value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, 'owner'>)} title={t(ROLE_HINTS[role])}>
      {(['admin', 'edit', 'comment', 'view'] as const).map((r) => <option key={r} value={r}>{t(ROLE_WORDS[r])}</option>)}
    </select>
    <label>{t('Days')}<input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value) || 7)} /></label>
    <label>{t('Uses')}<input type="number" min={1} max={100} value={uses} onChange={(e) => setUses(Number(e.target.value) || 1)} /></label>
    <button type="button" className="btn" onClick={() => onMake(role, days, uses)} data-testid="teams-invite">{t('Make invite link')}</button>
    <p className="settings-hint">{t(ROLE_HINTS[role])}</p>
  </div>;
}
