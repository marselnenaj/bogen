import { describe, expect, it } from 'vitest';
import { checkPublishedSite, cleanPublishedPage, type SiteFileInput } from '../src/index.ts';

const enc = new TextEncoder();
const file = (path: string, body: string | Uint8Array): SiteFileInput => ({ path, bytes: typeof body === 'string' ? enc.encode(body) : body });

/** A PNG header of the given size and weight: enough for a size check. */
function png(width: number, height: number, bytes = 64): Uint8Array {
  const out = new Uint8Array(Math.max(bytes, 33));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}
const imageSize = (b: Uint8Array) => (b[0] === 0x89 ? { width: new DataView(b.buffer).getUint32(16), height: new DataView(b.buffer).getUint32(20) } : null);

describe('the head of a published page', () => {
  it('carries language, description, canonical, social picture and icon, escaped', () => {
    const page = cleanPublishedPage('<!doctype html><html><head></head><body><div>Hi</div></body></html>', {
      title: 'Night "trains"', stylesheet: 'index.css', url: () => null, layer: () => ({}),
      head: { lang: 'de-AT', dir: 'ltr', description: 'Sleep through <Europe>.', canonical: 'https://trains.example/', ogImage: 'assets/og.png', favicon: 'assets/icon.png' },
    });
    expect(page.html).toContain('<html lang="de-AT" dir="ltr">');
    expect(page.html).toContain('<meta name="description" content="Sleep through &lt;Europe&gt;.">');
    expect(page.html).toContain('<link rel="canonical" href="https://trains.example/">');
    expect(page.html).toContain('<meta property="og:image" content="https://trains.example/assets/og.png">');
    expect(page.html).toContain('<link rel="icon" href="assets/icon.png">');
    expect(page.html).toContain('og:title" content="Night &quot;trains&quot;"');
  });

  it('refuses what is no language tag or no web address', () => {
    const page = cleanPublishedPage('<!doctype html><html><head></head><body><div>Hi</div></body></html>', {
      title: 'T', stylesheet: 'index.css', url: () => null, layer: () => ({}),
      head: { lang: '"><script>', canonical: 'javascript:alert(1)' },
    });
    expect(page.html).toMatch(/^<!doctype html><html><head>/);
    expect(page.html).not.toMatch(/canonical|script/);
  });
});

describe('checkPublishedSite', () => {
  const head = (extra = '') => `<head><meta charset="utf-8"><title>Night trains across Europe</title>${extra}<link rel="stylesheet" href="index.css"></head>`;

  it('calls only real breakage an error, and the rest warnings', () => {
    const html = `<!doctype html><html>${head()}<body><a href="#pricing">Prices</a><a href="#top">Top</a><a href="about.html">About</a><a href="https://elsewhere.example/">Out</a><img src="assets/hero.png" class="s1"><img src="assets/gone.png"></body></html>`;
    const report = checkPublishedSite([file('index.html', html), file('index.css', '.s1{width:100%}'), file('assets/hero.png', png(1600, 900, 700 * 1024))], { imageSize });
    const errors = report.findings.filter((f) => f.level === 'error').map((f) => f.check).sort();
    expect(errors).toEqual(['anchor', 'image-missing', 'lang', 'link']);
    const warnings = report.findings.filter((f) => f.level === 'warning').map((f) => f.check).sort();
    expect(warnings).toEqual(['canonical', 'description', 'favicon', 'image-size', 'image-weight', 'og-image']);
    expect(report.ok).toBe(false);
    expect(report.pages[0]).toMatchObject({ file: 'index.html', lang: null, links: { internal: 1, anchors: 2, external: 1 }, images: 2 });
  });

  it('passes a page that has everything, and checks the social picture by its size', () => {
    const html = `<!doctype html><html lang="en">${head('<meta name="description" content="Sleeper trains from Vienna to eleven cities, with prices and timetables."><link rel="canonical" href="https://trains.example/"><link rel="icon" href="assets/icon.png"><meta property="og:image" content="https://trains.example/assets/og.png">')}<body><h1 id="top-of">Trains</h1><a href="#top-of">Up</a><a href="prices.html#night">Prices</a><img src="assets/hero.png" width="800" height="400"><img src="assets/b.png" class="s2"></body></html>`;
    const prices = `<!doctype html><html lang="en">${head('<meta name="description" content="What a compartment costs on each night train from Vienna, in euros.">')}<body><div id="night"></div></body></html>`;
    const report = checkPublishedSite([
      file('index.html', html), file('prices.html', prices), file('index.css', '.s2{aspect-ratio:16/9}'), file('assets/hero.png', png(800, 400)), file('assets/b.png', png(10, 10)),
      file('assets/icon.png', png(64, 64)), file('assets/og.png', png(600, 315)),
    ], { imageSize });
    expect(report.findings.filter((f) => f.page === 'index.html' && f.level !== 'note').map((f) => f.message)).toEqual([expect.stringMatching(/600x315/)]);
    expect(report.counts.errors).toBe(0);
  });

  it('finds an anchor missing on another page of the site', () => {
    const a = `<!doctype html><html lang="en">${head()}<body><a href="b.html#nope">B</a></body></html>`;
    const b = `<!doctype html><html lang="en">${head()}<body></body></html>`;
    const report = checkPublishedSite([file('index.html', a), file('b.html', b)]);
    expect(report.findings.find((f) => f.level === 'error')).toMatchObject({ check: 'anchor', path: 'b.html#nope' });
  });
});
