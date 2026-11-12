import { describe, expect, it } from 'vitest';
import { ASSET_CACHE, precacheFiles, SHELL_PREFIX, staleCaches, strategy } from '../src/pwa/sw-rules.ts';

const ORIGIN = 'https://omarchy.tail123456.ts.net:29443';
const shell = new Set(['/index.html', '/static/index-abc123.js', '/static/index-def456.css', '/manifest.webmanifest', '/icons/icon-192.png']);
const get = (path: string, mode = 'cors') => ({ method: 'GET', url: `${ORIGIN}${path}`, mode });
const ASSET = `/assets/${'a'.repeat(64)}.png`;

describe('service worker rules', () => {
  it('never answers the API or the sockets from a cache', () => {
    for (const path of ['/api/files', '/api/files/abc/thumbnail', '/api/phone/me', '/sync/abc', '/events', '/mcp', '/live-mcp/x', '/peer']) {
      expect(strategy(get(path), ORIGIN, shell), path).toBe('network');
      expect(strategy(get(path, 'navigate'), ORIGIN, shell), path).toBe('network');
    }
    expect(strategy({ method: 'POST', url: `${ORIGIN}/api/files` }, ORIGIN, shell)).toBe('network');
  });

  it('serves the hashed shell of this build, and loads pages from the network first', () => {
    expect(strategy(get('/static/index-abc123.js'), ORIGIN, shell)).toBe('shell');
    expect(strategy(get('/manifest.webmanifest'), ORIGIN, shell)).toBe('shell');
    // A file of another build is not in this list, so it goes to the network.
    expect(strategy(get('/static/index-old999.js'), ORIGIN, shell)).toBe('network');
    expect(strategy(get('/', 'navigate'), ORIGIN, shell)).toBe('navigate');
    expect(strategy(get('/#/file/abc', 'navigate'), ORIGIN, shell)).toBe('navigate');
    // The worker itself always comes from the server, which is how a new build is found.
    expect(strategy(get('/sw.js'), ORIGIN, shell)).toBe('network');
  });

  it('serves kept design assets from their cache, and leaves other origins alone', () => {
    expect(strategy(get(ASSET), ORIGIN, shell)).toBe('asset');
    expect(strategy(get(`${ASSET}?download=1`), ORIGIN, shell)).toBe('network');
    expect(strategy(get('/assets/not-a-hash.png'), ORIGIN, shell)).toBe('network');
    expect(strategy({ method: 'GET', url: 'https://fonts.googleapis.com/css2?family=Inter', mode: 'cors' }, ORIGIN, shell)).toBe('network');
    expect(strategy({ method: 'GET', url: `https://omarchy.tail123456.ts.net:8443/static/index-abc123.js` }, ORIGIN, shell)).toBe('network');
  });

  it('keeps a language catalog once the phone used it, instead of every catalog with each build', () => {
    expect(strategy(get('/static/locale-de-Ab12Cd34.js'), ORIGIN, shell)).toBe('catalog');
    expect(strategy(get('/static/locale-pt-BR-Ab12Cd34.js'), ORIGIN, shell)).toBe('catalog');
    expect(strategy(get('/static/locale-de-Ab12Cd34.js?x=1'), ORIGIN, shell)).toBe('network');
    expect(strategy(get('/static/locale-de.json'), ORIGIN, shell)).toBe('network');
    expect(strategy({ method: 'GET', url: 'https://elsewhere.example/static/locale-de-Ab12Cd34.js' }, ORIGIN, shell)).toBe('network');
  });

  it('installs without any language catalog', () => {
    const built = ['index.html', 'static/index-abc123.js', 'static/ChecksDialog-x1y2z3a4.js', ...['de', 'ar', 'pt-BR', 'zh-TW'].map((c) => `static/locale-${c}-Ab12Cd34.js`)];
    expect(precacheFiles(built)).toEqual(['index.html', 'static/index-abc123.js', 'static/ChecksDialog-x1y2z3a4.js']);
  });

  it('deletes the shells of other builds and keeps the assets', () => {
    const current = `${SHELL_PREFIX}new`;
    expect(staleCaches([`${SHELL_PREFIX}old`, current, ASSET_CACHE, 'something-else'], current)).toEqual([`${SHELL_PREFIX}old`]);
  });
});
