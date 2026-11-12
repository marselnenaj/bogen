import { codeFrameUrl, type CodeRef } from '@bogen/core';
import type { CodeBuilder, FrameResponse } from './code-build.ts';
import type { Renderer } from './render.ts';

/** The headless renderer's own origin, answered by interception like its other pages. */
const ORIGIN = 'http://bogen.render';
const MEASURE_TIMEOUT_MS = 15_000;

/** Answers a frame request that came to a URL such as `/api/code/<project>/frame?file=&name=`. */
export function frameFromUrl(builder: CodeBuilder, url: URL, etag?: string): Promise<FrameResponse> | null {
  const m = /^\/api\/code\/([a-z0-9]{8,64})\/frame$/.exec(url.pathname);
  if (!m) return null;
  return builder.frame(m[1]!, url.searchParams.get('file') ?? '', url.searchParams.get('name') ?? 'default', etag ? { etag } : {});
}

/** The size a component takes on its own, measured in headless Chromium, for a layer that should fit it. */
export async function measureCode(renderer: Renderer, builder: CodeBuilder, ref: CodeRef): Promise<{ width: number; height: number }> {
  const src = codeFrameUrl(ref).replace('/frame?', '/frame?measure=1&');
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe sandbox="allow-scripts" src="${src.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" style="border:0;width:1600px;height:1200px"></iframe></body></html>`;
  return renderer.withBrowser(async (browser) => {
    const page = await browser.newPage();
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        void (async () => {
          const url = new URL(req.url());
          if (url.origin !== ORIGIN) return req.abort('blockedbyclient');
          if (url.pathname === '/') return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
          const frame = await frameFromUrl(builder, url);
          if (!frame) return req.respond({ status: 404, body: '' });
          return req.respond({ status: frame.status, headers: frame.headers, contentType: frame.headers['Content-Type'], body: frame.body });
        })().catch(() => req.abort().catch(() => {}));
      });
      // Strings, not functions: tsx would put helpers into functions that run in the page.
      await page.evaluateOnNewDocument("window.__size = new Promise((resolve) => addEventListener('message', (e) => { if (e.data && e.data.bogenCode === 'ready') resolve({ width: e.data.width, height: e.data.height }); }))");
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: MEASURE_TIMEOUT_MS });
      const measured = await page.evaluate(`Promise.race([window.__size, new Promise((resolve) => setTimeout(() => resolve(null), ${MEASURE_TIMEOUT_MS}))])`) as { width: number; height: number } | null;
      if (!measured || !measured.width || !measured.height) throw new Error('The component did not render in time to be measured.');
      return { width: Math.min(4000, measured.width), height: Math.min(4000, measured.height) };
    } finally {
      await page.close().catch(() => {});
    }
  });
}
