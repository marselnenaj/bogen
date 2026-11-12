/**
 * Pages to calibrate the brand score against the Tomacco brand in `tomacco-brand.bogen`: work that is on brand and
 * well made, on brand but flat, a careless agent run, and work that ignores the brand. Prices are placeholders.
 */

const plans = [
  { name: 'Solo', price: '0', note: 'One machine, Android only.' },
  { name: 'Studio', price: '12', note: 'Android and the virtual iPhone.' },
  { name: 'Team', price: '40', note: 'Shared devices for a whole team.' },
];

/** On brand and well made: tokens, the type scale with a clear hierarchy, a spacing rhythm, red as the accent band. */
export function good(fluid = false): string {
  const gutter = fluid ? 'clamp(16px, 3vw, 48px)' : 'var(--space-40)';
  const section = fluid ? 'clamp(88px, 13vw, 220px)' : 'var(--space-188)';
  const display = fluid ? '9.4vw' : 'var(--text-display)';
  const card = (p: typeof plans[number], accent: boolean) => `
    <div style="display:flex;flex-direction:column;gap:var(--space-24);padding:var(--space-40);background:${accent ? 'var(--red)' : 'var(--ink)'};color:${accent ? 'var(--ink)' : 'var(--paper)'};flex:1">
      <h3 style="font-family:var(--font-sans);font-size:var(--text-subtitle);font-weight:800;margin:0">${p.name}</h3>
      <p style="font-family:var(--font-sans);font-size:var(--text-title);font-weight:900;margin:0">$${p.price}</p>
      <p style="font-family:var(--font-sans);font-size:var(--text-body);margin:0">${p.note}</p>
      <p style="font-family:var(--font-mono);font-size:var(--text-code);font-weight:500;margin:0">tomacco install</p>
    </div>`;
  return `<section style="display:flex;flex-direction:column;background:var(--ink);color:var(--paper)">
  <header style="display:flex;align-items:center;gap:var(--space-12);padding:var(--space-12) ${gutter}">
    <p style="font-family:var(--font-mono);font-size:var(--text-code);font-weight:500;color:var(--dim);margin:0">tomacco.dev / pricing</p>
  </header>
  <div style="display:flex;flex-direction:column;gap:var(--space-24);padding:${section} ${gutter}">
    <h1 style="font-family:var(--font-sans);font-size:${display};font-weight:900;line-height:0.94;margin:0">Pricing.</h1>
    <p style="font-family:var(--font-sans);font-size:var(--text-lead);max-width:800px;margin:0">Give your agent a phone. Pay for the devices it needs, nothing else.</p>
  </div>
  <div style="display:flex;gap:var(--space-8);padding:0 ${gutter} var(--space-88)">${plans.map((p, i) => card(p, i === 1)).join('')}</div>
  <div style="display:flex;flex-direction:column;gap:var(--space-12);padding:var(--space-88) ${gutter};background:var(--paper);color:var(--ink)">
    <h2 style="font-family:var(--font-sans);font-size:var(--text-title);font-weight:900;margin:0">Questions</h2>
    <p style="font-family:var(--font-sans);font-size:var(--text-body);color:var(--dim-paper);margin:0">Does it need a Mac? No. It runs on Linux.</p>
    <p style="font-family:var(--font-sans);font-size:var(--text-body);color:var(--dim-paper);margin:0">Can I cancel? Yes, any time.</p>
    <p style="font-family:var(--font-sans);font-size:var(--text-small);color:var(--dim-paper);margin:0">Prices are placeholders.</p>
  </div>
  <div style="display:flex;padding:var(--space-48) ${gutter};background:var(--green);color:var(--ink)">
    <p style="font-family:var(--font-sans);font-size:var(--text-subtitle);font-weight:800;margin:0">Same idea. Less soil.</p>
  </div>
</section>`;
}

/** On brand in every value, and flat: one size, one gap, ink on paper, literal colours, no accent, no logo. */
export function mediocre(): string {
  const row = (text: string) => `<p style="font-family:Archivo;font-size:19px;color:#0e0e0c;margin:0">${text}</p>`;
  const card = (p: typeof plans[number]) => `<div style="display:flex;flex-direction:column;gap:24px;padding:24px;background:#f4f2ec">${row(p.name)}${row(`$${p.price} a month`)}${row(p.note)}</div>`;
  return `<section style="display:flex;flex-direction:column;gap:24px;padding:24px;background:#f4f2ec">
  ${row('Pricing')}
  ${row('Give your agent a phone. Pay for the devices it needs.')}
  <div style="display:flex;gap:24px">${plans.map(card).join('')}</div>
  ${row('Questions')}
  ${row('Does it need a Mac? No. It runs on Linux.')}
  ${row('Can I cancel? Yes, any time.')}
  ${row('Prices are placeholders.')}
</section>`;
}

/** A careless run: mostly brand colours and fonts, sizes and gaps by eye, a near-miss grey, one off-brand blue. */
export function careless(): string {
  const card = (p: typeof plans[number]) => `
    <div style="display:flex;flex-direction:column;gap:18px;padding:30px;background:#1a1a17;color:#f4f2ec;border-radius:10px">
      <h3 style="font-family:Archivo;font-size:28px;font-weight:700;margin:0">${p.name}</h3>
      <p style="font-family:Archivo;font-size:44px;font-weight:900;margin:0">$${p.price}</p>
      <p style="font-family:Archivo;font-size:17px;color:#a8a69c;margin:0">${p.note}</p>
    </div>`;
  return `<section style="display:flex;flex-direction:column;gap:36px;padding:72px 60px;background:#0e0e0c;color:#f4f2ec">
  <h1 style="font-family:Archivo;font-size:72px;font-weight:900;margin:0">Simple pricing</h1>
  <p style="font-family:Archivo;font-size:21px;color:#a8a69c;margin:0">Give your agent a phone.</p>
  <div style="display:flex;gap:20px">${plans.map(card).join('')}</div>
  <p style="font-family:Archivo;font-size:17px;color:#3b82f6;margin:0">Compare all features</p>
</section>`;
}

/** Ignores the brand: other fonts and colours, gradients, shadows, round corners, sizes and gaps off any scale. */
export function offBrand(): string {
  const card = (p: typeof plans[number]) => `
    <div style="display:flex;flex-direction:column;gap:13px;padding:27px;background:#ffffff;border-radius:18px;box-shadow:0 10px 30px rgba(20,40,120,.25)">
      <h3 style="font-family:Georgia;font-size:26px;font-weight:600;color:#1e3a8a;margin:0">${p.name}</h3>
      <p style="font-family:Inter;font-size:52px;font-weight:300;color:#7c3aed;margin:0">$${p.price}</p>
      <p style="font-family:Inter;font-size:17px;color:#64748b;margin:0">${p.note}</p>
      <p style="font-family:Inter;font-size:15px;font-weight:600;color:#ffffff;background:linear-gradient(90deg,#6366f1,#ec4899);padding:11px 22px;border-radius:999px;margin:0">GET STARTED</p>
    </div>`;
  return `<section style="display:flex;flex-direction:column;gap:45px;padding:66px 54px;background:linear-gradient(135deg,#eef2ff,#fdf2f8)">
  <h1 style="font-family:Georgia;font-size:58px;font-weight:700;color:#0f172a;margin:0">Unlock seamless synergy</h1>
  <p style="font-family:Inter;font-size:21px;color:#475569;margin:0">Revolutionary mobile tooling for the modern developer.</p>
  <div style="display:flex;gap:31px">${plans.map(card).join('')}</div>
</section>`;
}
