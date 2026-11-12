import { useEffect } from 'react';
import { Home } from '../home/Home.tsx';
import { flushQueued } from '../doc/phone-link.ts';
import { phoneOrigin, useReachable } from '../lib/phone.ts';
import { loadHosts } from './phone-api.ts';
import { Settings } from './Settings.tsx';
import { Ask } from './Ask.tsx';
import { startAskEvents } from './ask-state.ts';
import { Files } from './Files.tsx';
import { Inbox } from './Inbox.tsx';
import { PhoneFile } from './PhoneFile.tsx';
import { Review } from './Review.tsx';
import { useT } from '../i18n/react.ts';
import { usePhoneWorkspaceView } from './workspace-view.ts';
import { WorkspaceView } from './WorkspaceView.tsx';

type Tab = 'inbox' | 'files' | 'ask' | 'settings';

function Tabs({ active }: { active: Tab }) {
  const t = useT();
  const tab = (id: Tab, label: string, hash: string) => (
    <a href={hash} className={`phone-tab${active === id ? ' is-active' : ''}`} aria-current={active === id ? 'page' : undefined} data-testid={`phone-tab-${id}`}>{label}</a>
  );
  return (
    <nav className="phone-tabs" aria-label="Bogen">
      {tab('inbox', t('Inbox'), '#/inbox')}
      {tab('files', t('Files'), '#/files')}
      {tab('ask', t('Ask'), '#/ask')}
      {tab('settings', t('Settings'), '#/settings')}
    </nav>
  );
}

/**
 * The phone layout: Inbox, Files and Ask in tabs, a proposal to review, and a file to work in with tools made
 * for touch (PhoneFile). A device-local view choice reveals the full file browser and workspace, sharing the same
 * file session rather than trapping a paired device in quick review.
 */
export function PhoneApp({ hash }: { hash: string }) {
  const view = usePhoneWorkspaceView();
  useEffect(() => startAskEvents(), []);
  const reachable = useReachable();
  const openFile = /^#\/file\/([\w-]+)/.exec(hash)?.[1] ?? null;
  // Back in reach: changes made offline in files that are not open go to the computer, and the list of computers is fresh.
  useEffect(() => {
    if (!phoneOrigin || reachable !== true) return;
    void flushQueued(openFile);
    void loadHosts();
  }, [reachable, openFile]);
  useEffect(() => {
    document.documentElement.classList.add('phone-ui');
    return () => document.documentElement.classList.remove('phone-ui');
  }, []);

  const full = /^#\/file\/([\w-]+)\/edit/.exec(hash);
  const file = /^#\/file\/([\w-]+)(?:\/thread\/([\w-]+))?/.exec(hash);
  if (file) return <PhoneFile key={file[1]} fileId={file[1]!} forceFull={Boolean(full)} {...(file[2] ? { threadId: file[2] } : {})} />;
  const review = /^#\/review\/([\w-]+)\/([\w/-]+)/.exec(hash);
  if (review) return <div className="phone-screen"><Review fileId={review[1]!} proposalId={review[2]!} /></div>;

  const tab: Tab = hash.startsWith('#/files') ? 'files' : hash.startsWith('#/ask') ? 'ask' : hash.startsWith('#/settings') ? 'settings' : hash.startsWith('#/inbox') ? 'inbox' : view === 'full' ? 'files' : 'inbox';
  const askFile = /^#\/ask\/([\w-]+)/.exec(hash)?.[1];
  return (
    <div className={`phone-screen${tab === 'ask' ? ' is-dark' : ''}`}>
      {tab === 'inbox' ? <Inbox /> : tab === 'files' ? view === 'full' ? <div className="phone-workspace-home" data-testid="phone-full-home"><div className="phone-workspace-home-view"><WorkspaceView /></div><Home /></div> : <Files /> : tab === 'settings' ? <Settings /> : <Ask {...(askFile ? { fileId: askFile } : {})} />}
      <Tabs active={tab} />
    </div>
  );
}
