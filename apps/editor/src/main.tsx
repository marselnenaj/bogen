import '@fontsource-variable/source-sans-3/wght.css';
import '@fontsource-variable/archivo/wdth.css';
import './styles/app.css';
import './styles/dialogs.css';
import './styles/craft.css';
import './styles/canvas-craft.css';
import './styles/canvas-sections.css';
import './styles/agent-loop.css';
import './styles/agent-collab.css';
import './styles/chat.css';
import './styles/call.css';
import './styles/brand.css';
import './styles/design-system.css';
import './styles/touch.css';
import './styles/phone.css';
import './styles/phone-ui.css';
import './styles/phone-file.css';
import './styles/chrome.css';
import './styles/i18n.css';
import './styles/settings.css';
import './styles/fonts.css';
import './styles/tabs.css';
import './styles/generate-image.css';
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { inertOutsideModals } from './ui/modal-inert.ts';
import { Home } from './home/Home.tsx';
import { Editor } from './Editor.tsx';
import { Preview } from './preview/Preview.tsx';
import { LiveSitePage } from './live/LiveSite.tsx';
import { BrandPage } from './panels/BrandPanel.tsx';
import { startTheme } from './lib/theme.ts';
import { applyUiScale, followScreenScale } from './state/settings.ts';
import { installTooltips } from './ui/tooltip.ts';
import { installPhoneFlag, phoneOrigin, registerServiceWorker, usePhone } from './lib/phone.ts';
import { fetchSpares } from './doc/team-writer.ts';
import { PhoneApp } from './phone/PhoneApp.tsx';
import { PhoneGate } from './phone/PhoneGate.tsx';
import { DesktopUpdateReady } from './panels/DesktopUpdateReady.tsx';
import { CallDock } from './call/CallBar.tsx';
import { startIncoming } from './call/incoming.ts';
import { UpdateReady } from './phone/UpdateReady.tsx';
import { startLanguage } from './i18n/preference.ts';
import { lockDocumentLanguage } from './i18n/store.ts';
import { TABPANEL_ID, TabStrip, tabDomId } from './tabs/TabStrip.tsx';
import { startTabs, useTabs } from './tabs/tabs-state.ts';
import { installTabKeys } from './tabs/tab-keys.ts';
import { FileWindow, startOneWindow } from './tabs/OneWindow.tsx';

function subscribeHash(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

function App() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const phone = usePhone();
  const tabs = useTabs((s) => s.tabs.length);
  const active = useTabs((s) => s.active);
  // Files open as tabs above Home and the editor, on a computer. The phone switches files its own way, and a
  // full-screen preview, a live site or a brand page are screens of their own. The shell is always there, so that
  // a screen does not mount anew when the strip comes or goes.
  const strip = !phone && tabs > 0 && !/^#\/(file\/[\w-]+\/preview|live|brand\/)/.test(hash);
  return (
    <div className="app-shell">
      {strip ? <TabStrip /> : null}
      <div className="app-tabpanel" {...(strip ? { role: 'tabpanel', id: TABPANEL_ID, 'aria-labelledby': tabDomId(active) } : {})}>
        <Screen hash={hash} phone={phone} />
      </div>
    </div>
  );
}

function Screen({ hash, phone }: { hash: string; phone: boolean }) {
  const preview = /^#\/file\/([\w-]+)\/preview(?:\/([\w-]+))?/.exec(hash);
  if (preview) return <Preview key={preview[1]} fileId={preview[1]!} {...(preview[2] ? { artboardId: preview[2] } : {})} />;
  const file = /^#\/file\/([\w-]+)/.exec(hash)?.[1];
  const live = /^#\/live(?:\/([\w-]+))?/.exec(hash);
  if (live) return <LiveSitePage key={live[1] ?? 'start'} {...(live[1] ? { siteId: live[1] } : {})} />;
  const brand = /^#\/brand\/([\w-]+)/.exec(hash)?.[1];
  if (brand) return <BrandPage key={brand} brandId={brand} section={/^#\/brand\/[\w-]+\/([\w-]+)/.exec(hash)?.[1]} />;
  // A phone, or a touch screen on the phone listener such as an iPad, gets the layout made for touch.
  // The Brands place is the same on a phone: the phone's own tabs have no place for brands.
  if (/^#\/brands\b/.test(hash)) return <Home place="brands" />;
  if (phone) return <PhoneApp hash={hash} />;
  return file ? <FileWindow key={file} fileId={file}><Editor fileId={file} /></FileWindow> : <Home place={/^#\/brands\b/.test(hash) ? 'brands' : 'files'} />;
}

startTheme();
startTabs();
if (!phoneOrigin) startOneWindow();
installTabKeys();
applyUiScale();
followScreenScale();
installTooltips();
installPhoneFlag();
registerServiceWorker();
const strict = import.meta.env.DEV;
// On the phone listener nothing loads before the phone is known to be paired; on the desktop nothing changes.
// The call bar sits above every route, so a call stays in view and in reach wherever the person goes.
const app = phoneOrigin ? <PhoneGate><App /><CallDock /><UpdateReady /></PhoneGate> : <><App /><CallDock /><DesktopUpdateReady /></>;
// The full-screen preview is the design alone: the page keeps its own lang and direction there.
if (/^#\/file\/[\w-]+\/preview/.test(location.hash)) lockDocumentLanguage();
// The language's catalog is fetched before the first paint (a moment at most), so the interface does not start in
// English and switch; a slow one is shown when it arrives.
inertOutsideModals();
// A writer id ahead of time for every team file (teams-1): one opened offline later can still be signed as yours.
void fetchSpares();
// Agents may ring the person when a run they asked for ends on a question (off until they turn it on).
if (!/^#\/file\/[\w-]+\/preview/.test(location.hash)) startIncoming();
void startLanguage().finally(() => createRoot(document.getElementById('root')!).render(strict ? <StrictMode>{app}</StrictMode> : app));
