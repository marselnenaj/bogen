/**
 * Two landing pages for the same invented product, for the craft checks. `GENERATED` reproduces the habits people
 * reject in agent-made work; `CONSIDERED` says the same with one message, one action, two families and a scale.
 */
export const CRAFT_TOKENS = [
  { name: 'text-sm', kind: 'font-size', value: '14px' },
  { name: 'text-base', kind: 'font-size', value: '17px' },
  { name: 'text-lg', kind: 'font-size', value: '22px' },
  { name: 'text-xl', kind: 'font-size', value: '32px' },
  { name: 'text-display', kind: 'font-size', value: '76px' },
  { name: 'ink', kind: 'color', value: '#16181d' },
  { name: 'paper', kind: 'color', value: '#ffffff' },
  { name: 'accent', kind: 'color', value: '#c2410c' },
] as const;

export const GENERATED = `
<section data-name="Hero" style="display:flex;flex-direction:column;align-items:center;gap:24px;padding:96px 48px;text-align:center;font-family:'Space Grotesk',sans-serif;background:linear-gradient(135deg,#4f46e5,#9333ea);background-color:#0b0b12">
  <p style="font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#c4b5fd">Introducing Ledgerline</p>
  <h1 style="font-size:72px;font-weight:700;color:#fff">Invoices. Payments. Done.</h1>
  <p style="font-size:18px;font-weight:600;color:#ddd6fe">The all in one platform for modern finance teams</p>
  <div data-name="Actions" style="display:flex;gap:12px">
    <a href="#start" style="background:#7c3aed;color:#fff;padding:12px 20px;border-radius:8px;font-weight:600;box-shadow:0 0 32px rgba(124,58,237,0.7)">Start free trial</a>
    <a href="#demo" style="background:#7c3aed;color:#fff;padding:12px 20px;border-radius:8px;font-weight:600">Book a demo</a>
  </div>
  <div data-name="Window" style="transform:rotate(-3deg);border:1px solid #312e81;border-radius:12px;box-shadow:0 0 60px rgba(99,102,241,0.6);padding:16px;background:#111827">
    <div data-name="Chrome" style="display:flex;gap:6px">
      <div style="width:12px;height:12px;border-radius:50%;background:#ef4444"></div>
      <div style="width:12px;height:12px;border-radius:50%;background:#f59e0b"></div>
      <div style="width:12px;height:12px;border-radius:50%;background:#22c55e"></div>
    </div>
    <p style="font-family:'JetBrains Mono',monospace;font-size:13px;color:#a5b4fc">Dashboard preview</p>
  </div>
</section>
<section data-name="Features" style="display:flex;flex-direction:column;align-items:center;gap:32px;padding:96px 48px;text-align:center;font-family:'Space Grotesk',sans-serif;background-color:#0b0b12;background-image:radial-gradient(#334155 1px,transparent 1px);background-size:24px 24px">
  <p style="font-family:'JetBrains Mono',monospace;font-size:12px;text-transform:uppercase;color:#c4b5fd">Features</p>
  <h2 style="font-size:68px;font-weight:700;color:#fff">Everything you need</h2>
  <div data-name="Cards" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">
    <div data-name="Card" style="border:1px solid #334155;border-radius:16px;padding:24px;box-shadow:0 0 24px rgba(124,58,237,0.4)">
      <div data-name="Inner" style="border:1px solid #334155;border-radius:12px;padding:16px"><h3 style="font-size:66px;font-weight:700;color:#fff">Fast</h3></div>
      <p style="font-size:15px;font-weight:600;color:#cbd5e1">Send an invoice in seconds</p>
    </div>
    <div data-name="Card" style="border:1px solid #334155;border-radius:16px;padding:24px">
      <div data-name="Inner" style="border:1px solid #334155;border-radius:12px;padding:16px"><h3 style="font-size:66px;font-weight:700;color:#fff">Safe</h3></div>
      <p style="font-size:15px;font-weight:600;color:#cbd5e1">Bank grade encryption for everyone</p>
    </div>
    <div data-name="Card" style="border:1px solid #334155;border-radius:16px;padding:24px">
      <div data-name="Inner" style="border:1px solid #334155;border-radius:12px;padding:16px"><h3 style="font-size:66px;font-weight:700;color:#fff">Smart</h3></div>
      <p style="font-size:15px;font-weight:600;color:#cbd5e1">Reminders that write themselves</p>
    </div>
  </div>
</section>
<section data-name="Photo" style="position:relative;padding:96px 48px;background-image:url(https://example.com/office.jpg);font-family:Georgia,serif">
  <p style="font-family:'JetBrains Mono',monospace;font-size:12px;text-transform:uppercase;color:#fff">Trusted worldwide</p>
  <h2 style="font-size:70px;font-weight:700;color:#fff">Loved by teams</h2>
</section>`;

export const CONSIDERED = `
<section data-name="Hero" style="display:grid;grid-template-columns:5fr 7fr;gap:64px;padding:104px 64px 64px;font-family:'Source Sans 3',sans-serif;color:var(--ink);background:var(--paper)">
  <div data-name="Claim" style="display:flex;flex-direction:column;gap:24px">
    <h1 style="font-size:var(--text-display);font-weight:650;line-height:1.02;letter-spacing:-0.02em">Send the invoice before you leave the site</h1>
    <p style="font-size:var(--text-lg);line-height:1.45;max-width:38ch">Ledgerline turns a finished job sheet into an invoice your customer can pay from their phone.</p>
    <div data-name="Actions" style="display:flex;align-items:center;gap:24px">
      <a href="#start" style="background:var(--accent);color:#fff;padding:14px 22px;border-radius:6px;font-size:var(--text-base);font-weight:600">Send a test invoice</a>
      <a href="#how" style="font-size:var(--text-base);color:var(--ink)">See how it works</a>
    </div>
  </div>
  <img data-name="Job sheet to invoice" alt="A job sheet on a phone next to the invoice made from it" src="https://example.com/invoice.png" style="width:100%;border-radius:8px">
</section>
<section data-name="How it works" style="display:flex;flex-direction:column;gap:40px;padding:64px;font-family:'Source Sans 3',sans-serif;color:var(--ink);background:var(--paper)">
  <h2 style="font-size:var(--text-xl);font-weight:650">From job sheet to paid, in three steps</h2>
  <ol data-name="Steps" style="display:grid;grid-template-columns:repeat(3,1fr);gap:40px;padding:0;list-style:none">
    <li style="display:flex;flex-direction:column;gap:8px"><h3 style="font-size:var(--text-lg);font-weight:600">Photograph the job sheet</h3><p style="font-size:var(--text-base);line-height:1.5">Ledgerline reads the line items and the customer from the photo.</p></li>
    <li style="display:flex;flex-direction:column;gap:8px"><h3 style="font-size:var(--text-lg);font-weight:600">Check the total</h3><p style="font-size:var(--text-base);line-height:1.5">Change a price or add travel time before anything is sent.</p></li>
    <li style="display:flex;flex-direction:column;gap:8px"><h3 style="font-size:var(--text-lg);font-weight:600">Send the pay link</h3><p style="font-size:var(--text-base);line-height:1.5">Your customer pays by card or bank transfer from the message.</p></li>
  </ol>
</section>
<section data-name="Photo" style="position:relative;padding:104px 64px;background-image:linear-gradient(rgba(22,24,29,0.72),rgba(22,24,29,0.72)),url(https://example.com/van.jpg);font-family:'Source Sans 3',sans-serif">
  <h2 style="font-size:var(--text-xl);font-weight:650;color:#fff;max-width:20ch">Made for people who invoice from a van, not a desk</h2>
  <pre style="font-family:'Source Code Pro',monospace;font-size:var(--text-sm);color:#fff">curl https://api.ledgerline.example/v1/invoices</pre>
</section>`;
