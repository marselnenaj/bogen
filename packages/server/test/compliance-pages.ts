/** A page with one of each problem the compliance check can see, and the same page fixed. */
export const FLAWED = `
<header data-name="Header" style="display:flex;justify-content:space-between;padding:16px"><a href="/" style="display:block;padding:12px">Muster Shop</a><nav data-name="Nav" style="display:flex;gap:8px"><a href="/sale" style="display:block;padding:12px">Sale</a><a href="/cart" style="display:block;padding:12px">Warenkorb</a></nav></header>
<main data-name="Content" style="display:flex;flex-direction:column;gap:16px;padding:24px">
  <h1 data-name="Title">Bestellübersicht</h1>
  <p data-name="Price" style="font-size:18px">Laufschuh Pro 89,00 € statt 120,00 € -25% Rabatt</p>
  <p data-name="Urgency" style="font-size:16px">Nur noch heute: 3 Personen sehen sich das gerade an</p>
  <div data-name="Table" style="width:900px;display:flex;gap:16px"><span>Lieferung</span><span>Zahlungsart</span><span>Summe</span></div>
  <div data-name="Fixed box" style="height:22px;overflow:hidden;width:300px;font-size:16px;line-height:20px">Lieferung in zwei bis drei Werktagen</div>
  <label data-name="Email label" style="display:flex;flex-direction:column;gap:4px">E-Mail<input data-name="Email" type="email" required style="padding:8px;border:1px solid #eeeeee;background:#ffffff"></label>
  <input data-name="Name" placeholder="Ihr Name" style="padding:8px;border:1px solid #767676">
  <label data-name="Zip label" style="display:flex;flex-direction:column;gap:4px">Postleitzahl<input data-name="Zip" id="zip" aria-invalid="true" autocomplete="postal-code" style="padding:8px;border:1px solid #c00000"></label>
  <span data-name="Dup a" id="note">Hinweis</span><span data-name="Dup b" id="note">Hinweis</span>
  <button data-name="Order" style="padding:12px 20px;background:#7d8bff;color:#ffffff;border:0;font-size:16px">Weiter</button>
</main>
<footer data-name="Footer" style="padding:16px"><a href="/kontakt" style="display:block;padding:12px">Kontakt</a></footer>
<div data-name="Cookie banner" style="display:flex;gap:12px;padding:16px;background:#f4f2ec"><p style="font-size:16px">Wir verwenden Cookies für Statistik.</p><button data-name="Accept" style="padding:12px;background:#111111;color:#ffffff">Alle akzeptieren</button></div>`;

export const FIXED = `
<header data-name="Header" style="display:flex;flex-wrap:wrap;justify-content:space-between;padding:16px"><a href="/" style="display:block;padding:12px">Muster Shop</a><nav data-name="Nav" aria-label="Haupt" style="display:flex;flex-wrap:wrap;gap:8px"><a href="/sale" style="display:block;padding:12px">Sale</a><a href="/cart" style="display:block;padding:12px">Warenkorb</a></nav></header>
<div data-name="Content" style="display:flex;flex-direction:column;gap:16px;padding:24px">
  <h1 data-name="Title">Bestellübersicht</h1>
  <p data-name="Price" style="font-size:18px">Laufschuh Pro 89,00 € inkl. MwSt., zzgl. Versand</p>
  <div data-name="Table" style="max-width:900px;width:100%;display:flex;flex-wrap:wrap;gap:16px"><span>Lieferung</span><span>Zahlungsart</span><span>Summe</span></div>
  <div data-name="Box" style="max-width:300px;font-size:16px;line-height:20px">Lieferung in zwei bis drei Werktagen</div>
  <label data-name="Email label" style="display:flex;flex-direction:column;gap:4px">E-Mail (Pflichtfeld)<input data-name="Email" type="email" required autocomplete="email" style="padding:8px;border:1px solid #767676;background:#ffffff"></label>
  <label data-name="Name label" style="display:flex;flex-direction:column;gap:4px">Ihr Name<input data-name="Name" autocomplete="name" style="padding:8px;border:1px solid #767676"></label>
  <label data-name="Zip label" style="display:flex;flex-direction:column;gap:4px">Postleitzahl<input data-name="Zip" id="zip" aria-invalid="true" aria-describedby="zip-error" autocomplete="postal-code" style="padding:8px;border:2px solid #c00000"></label>
  <p data-name="Zip error" id="zip-error" style="color:#a00000;font-size:16px">Die Postleitzahl hat vier Ziffern.</p>
  <button data-name="Order" style="padding:12px 20px;background:#1b27a8;color:#ffffff;border:0;font-size:16px">Zahlungspflichtig bestellen</button>
</div>
<footer data-name="Footer" style="display:flex;flex-wrap:wrap;gap:8px;padding:16px"><a href="/impressum" style="display:block;padding:12px">Impressum</a><a href="/datenschutz" style="display:block;padding:12px">Datenschutz</a><a href="/barrierefreiheit" style="display:block;padding:12px">Erklärung zur Barrierefreiheit</a></footer>
<div data-name="Cookie banner" style="display:flex;flex-wrap:wrap;gap:12px;padding:16px;background:#f4f2ec"><p style="font-size:16px">Wir verwenden Cookies für Statistik.</p><button data-name="Reject" style="padding:12px;background:#111111;color:#ffffff">Ablehnen</button><button data-name="Accept" style="padding:12px;background:#111111;color:#ffffff">Alle akzeptieren</button></div>`;
