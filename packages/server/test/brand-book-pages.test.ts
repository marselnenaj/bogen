import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BogenDoc, balanceQuotes, bookPolicy, bookVoice, brandBookHtml, brandBookPages, initializeBrandBook, markBrandDoc, readBrand, typesetText, upsertBrandItem, setBrandField } from '@bogen/core';

function brand(fill: (doc: BogenDoc) => void) {
  const doc = new BogenDoc(new Y.Doc());
  doc.transact(() => { markBrandDoc(doc); fill(doc); });
  return readBrand(doc);
}

describe('the brand book', () => {
  it('leaves out what a sparse brand does not have, and names it in the colophon', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      upsertBrandItem(doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
    });
    const pages = brandBookPages(data);
    const titles = pages.map((p) => p.title);
    expect(titles[0]).toBe('Cover');
    expect(titles[1]).toBe('Contents');
    expect(titles).toContain('Colour, page 1');
    expect(titles).not.toContain('Logo');
    expect(titles).not.toContain('Typography');
    expect(titles.at(-1)).toBe('About this book');
    // What is missing is said once, in the colophon, not on the contents page.
    const colophon = pages.at(-1)!.html;
    expect(colophon).toContain('Still to add');
    expect(colophon).toMatch(/brand idea, logo, typography/);
    expect(pages[1]!.html).not.toContain('Still to add');
    // A brand with little written down gets a short book: no chapter openers, the chapter named in the running head,
    // which is the same head as on every other page.
    expect(pages.some((p) => p.title === 'Colour')).toBe(false);
    expect(pages.find((p) => p.title === 'Colour, page 1')!.html).toMatch(/<header class="bb-head"[^>]*>.*Brand guidelines.*01 Colour<\/span><\/header>/);
    // Every page is one fixed sheet, so the PDF has a page per page.
    for (const p of pages) expect(p.html).toMatch(/width:1280px;height:800px/);
  });

  it('shows colour values as HEX, RGB and OKLCH, with measured contrast on pairs', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      upsertBrandItem(doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
      upsertBrandItem(doc, 'colors', { name: 'Ash', value: '#f4efe8', role: 'background', token: 'ash' });
      upsertBrandItem(doc, 'pairings', { fg: 'clay', bg: 'ash', verdict: 'allow' });
    });
    const html = brandBookHtml(data);
    expect(html).toContain('#B5562F');
    expect(html).toContain('181 86 47');
    expect(html).toMatch(/OKLCH<\/dt><dd[^>]*>\d+\.\d% 0\.\d{3} \d+/);
    expect(html).toContain('Pairs and contrast');
    expect(html).toMatch(/\d\.\d+:1 · (AA|AAA|Fails|AA large only)/);
    // It reflows for a phone.
    expect(html).toContain('@media (max-width: 700px)');
  });

  it('keeps approval state out of the pages and in the colophon, and escapes what brands say', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', '<b>Kiln</b>');
      setBrandField(doc, 'positioning', 'Pots <script>alert(1)</script> for daily use.');
      upsertBrandItem(doc, 'families', { family: 'Fraunces', role: 'display', suggested: true, token: 'display' });
      initializeBrandBook(doc);
    });
    const html = brandBookHtml(data);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>Kiln');
    // No "(suggestion)" tag on a value: the colophon counts the proposals in one place.
    expect(html).not.toContain('(suggestion)');
    expect(html).toContain('values are proposals and bind nobody until confirmed');
  });

  it('keeps working notes out, never cuts copy mid-sentence, and speaks the brand\'s language', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      setBrandField(doc, 'language', 'de');
      setBrandField(doc, 'positioning', 'Töpfern für jeden Tag. Laut CLAUDE.md gilt eine Ausnahme auf Nutzerwunsch. Geschirr aus Wien, gebrannt in kleinen Serien, für Küchen, Cafés und Restaurants, die lange halten sollen und gerne benutzt werden, auch wenn es eilig ist und viel los ist und alle gleichzeitig bestellen.');
      upsertBrandItem(doc, 'colors', { name: 'Ton', value: '#b5562f', role: 'primary', token: 'clay' });
      upsertBrandItem(doc, 'colors', { name: 'Papier', value: '#f4efe8', role: 'background', token: 'paper' });
      upsertBrandItem(doc, 'rules', { text: 'Ecken bleiben eckig. Siehe src/styles/global.css für die Werte.', kind: 'do', severity: 'hard', topic: 'layout' });
    });
    const pages = brandBookPages(data);
    const all = pages.map((p) => p.html).join('');
    // The working notes stay in the Markdown export.
    expect(all).not.toContain('CLAUDE.md');
    expect(all).not.toContain('global.css');
    expect(all).toContain('Ecken bleiben eckig.');
    // The cover leads with the short statement, and nothing ends in a cut word.
    expect(pages[0]!.html).toContain('Töpfern für jeden Tag.');
    expect(all).not.toMatch(/\w\.\.\.</);
    // The chrome is German for a German brand.
    expect(pages[1]!.html).toContain('Inhalt');
    expect(all).toContain('Markenrichtlinien');
    expect(all).not.toContain('Brand guidelines');
  });

  it('leaves out notes in the other language, prompt text, and tokens whose names say a different value', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Wacht');
      setBrandField(doc, 'language', 'de');
      setBrandField(doc, 'positioning', 'Rechtsänderungen früh sehen. Use the existing vector asset and test a real heading before you ship it.');
      upsertBrandItem(doc, 'colors', { name: 'primary #3b4685', value: '#3b4685', role: 'primary', token: 'primary-3b4685' });
      upsertBrandItem(doc, 'colors', { name: 'Papier', value: '#fafbfd', role: 'background', token: 'paper-ffffff' });
      upsertBrandItem(doc, 'families', { family: 'Space Grotesk', role: 'body', token: 'font-inter' });
      upsertBrandItem(doc, 'rules', { text: 'Check actual diacritics before declaring a language supported.', kind: 'do', severity: 'soft', topic: 'type' });
    });
    const all = brandBookPages(data).map((p) => p.html).join('');
    expect(all).not.toContain('Use the existing');
    expect(all).not.toContain('Check actual diacritics');
    // A colour named by its role and hex shows its role in words; a token claiming another hex is left out.
    expect(all).toContain('Primärfarbe');
    expect(all).not.toContain('primary #3b4685');
    expect(all).not.toContain('--paper-ffffff');
    expect(all).toContain('--primary-3b4685');
    // A font token named after another family is not printed as if it held it.
    expect(all).not.toContain('--font-inter');
  });

  it('draws applications from the brand: stationery, a letter, a post and a web page', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      setBrandField(doc, 'positioning', 'Pots for daily use. Thrown in small batches in Vienna.');
      upsertBrandItem(doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
      upsertBrandItem(doc, 'colors', { name: 'Ash', value: '#f4efe8', role: 'background', token: 'ash' });
    });
    const apps = brandBookPages(data).filter((p) => p.section.endsWith('Applications')).map((p) => p.html).join('');
    for (const piece of ['Business card, front', 'Post, 1:1', 'Story, 9:16', 'Home page, first screen']) expect(apps).toContain(piece);
    expect(apps).toContain('Pots for daily use.');
    // No invented people, wireframe bars, agency navigation or fake window chrome.
    for (const not of ['First Last', 'Services', 'Get in touch', 'About', '#ff5f57', 'Email signature']) expect(apps).not.toContain(not);
  });

  it('writes the letter in the brand\'s own sentences, dated, and leaves out a drawn web page when the brand has its own', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      setBrandField(doc, 'positioning', 'Pots for daily use. Thrown in small batches in Vienna, glazed by hand and fired twice in a wood kiln at the edge of the city.');
      setBrandField(doc, 'audience', 'People who cook every day and want plates that last.');
      upsertBrandItem(doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
      upsertBrandItem(doc, 'colors', { name: 'Ash', value: '#f4efe8', role: 'background', token: 'ash' });
    });
    const examples = [{ name: 'Home page', verdict: 'good' as const, src: 'data:image/jpeg;base64,AA==', width: 1100, height: 2400 }];
    const apps = brandBookPages(data, { examples, date: '17 November 2026' }).filter((p) => p.section.endsWith('Applications')).map((p) => p.html).join('');
    expect(apps).toContain('Letter, A4');
    expect(apps).toContain('17 November 2026');
    expect(apps).toContain('People who cook every day and want plates that last.');
    expect(apps).not.toContain('Home page, first screen, drawn from the brand');
  });

  it('obeys the brand\'s own rules about case, slant and shadows', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      setBrandField(doc, 'positioning', 'Pots for daily use.');
      setBrandField(doc, 'shadows', 'none');
      upsertBrandItem(doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
      upsertBrandItem(doc, 'families', { family: 'Archivo Black', role: 'display', weights: [400], token: 'display' });
      upsertBrandItem(doc, 'families', { family: 'Bodoni Moda', role: 'body', weights: [400], token: 'body' });
      upsertBrandItem(doc, 'rules', { text: 'Archivo Black nur in Versalien, für Display. Bodoni Moda für Überschriften und Lesetext.', kind: 'do', severity: 'soft', topic: 'type' });
      upsertBrandItem(doc, 'rules', { text: 'Überschriften in Bodoni Moda kursiv.', kind: 'do', severity: 'soft', topic: 'type' });
    });
    const policy = bookPolicy(data);
    expect(policy).toMatchObject({ upperFamily: 'Archivo Black', italicFamily: 'Bodoni Moda', headingFamily: 'Bodoni Moda', noShadow: true });
    const all = brandBookPages(data).map((p) => p.html).join('');
    expect(all).toMatch(/Archivo Black.{0,80}text-transform:uppercase/);
    expect(all).toMatch(/Bodoni Moda.{0,80}font-style:italic/);
    expect(all).not.toMatch(/box-shadow:0 1px 2px/);
  });

  it('shows the core colours large and the rest grouped in one table, with tokens that never break', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      upsertBrandItem(doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
      upsertBrandItem(doc, 'colors', { name: 'Ash', value: '#f4efe8', role: 'background', token: 'ash' });
      upsertBrandItem(doc, 'colors', { name: 'Soot', value: '#1c1a18', role: 'text', token: 'soot' });
      for (let i = 0; i < 8; i++) upsertBrandItem(doc, 'colors', { name: `Glaze ${i}`, value: `#${(0x305070 + i * 0x101010).toString(16)}`, role: i < 4 ? 'illustration' : 'surface-raised', token: `kiln-glaze-tone-${i}` });
    });
    const pages = brandBookPages(data);
    // The core colours large in the chapter; the other eight in one table in the appendix.
    const table = pages.filter((p) => p.section === 'Appendix');
    expect(table.length).toBe(1);
    expect(table[0]!.html).toContain('All colours');
    expect(table[0]!.html).toContain('Illustration');
    expect(table[0]!.html).toContain('Surfaces');
    expect(table[0]!.html).toMatch(/white-space:nowrap[^>]*>--kiln-glaze-tone-0/);
  });

  it('closes the quotes it cuts, says no once, and marks rules that are only proposals', () => {
    expect(balanceQuotes('„Kunden gewinnen.')).toBe('„Kunden gewinnen.“');
    expect(balanceQuotes('Abläufe vereinfachen.“')).toBe('„Abläufe vereinfachen.“');
    expect(balanceQuotes('“Plain” and fine')).toBe('“Plain” and fine');
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      setBrandField(doc, 'positioning', 'Pots for daily use. Made in one small workshop by two people who like clay.');
      upsertBrandItem(doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay' });
      upsertBrandItem(doc, 'rules', { text: 'Do not state a count of glazes.', kind: 'dont', severity: 'hard', topic: 'voice' });
      upsertBrandItem(doc, 'rules', { text: 'Square corners everywhere.', kind: 'do', severity: 'hard', topic: 'layout', suggested: true });
      upsertBrandItem(doc, 'rules', { text: 'No shadows on cards.', kind: 'do', severity: 'soft', topic: 'layout' });
      upsertBrandItem(doc, 'rules', { text: 'Never more than one accent per page.', kind: 'do', severity: 'soft', topic: 'color' });
      upsertBrandItem(doc, 'rules', { text: 'Photos in full colour, never cropped tight.', kind: 'do', severity: 'soft', topic: 'imagery' });
    });
    const html = brandBookHtml(data);
    expect(html).not.toMatch(/>Never<\/strong> Do not/);
    expect(html).toContain('Proposal');
    expect(html).toContain('Proposed rules: they bind nobody until the brand confirms them.');
  });

  it('reads the width, screenshot, greyscale and wordmark rules of a brand', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Bogen');
      upsertBrandItem(doc, 'families', { family: 'Archivo', role: 'display', token: 'display', weights: [800, 900] });
      upsertBrandItem(doc, 'rules', { text: 'No all caps, except the BOGEN wordmark.', kind: 'do', severity: 'hard', topic: 'type' });
      upsertBrandItem(doc, 'rules', { text: 'Display at weight 800 to 900, width 112 to 125 %, tight tracking.', kind: 'do', severity: 'soft', topic: 'type' });
      upsertBrandItem(doc, 'rules', { text: 'Project screenshots in full aspect ratio, never cropped. The portrait in greyscale.', kind: 'do', severity: 'soft', topic: 'imagery' });
    });
    const policy = bookPolicy(data);
    expect(policy.displayStretch).toBe(112);
    expect(policy.uncroppedScreens).toBe(true);
    expect(policy.grayscale).toBe('portraits');
    expect(policy.capsWordmark).toBe('BOGEN');
    // Display lines of 40px and more carry the brand's width.
    expect(brandBookHtml(data)).toMatch(/font-stretch:112%/);
  });

  it('sets curly quotes and apostrophes and hex values in capitals', () => {
    expect(typesetText('the brand\'s "own" ink #0a0a0a', 'en')).toBe('the brand\u2019s \u201cown\u201d ink #0A0A0A');
    expect(typesetText('Das "System" in #c2e636', 'de')).toBe('Das \u201eSystem\u201c in #C2E636');
    // Entities and words are left alone.
    expect(typesetText('&#39; #fac and #12', 'en')).toBe('&#39; #FAC and #12');
  });

  it('holds the copy it sets to the brand\'s own voice rules and says what it left out', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'nordlicht');
      setBrandField(doc, 'language', 'de');
      setBrandField(doc, 'positioning', 'Kunden gewinnen. Abläufe vereinfachen. Marketing und IT für Betriebe: Ich mache Erfahrung aus Tech für deinen Betrieb nutzbar.');
      upsertBrandItem(doc, 'colors', { name: 'Tinte', value: '#0a0a0a', role: 'text', token: 'ink' });
      upsertBrandItem(doc, 'colors', { name: 'Papier', value: '#f2f0ea', role: 'background', token: 'paper' });
      upsertBrandItem(doc, 'rules', { text: 'Überschriften enthalten genau eine klare Aussage: keine Doppel-Slogans, keine gegeneinandergestellten Kurzsätze. Einzige Ausnahme ist der Startseiten-Hero „Kunden gewinnen. Abläufe vereinfachen.“', kind: 'do', severity: 'hard', topic: 'voice' });
      upsertBrandItem(doc, 'voiceExamples', { good: 'Ja. Wir prüfen zuerst, was bereits funktioniert.' });
      upsertBrandItem(doc, 'voiceExamples', { good: 'Was hast du vor?' });
    });
    const policy = bookPolicy(data);
    expect(policy.oneStatement).toBe(true);
    expect(policy.singular).toBe(true);
    expect(policy.statementExceptions).toEqual(['Kunden gewinnen. Abläufe vereinfachen.']);
    const voice = bookVoice(data, policy);
    expect(voice.headlineOk('Kunden gewinnen. Abläufe vereinfachen.')).toBe(false);
    expect(voice.headlineOk('Kunden gewinnen. Abläufe vereinfachen.', true)).toBe(true);
    expect(voice.copyOk('Wir prüfen zuerst.')).toBe(false);
    const pages = brandBookPages(data);
    // The cover leads with a line that says one thing.
    expect(pages[0]!.html).toContain('Marketing und IT für Betriebe');
    expect(pages[0]!.html).not.toContain('Kunden gewinnen. Abläufe vereinfachen.');
    const all = pages.map((p) => p.html).join('');
    expect(all).not.toContain('Wir prüfen zuerst');
    expect(pages.at(-1)!.html).toContain('Ein Beispiel der Marke ist ausgelassen');
  });

  it('counts the chapters the contents lists, and says when none is confirmed', () => {
    const data = brand((doc) => {
      setBrandField(doc, 'name', 'Kiln');
      setBrandField(doc, 'positioning', 'Pots for daily use.');
      upsertBrandItem(doc, 'colors', { name: 'Clay', value: '#b5562f', role: 'primary', token: 'clay', suggested: true });
      upsertBrandItem(doc, 'rules', { text: 'Clay only on pots.', kind: 'do', severity: 'soft', topic: 'color' });
    });
    const pages = brandBookPages(data);
    const listed = (pages[1]!.html.match(/<li /g) ?? []).length;
    expect(pages.at(-1)!.html).toContain(`All ${listed} chapters are drafts.`);
  });
});
