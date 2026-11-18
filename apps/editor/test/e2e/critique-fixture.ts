/**
 * A small flow to review and a stand-in for Claude Code that answers like a reviewer, for the critique e2e and its
 * captures. Nothing leaves the machine: the stand-in reads the brief, waits, streams a few events and answers.
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importHtml, type BogenDoc, type NewNode } from '@bogen/core';

const SCREENS: { name: string; body: string }[] = [
  { name: 'Menu', body: `
    <p style="margin:0;font-size:13px;color:#6b665c">Teahouse Kiri · Vienna 7</p>
    <h1 style="margin:8px 0 18px;font-size:34px;line-height:1.05;letter-spacing:-0.02em">Today's teas</h1>
    ${['Sencha Asahi|Kagoshima, first flush|€6.40', 'Hojicha|Kyoto, roasted stems|€5.20', 'Gyokuro Yame|Fukuoka, shaded|€9.80', 'Genmaicha|Shizuoka, toasted rice|€4.90'].map((r) => {
      const [n, o, p] = r.split('|');
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid #d9d3c4"><div><p style="margin:0;font-size:17px;font-weight:600">${n}</p><p style="margin:2px 0 0;font-size:13px;color:#6b665c">${o}</p></div><p style="margin:0;font-size:15px">${p}</p></div>`;
    }).join('')}
    <div style="margin-top:auto;background:#24402f;color:#f4efe3;padding:16px;text-align:center;font-size:16px;font-weight:600">View cart · 2 teas</div>` },
  { name: 'Tea detail', body: `
    <div style="height:260px;background:linear-gradient(160deg,#7d9b62,#2f4a2c)"></div>
    <h1 style="margin:18px 0 6px;font-size:30px;line-height:1.1">Gyokuro Yame</h1>
    <p style="margin:0;font-size:15px;line-height:1.5;color:#4a463e">Shaded for three weeks before picking. Sweet, brothy, low in bitterness. Steep at 60 °C for two minutes.</p>
    <div style="display:flex;gap:8px;margin-top:18px">${['20 g', '50 g', '100 g'].map((g, i) => `<span style="padding:8px 14px;border:1px solid ${i === 1 ? '#24402f' : '#d9d3c4'};font-size:14px">${g}</span>`).join('')}</div>
    <div style="margin-top:auto;background:#24402f;color:#f4efe3;padding:16px;text-align:center;font-size:16px;font-weight:600">Add to cart · €9.80</div>` },
  { name: 'Cart', body: `
    <h1 style="margin:0 0 18px;font-size:30px">Your cart</h1>
    ${['Sencha Asahi · 50 g|€6.40', 'Gyokuro Yame · 50 g|€9.80'].map((r) => { const [n, p] = r.split('|'); return `<div style="display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #d9d3c4;font-size:16px"><span>${n}</span><span>${p}</span></div>`; }).join('')}
    <div style="display:flex;justify-content:space-between;padding:14px 0;font-size:16px;font-weight:600"><span>Total</span><span>€16.20</span></div>
    <div style="margin-top:auto;background:#24402f;color:#f4efe3;padding:16px;text-align:center;font-size:16px;font-weight:600">Go to checkout</div>` },
  { name: 'Checkout', body: `
    <h1 style="margin:0 0 18px;font-size:30px">Checkout</h1>
    ${['Name|Mira Hofbauer', 'Email|mira@kiri.at', 'Pick up|Today, 16:30'].map((r) => { const [l, v] = r.split('|'); return `<div style="padding:10px 0"><p style="margin:0;font-size:12px;color:#6b665c">${l}</p><p style="margin:4px 0 0;padding:10px;border:1px solid #d9d3c4;font-size:16px">${v}</p></div>`; }).join('')}
    <div style="margin-top:auto;background:#c0392b;color:#fff;padding:16px;text-align:center;font-size:16px;font-weight:600">Pay now €16.20</div>` },
  { name: 'Paying', body: `
    <h1 style="margin:0 0 8px;font-size:30px">Payment failed</h1>
    <p style="margin:0;font-size:15px;color:#4a463e">One moment, we are confirming your payment with the bank.</p>
    <div style="margin:40px auto;width:64px;height:64px;border-radius:50%;border:4px solid #d9d3c4;border-top-color:#24402f"></div>
    <div style="margin-top:auto;background:#24402f;color:#f4efe3;padding:16px;text-align:center;font-size:16px;font-weight:600">Cancel</div>` },
  { name: 'Order placed', body: `
    <h1 style="margin:0 0 8px;font-size:34px;line-height:1.05">Thank you, Mira</h1>
    <p style="margin:0;font-size:15px;line-height:1.5;color:#4a463e">Your teas are ready at 16:30. We will keep them warm on the counter by the window.</p>
    <div style="margin-top:24px;padding:16px;background:#ebe5d6;font-size:15px">Order K-2041 · 2 teas · €16.20</div>
    <div style="margin-top:auto;border:1px solid #24402f;color:#24402f;padding:16px;text-align:center;font-size:16px;font-weight:600">Back to the menu</div>` },
];

/** Six phone screens of a tea shop's order flow, side by side. Returns their artboard ids in order. */
export function seedFlow(doc: BogenDoc, pageId: string): string[] {
  const ids: string[] = [];
  SCREENS.forEach((s, i) => {
    const board = doc.insert(pageId, {
      type: 'frame', name: s.name, artboard: true,
      style: { position: 'absolute', left: `${i * 470}px`, top: '0px', width: '390px', height: '780px', display: 'flex', flexDirection: 'column', padding: '28px 22px 26px', background: '#f4efe3', color: '#1f1d19', fontFamily: 'Archivo, sans-serif', boxSizing: 'border-box' },
    });
    doc.insertMany(board, importHtml(s.body).nodes as NewNode[]);
    ids.push(board);
  });
  doc.invalidate();
  return ids;
}

/** What the stand-in reviewer answers: a review of the six screens above. */
export const REVIEW = {
  score: 7.4,
  dimensions: { state: 6, consistency: 7, hierarchy: 8, copy: 7, layout: 8, brand: 8 },
  verdict: 'A calm, well-set order flow with a clear voice and a real sense of place. Two states contradict what they show, and the pay button breaks the colour the flow taught.',
  defects: [
    { screens: [5], kind: 'state', title: 'The paying screen says the payment failed', evidence: 'The title reads "Payment failed" while the line under it says "we are confirming your payment" and a spinner turns.', quote: 'Payment failed', fix: 'Title it "Confirming your payment" and keep "Payment failed" for the error state.' },
    { screens: [4], kind: 'colour', title: 'Pay now is red, the alarm colour', evidence: 'Every primary action is deep green (#24402f); only "Pay now €16.20" is red (#c0392b), which reads as danger on a calm step.', quote: 'Pay now €16.20', fix: 'Use the green of the other primary actions.' },
    { screens: [1, 3], kind: 'naming', title: 'The cart has two names', evidence: 'The menu says "View cart · 2 teas", the cart screen is titled "Your cart" but the detail screen adds to "cart" in lower case while checkout calls it nothing.', quote: 'View cart · 2 teas', fix: 'Pick "Cart" and use it on every screen.' },
  ],
  taste: [
    { title: 'The detail photo is a gradient', detail: 'A real photograph of the leaves or the cup would carry the shop. The gradient reads as a placeholder.', screens: [2] },
    { title: 'Sizes need a selected state that is more than a border', detail: 'The 50 g choice is only a darker border. A filled chip would read at a glance.', screens: [2] },
    { title: 'The thank-you could say where', detail: '"By the window" is lovely; add the address line so the pick-up is complete.', screens: [6] },
    { title: 'Prices could align on a column', detail: 'Menu prices sit at the right edge but cart prices use another width. One column would make the money easy to scan.', screens: [1, 3] },
  ],
  keep: ['The voice: "We will keep them warm on the counter by the window."', 'One green for every primary action (once Pay now follows it).', 'The quiet origin lines under each tea.'],
};

/** The next round, after a fix: no defect left, and each finding the maker took on checked. */
export const REVIEW_2 = {
  ...REVIEW,
  score: 9.2,
  dimensions: { state: 9, consistency: 9, hierarchy: 9, copy: 9, layout: 9, brand: 9 },
  verdict: 'The states now say what they show and every primary action is the same green. A calm flow a studio would ship.',
  defects: [],
  rechecked: REVIEW.defects.map((d) => ({ title: d.title, fixed: true })),
};

/**
 * A stand-in for `claude` at `bin/claude`, for both jobs it has here. As the reviewer (given the studio brief) it
 * waits the time in `reviewDelay`, streams a thinking block, then its answer as text, like `--output-format
 * stream-json --include-partial-messages`, then the result: REVIEW, or REVIEW_2 when the brief lists findings a
 * fix took on. As the agent of a fix run it waits `fixDelay`, retitles the first layer the brief names over the
 * file's MCP server, and finishes.
 */
export function fakeClaude(bin: string, opts: { reviewDelay: string; fixDelay: string; log?: string }): string {
  const path = join(bin, 'claude');
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.9.0 (Claude Code)'); process.exit(0); }
if (args[0] === '--help' || args[0] === 'debug') { console.log(args[0] === 'debug' ? '{"models":[]}' : ''); process.exit(0); }
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const delay = (file, d) => { try { return Number(fs.readFileSync(file, 'utf8')) || d; } catch { return d; } };
const input = fs.readFileSync(0, 'utf8');
${opts.log ? `fs.appendFileSync(${JSON.stringify(opts.log)}, JSON.stringify({ args, input: input.slice(0, 60000) }) + '\\n');` : ''}
if (args.includes('--system-prompt') || /You are a senior product and brand designer/.test(input)) {
  const wait = delay(${JSON.stringify(opts.reviewDelay)}, 4000);
  const second = /fix run took these findings on/.test(input);
  const answer = JSON.stringify(second ? ${JSON.stringify(REVIEW_2)} : ${JSON.stringify(REVIEW)});
  say({ type: 'system', subtype: 'init', model: args[args.indexOf('--model') + 1] });
  say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  setTimeout(() => {
    say({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
    const parts = answer.match(/[\\s\\S]{1,90}/g);
    let i = 0;
    const tick = setInterval(() => {
      if (i < parts.length) { say({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: parts[i++] } } }); return; }
      clearInterval(tick);
      say({ type: 'result', subtype: 'success', is_error: false, result: answer, usage: { input_tokens: 9000, output_tokens: 1400 }, total_cost_usd: 0 });
      process.exit(0);
    }, Math.max(30, Math.floor(wait * 0.3 / parts.length)));
  }, Math.floor(wait * 0.7));
} else {
  const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.bogen;
  const rpc = async (session, id, method, params) => {
    const res = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
    return { session: res.headers.get('mcp-session-id'), body: id ? await res.json() : null };
  };
  (async () => {
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixing the findings.' }] } });
    await new Promise((r) => setTimeout(r, delay(${JSON.stringify(opts.fixDelay)}, 1500)));
    const layer = /layer (\\w+)\\./.exec(input + ' ' + args.join(' '));
    if (layer) {
      const { session } = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
      await rpc(session, null, 'notifications/initialized', {});
      say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bogen__layer_text', input: { node_id: layer[1] } }] } });
      await rpc(session, 2, 'tools/call', { name: 'layer_text', arguments: { node_id: layer[1], text: 'Confirming your payment' } });
    }
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Retitled the paying screen; the pay button and the cart name follow the flow.' }] } });
    say({ type: 'result', is_error: false });
  })();
}
`);
  chmodSync(path, 0o755);
  return path;
}
