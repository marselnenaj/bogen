import '@fontsource-variable/source-sans-3/wght.css';
import '@fontsource-variable/archivo/wdth.css';
import './styles/app.css';
import './styles/craft.css';
import './styles/canvas-craft.css';
import './styles/canvas-sections.css';
import './styles/agent-loop.css';
import './styles/agent-collab.css';
import './styles/chat.css';
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
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './home/Home.tsx';
import { Editor } from './Editor.tsx';
import { Preview } from './preview/Preview.tsx';
import { LiveSitePage } from './live/LiveSite.tsx';
import { BrandPage } from './panels/BrandPanel.tsx';
import { startTheme } from './lib/theme.ts';
import { applyUiScale, followScreenScale } from './state/settings.ts';
import { installTooltips } from './ui/tooltip.ts';
import { installPhoneFlag, phoneOrigin, registerServiceWorker, usePhone } from './lib/phone.ts';
import { PhoneApp } from './phone/PhoneApp.tsx';
import { PhoneGate } from './phone/PhoneGate.tsx';
import { DesktopUpdateReady } from './panels/DesktopUpdateReady.tsx';
import { UpdateReady } from './phone/UpdateReady.tsx';
import { startLanguage } from './i18n/preference.ts';
import { lockDocumentLanguage } from './i18n/store.ts';

function subscribeHash(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

function App() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const phone = usePhone();
  const preview = /^#\/file\/([\w-]+)\/preview(?:\/([\w-]+))?/.exec(hash);
  if (preview) return <Preview key={preview[1]} fileId={preview[1]!} {...(preview[2] ? { artboardId: preview[2] } : {})} />;
  const file = /^#\/file\/([\w-]+)/.exec(hash)?.[1];
  const live = /^#\/live(?:\/([\w-]+))?/.exec(hash);
  if (live) return <LiveSitePage key={live[1] ?? 'start'} {...(live[1] ? { siteId: live[1] } : {})} />;
  const brand = /^#\/brand\/([\w-]+)/.exec(hash)?.[1];
  if (brand) return <BrandPage key={brand} brandId={brand} />;
  // A phone, or a touch screen on the phone listener such as an iPad, gets the layout made for touch.
  if (phone) return <PhoneApp hash={hash} />;
  return file ? <Editor key={file} fileId={file} /> : <Home />;
}

startTheme();
applyUiScale();
followScreenScale();
installTooltips();
installPhoneFlag();
registerServiceWorker();
const strict = import.meta.env.DEV;
// On the phone listener nothing loads before the phone is known to be paired; on the desktop nothing changes.
const app = phoneOrigin ? <PhoneGate><App /><UpdateReady /></PhoneGate> : <><App /><DesktopUpdateReady /></>;
// The full-screen preview is the design alone: the page keeps its own lang and direction there.
if (/^#\/file\/[\w-]+\/preview/.test(location.hash)) lockDocumentLanguage();
// The language's catalog is fetched before the first paint (a moment at most), so the interface does not start in
// English and switch; a slow one is shown when it arrives.
void startLanguage().finally(() => createRoot(document.getElementById('root')!).render(strict ? <StrictMode>{app}</StrictMode> : app));
