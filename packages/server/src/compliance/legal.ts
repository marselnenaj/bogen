import type { BogenDoc, BogenNode, ComplianceMark } from '@bogen/core';
import { usedFamilies } from '../render.ts';

/**
 * Reminders of other duties that a web page, shop, app, ad or e-mail in Austria often has, as far as a design can show
 * them: a link to the Impressum and the privacy notice, a consent banner whose "reject" is as easy as its "accept",
 * the wording of an order button, prices with VAT and delivery, discounts with their reference price, urgency and
 * shaming, generic green claims, labels for ads and AI pictures, fonts loaded from Google, and pictures whose licence
 * is unknown. They are reminders with their source, never a legal judgement: a person decides what applies.
 * Sources were read on 2026-11-13 (RIS for Austrian law, EUR-Lex for EU law); see docs/guide/compliance-law.md.
 */

export type ReminderState = 'found' | 'look' | 'info';
export interface LegalReminder {
  key: string;
  topic: string;
  state: ReminderState;
  message: string;
  source: string;
  node_id?: string;
  layer?: string;
  /** A person's mark: done, not done, or not applicable. */
  mark?: ComplianceMark;
}
export interface LegalReport {
  kind: { site: boolean; shop: boolean; consent_banner: boolean; email: boolean };
  reminders: LegalReminder[];
  /** What only a person can check, with its source. */
  manual: { key: string; topic: string; test: string; source: string; mark?: ComplianceMark }[];
  disclaimer: string;
}

const RIS = (nr: string) => `https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=${nr}`;
export const SOURCES = {
  ecg5: `ECG § 5 (information duties of a service provider). ${RIS('20001703')}`,
  ecg52: `ECG § 5(2) (prices: gross or net, delivery costs). ${RIS('20001703')}`,
  ecg6: `ECG § 6 (commercial communication must be recognisable). ${RIS('20001703')}`,
  ecg7: `ECG § 7 and TKG 2021 § 174 (advertising e-mail, consent and opt-out). ${RIS('20001703')}; ${RIS('20011678')}`,
  medieng25: `MedienG § 25 (Offenlegung). ${RIS('10000719')}`,
  medieng26: `MedienG § 26 (labelling paid content: "Anzeige", "Werbung", "entgeltliche Einschaltung"). ${RIS('10000719')}`,
  ugb14: `UGB § 14 (company details on websites) and GewO § 63. ${RIS('10001702')}; ${RIS('10007517')}`,
  gdpr13: 'GDPR art. 13 (information at collection). https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  tkg165: `TKG 2021 § 165(3) (consent before storing or reading data on the device). ${RIS('20011678')}`,
  edpbBanner: 'EDPB Cookie Banner Taskforce report, 17 January 2023 (no reject option on a layer with accept; pre-ticked boxes; deceptive colours and contrast). https://www.edpb.europa.eu/our-work-tools/our-documents/other/report-work-undertaken-cookie-banner-taskforce_en',
  edpbDark: 'EDPB Guidelines 03/2022 on deceptive design patterns, version 2.0, 14 February 2023. https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-032022-deceptive-design-patterns-social-media_en',
  fonts: 'LG München I, 20 January 2022, 3 O 17493/20 (a German regional court: remote Google Fonts sent visitors\' IP addresses to Google without a legal basis). Not Austrian law; the Austrian DSB had not decided the question as of November 2026. https://www.gesetze-bayern.de/Content/Document/Y-300-Z-BECKRS-B-2022-N-612',
  fagg8: `FAGG § 8(2) (the order button says "zahlungspflichtig bestellen" or something equally clear), Directive 2011/83/EU art. 8(2). ${RIS('20008847')}`,
  fagg4: `FAGG § 4 and § 8(1) (information before the order), § 11 (14 days to withdraw). ${RIS('20008847')}`,
  fagg13a: `FAGG § 13a (withdrawal button "Vertrag widerrufen" and "Widerruf bestätigen", for contracts concluded after 30 September 2026), Directive (EU) 2023/2673. ${RIS('20008847')}`,
  prag9: `PrAG § 9(1) (prices including VAT and all charges). ${RIS('10007216')}`,
  prag9a: `PrAG § 9a (a price reduction names the lowest price of the 30 days before), Directive 98/6/EC art. 6a. ${RIS('10007216')}`,
  crd22: 'Directive 2011/83/EU art. 22 (extra payments need express consent, not a pre-ticked option). https://eur-lex.europa.eu/eli/dir/2011/83/oj',
  uwgZ7: `UWG Anhang Z 7 (claiming falsely that an offer is available only for a very limited time), Directive 2005/29/EC Annex I point 7. ${RIS('10002665')}`,
  uwg1a: `UWG § 1a (aggressive practices) and EDPB Guidelines 03/2022 ("stirring": emotional steering). ${RIS('10002665')}`,
  green: `UWG Anhang Z 4a to 4c (generic environmental claims, claims about the whole product, offsetting), from 27 September 2026, Directive (EU) 2024/825. ${RIS('10002665')}`,
  dsa25: 'DSA art. 25 (online platforms must not deceive or manipulate through their interface). https://eur-lex.europa.eu/eli/reg/2022/2065/oj',
  ai50: 'AI Act art. 50(4) and (5) (deployers disclose deepfakes clearly, at the latest on first exposure), art. 50(2) (providers mark synthetic output machine-readably; for systems on the market before 2 August 2026 from 2 December 2026, Regulation (EU) 2026/1744). https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  geo: 'Geo-blocking Regulation (EU) 2018/302 art. 3. https://eur-lex.europa.eu/eli/reg/2018/302/oj',
  licence: 'Urheberrechtsgesetz (UrhG) and the licence of each font, picture and icon. ' + RIS('10001848'),
};

const IMPRINT = /impressum|imprint|offenlegung|legal notice|site notice/i;
const PRIVACY = /datenschutz|privacy|privatsphäre/i;
const BANNER = /cookie|einwilligung|consent|tracking|zustimmung/i;
const ACCEPT = /akzeptier|alle annehmen|annehmen|zustimmen|einverstanden|accept|allow all|agree|^ok$|got it/i;
const REJECT = /ablehnen|nur notwendige|nur erforderliche|nur essenzielle|reject|decline|deny|necessary only|only necessary|essential only/i;
const PRICE = /(?:€|eur)\s?\d|\d+(?:[.,]\d{2})?\s?(?:€|eur\b)/i;
const SHOP = /warenkorb|in den korb|kasse|checkout|add to (?:cart|bag)|shopping (?:cart|bag)|zahlungsart|payment method|lieferadresse|shipping address|bestellübersicht|order summary/i;
const CHECKOUT = /bestellübersicht|zusammenfassung|order summary|zahlungsart|payment method|lieferadresse|shipping address|checkout|kasse|review your order/i;
const ORDER_ACTION = /bestell|kauf|order|buy|checkout|abschlie(ß|ss)en|absenden|abschicken|submit|place|bezahlen|pay\b|^weiter$|^continue$/i;
const ORDER_CLEAR = /zahlungspflichtig bestellen|kostenpflichtig bestellen|zahlungspflichtig|jetzt kaufen|^kaufen$|buy now|order with obligation to pay|place order and pay|pay now|jetzt bezahlen|kaufen und bezahlen/i;
const VAT = /inkl\.?\s*(?:mwst|ust)|inklusive\s*(?:mwst|ust|mehrwertsteuer)|incl\.?\s*vat|including vat|vat included|brutto|zzgl\.?\s*versand|versandkosten|versand|shipping|delivery/i;
const DISCOUNT = /-\s?\d{1,2}\s?%|\d{1,2}\s?%\s*(?:rabatt|off|günstiger|reduziert)|\bsale\b|\bstatt\b|\buvp\b|\bwas\b\s*(?:€|eur)|reduziert/i;
const URGENCY = /nur noch (?:heute|\d+)|only \d+ left|endet in|ends in|countdown|letzte chance|last chance|\d+ (?:personen|leute|people) (?:sehen|schauen|are viewing|are looking)|fast ausverkauft|almost sold out|selling fast/i;
const SHAMING = /nein danke,? ich|no thanks,? i(?:'m| am| don't| do not| prefer)|ich will (?:keine|nicht)|i don't want to save|ich verzichte/i;
const GREEN = /klimaneutral|co2-neutral|umweltfreundlich|nachhaltig|ökologisch|biologisch abbaubar|eco-friendly|climate neutral|carbon neutral|sustainable|environmentally friendly|green choice/i;
const AD_LABEL = /\banzeige\b|\bwerbung\b|entgeltliche einschaltung|gesponsert|sponsored|\bad\b|advertisement|paid partnership|bezahlte partnerschaft/i;
const AD_LIKE = /\bad\b|advert|anzeige|banner|sponsored|gesponsert|promo|kampagne|campaign|influencer|kooperation/i;
const AI_MARK = /\b(?:ai|ki)[ -]?(?:generated|generiert|erstellt|image|bild)|image_gen|dall-?e|midjourney|stable diffusion|firefly|imagen|generated with/i;
const AI_LABEL = /ki-generiert|mit ki erstellt|ki-bild|ai-generated|generated with ai|created with ai|made with ai|künstlich erzeugt/i;
const EMAIL = /newsletter|unsubscribe|abmelden|abbestellen|e-mail-vorschau|preheader/i;
const UNSUBSCRIBE = /unsubscribe|abmelden|abbestellen|newsletter abbestellen|opt.?out/i;
const EMBED = /youtube|youtu\.be|vimeo|google\.[a-z.]+\/maps|maps\.google|openstreetmap|spotify|soundcloud|instagram|facebook|twitter|x\.com|tiktok|calendly|typeform/i;

const textOf = (doc: BogenDoc, id: string): string => {
  const n = doc.getNode(id);
  if (!n) return '';
  return [n.text ?? '', n.attrs?.['aria-label'] ?? '', n.attrs?.alt ?? '', n.attrs?.value ?? '', ...doc.getChildren(id).map((c) => textOf(doc, c.id))].join(' ').replace(/\s+/g, ' ').trim();
};
const isControl = (n: BogenNode) => n.tag === 'a' || n.tag === 'button' || (n.tag === 'input' && /^(submit|button)$/i.test(n.attrs?.type ?? '')) || n.attrs?.role === 'button' || n.attrs?.role === 'link';
const filled = (n: BogenNode) => {
  const bg = `${n.style.background ?? ''} ${n.style.backgroundColor ?? ''}`.trim();
  return Boolean(bg) && !/^(none|transparent|initial|inherit|unset|rgba\([^)]*,\s*0\))$/i.test(bg);
};

export function legalReminders(doc: BogenDoc, boards: string[], nodes: BogenNode[]): LegalReport {
  const live = nodes.filter((n) => !n.hidden);
  const text = boards.map((b) => textOf(doc, b)).join(' ');
  const controls = live.filter(isControl).map((n) => ({ n, words: textOf(doc, n.id) }));
  const links = controls.filter((c) => c.n.tag === 'a' || c.n.attrs?.href);
  const out: LegalReminder[] = [];
  const add = (r: Omit<LegalReminder, 'layer'>) => out.push({ ...r, ...(r.node_id ? { layer: doc.getNode(r.node_id)?.name ?? '' } : {}) });
  const site = live.some((n) => ['nav', 'header', 'footer'].includes(n.tag)) || links.length >= 4;
  const shop = SHOP.test(text) || (PRICE.test(text) && controls.some((c) => /warenkorb|cart|kaufen|buy|bestellen|order/i.test(c.words)));
  const email = EMAIL.test(text) || boards.some((b) => /e-?mail|newsletter/i.test(doc.getNode(b)?.name ?? ''));

  if (site) {
    const imprint = links.find((l) => IMPRINT.test(`${l.words} ${l.n.attrs?.href ?? ''}`));
    add(imprint
      ? { key: 'legal:imprint', topic: 'Impressum and Offenlegung', state: 'found', node_id: imprint.n.id, message: `"${imprint.words.slice(0, 40)}" links the Impressum. It has to name the provider, address, e-mail, register number and court, VAT number, chamber and supervisory authority where they apply, and the Offenlegung.`, source: `${SOURCES.ecg5}; ${SOURCES.medieng25}; ${SOURCES.ugb14}` }
      : { key: 'legal:imprint', topic: 'Impressum and Offenlegung', state: 'look', message: 'No link to an Impressum ("Impressum", "Offenlegung", "Imprint") on this page. A business website usually needs one that is easy to find from every page, often in the footer.', source: `${SOURCES.ecg5}; ${SOURCES.medieng25}; ${SOURCES.ugb14}` });
    const privacy = links.find((l) => PRIVACY.test(`${l.words} ${l.n.attrs?.href ?? ''}`));
    add(privacy
      ? { key: 'legal:privacy', topic: 'Privacy notice', state: 'found', node_id: privacy.n.id, message: `"${privacy.words.slice(0, 40)}" links the privacy notice.`, source: SOURCES.gdpr13 }
      : { key: 'legal:privacy', topic: 'Privacy notice', state: 'look', message: 'No link to a privacy notice ("Datenschutz", "Privacy") on this page. Where personal data is collected, the notice is given at that moment.', source: SOURCES.gdpr13 });
  }

  // Consent banners: reject as easy as accept, nothing ticked in advance.
  const banners = live.filter((n) => n.type === 'frame' && BANNER.test(textOf(doc, n.id)) && controls.some((c) => doc.ancestors(c.n.id).includes(n.id)));
  const banner = banners.sort((a, b) => doc.descendants(a.id).length - doc.descendants(b.id).length)[0];
  if (banner) {
    const inside = controls.filter((c) => doc.ancestors(c.n.id).includes(banner.id));
    const accept = inside.find((c) => ACCEPT.test(c.words));
    const reject = inside.find((c) => REJECT.test(c.words));
    if (accept && !reject) add({ key: 'legal:consent-reject', topic: 'Consent banner', state: 'look', node_id: banner.id, message: `The banner has "${accept.words.slice(0, 30)}" and no way to refuse on the same layer. Refusing should be as easy as accepting.`, source: `${SOURCES.tkg165}; ${SOURCES.edpbBanner}` });
    else if (accept && reject) {
      const size = (n: BogenNode) => parseFloat(n.style.fontSize ?? '') || 0;
      const unequal = filled(accept.n) !== filled(reject.n) || accept.n.tag !== reject.n.tag || Math.abs(size(accept.n) - size(reject.n)) > 1;
      add(unequal
        ? { key: 'legal:consent-reject', topic: 'Consent banner', state: 'look', node_id: reject.n.id, message: `"${reject.words.slice(0, 30)}" looks weaker than "${accept.words.slice(0, 30)}" (${filled(accept.n) && !filled(reject.n) ? 'no fill' : accept.n.tag !== reject.n.tag ? 'a link next to a button' : 'smaller text'}). Give both the same weight.`, source: `${SOURCES.tkg165}; ${SOURCES.edpbBanner}` }
        : { key: 'legal:consent-reject', topic: 'Consent banner', state: 'found', node_id: banner.id, message: `Accept ("${accept.words.slice(0, 30)}") and reject ("${reject.words.slice(0, 30)}") look alike.`, source: SOURCES.edpbBanner });
    }
    for (const box of live.filter((n) => doc.ancestors(n.id).includes(banner.id) && n.tag === 'input' && /checkbox|radio/i.test(n.attrs?.type ?? '') && n.attrs?.checked !== undefined)) {
      add({ key: 'legal:consent-preticked', topic: 'Consent banner', state: 'look', node_id: box.id, message: 'A choice in the consent banner is ticked in advance. Consent has to be an active choice; strictly necessary storage needs no box at all.', source: `${SOURCES.tkg165}; ${SOURCES.edpbBanner}` });
    }
  }

  // Embeds and remote fonts send visitors' data to others as soon as they load.
  const embeds = live.filter((n) => (n.type === 'embed' || n.type === 'video' || n.tag === 'iframe') && EMBED.test(n.src ?? n.attrs?.src ?? ''));
  for (const e of embeds.slice(0, 5)) add({ key: 'legal:embeds', topic: 'Third-party embeds', state: 'look', node_id: e.id, message: `This embed (${(e.src ?? e.attrs?.src ?? '').replace(/^https?:\/\//, '').slice(0, 40)}) loads from another company and sends the visitor's IP address and cookies before anyone agrees. Load it only after a click or consent${banner ? '' : ', and add a consent banner'}.`, source: `${SOURCES.tkg165}; ${SOURCES.gdpr13}` });
  const fonts = usedFamilies(doc).filter((f) => !/^(arial|helvetica|georgia|times|verdana|menlo|consolas|courier|system-ui)/i.test(f));
  if (fonts.length) add({ key: 'legal:google-fonts', topic: 'Fonts loaded from Google', state: 'look', message: `Bogen's HTML export links ${fonts.slice(0, 4).join(', ')}${fonts.length > 4 ? ' and more' : ''} from fonts.googleapis.com, so every visitor's browser contacts Google. Host the font files with the site, or upload them to the file as fonts.`, source: SOURCES.fonts });

  if (shop) {
    const checkout = CHECKOUT.test(text);
    const orders = controls.filter((c) => (c.n.tag === 'button' || c.n.tag === 'input' || c.n.attrs?.role === 'button') && ORDER_ACTION.test(c.words) && !/warenkorb|cart|bag|korb/i.test(c.words));
    if (checkout) {
      const clear = orders.find((o) => ORDER_CLEAR.test(o.words.trim()));
      if (clear) add({ key: 'legal:order-button', topic: 'Order button', state: 'found', node_id: clear.n.id, message: `The order button says "${clear.words.slice(0, 40)}".`, source: SOURCES.fagg8 });
      else for (const o of orders.slice(0, 3)) add({ key: 'legal:order-button', topic: 'Order button', state: 'look', node_id: o.n.id, message: `This looks like the final order button and says "${o.words.slice(0, 40)}". It has to make clear that ordering means paying, such as "zahlungspflichtig bestellen"; otherwise the consumer is not bound.`, source: SOURCES.fagg8 });
    }
    if (PRICE.test(text) && !VAT.test(text)) add({ key: 'legal:price-vat', topic: 'Prices', state: 'look', message: 'Prices are shown, and nothing on the page says they include VAT or what delivery costs. Consumers are shown gross prices, and whether delivery is included.', source: `${SOURCES.prag9}; ${SOURCES.ecg52}` });
    const struck = live.some((n) => n.tag === 's' || n.tag === 'del' || /line-through/.test(n.style.textDecoration ?? n.style.textDecorationLine ?? '') || (n.spans ?? []).some((s) => /line-through/.test(JSON.stringify(s))));
    if (DISCOUNT.test(text) || struck) add({ key: 'legal:discount', topic: 'Price reductions', state: 'look', message: struck ? 'A crossed-out price is shown. For a price reduction it has to be the lowest price of the 30 days before, in the same channel.' : 'A discount is announced without a crossed-out or named earlier price. A price reduction names the lowest price of the 30 days before.', source: SOURCES.prag9a });
    const preticked = live.filter((n) => n.tag === 'input' && /checkbox/i.test(n.attrs?.type ?? '') && n.attrs?.checked !== undefined && !(banner && doc.ancestors(n.id).includes(banner.id)));
    for (const p of preticked.slice(0, 3)) add({ key: 'legal:preticked', topic: 'Extras ticked in advance', state: 'look', node_id: p.id, message: 'A box is ticked in advance. If it adds a paid extra, consent cannot come from a default the consumer has to untick.', source: SOURCES.crd22 });
    const withdraw = controls.find((c) => /vertrag widerrufen|withdraw from contract/i.test(c.words));
    add(withdraw
      ? { key: 'legal:withdrawal-button', topic: 'Withdrawal button', state: 'found', node_id: withdraw.n.id, message: `"${withdraw.words.slice(0, 40)}" is the withdrawal function. It stays reachable for the whole withdrawal period and leads to "Widerruf bestätigen".`, source: SOURCES.fagg13a }
      : { key: 'legal:withdrawal-button', topic: 'Withdrawal button', state: 'info', message: 'For contracts concluded online after 30 September 2026 a withdrawal function labelled "Vertrag widerrufen" has to be easy to find for the whole withdrawal period, usually in the account or order area; it may be on another page.', source: SOURCES.fagg13a });
  }

  // Wording that steers people.
  const urgent = live.find((n) => n.type === 'text' && URGENCY.test(n.text ?? ''));
  if (urgent) add({ key: 'legal:urgency', topic: 'Urgency', state: 'look', node_id: urgent.id, message: `"${(urgent.text ?? '').slice(0, 50)}" creates time pressure. It has to be true; a false "only today" is always unfair.`, source: `${SOURCES.uwgZ7}; ${SOURCES.dsa25}` });
  const shame = controls.find((c) => SHAMING.test(c.words));
  if (shame) add({ key: 'legal:confirmshaming', topic: 'Shaming the "no"', state: 'look', node_id: shame.n.id, message: `"${shame.words.slice(0, 50)}" makes declining feel bad. Offer a plain "No, thanks".`, source: `${SOURCES.uwg1a}; ${SOURCES.edpbDark}` });
  const green = live.find((n) => n.type === 'text' && GREEN.test(n.text ?? ''));
  if (green) add({ key: 'legal:green-claim', topic: 'Environmental claims', state: 'look', node_id: green.id, message: `"${(green.text ?? '').slice(0, 50)}" is an environmental claim. Since 27 September 2026 a generic one ("umweltfreundlich", "klimaneutral") is allowed only with recognised excellent environmental performance, and a claim based on offsetting not at all.`, source: SOURCES.green });

  // Labels for ads and AI pictures.
  const adLike = boards.some((b) => AD_LIKE.test(doc.getNode(b)?.name ?? ''));
  if (adLike) add(AD_LABEL.test(text)
    ? { key: 'legal:ad-label', topic: 'Advertising label', state: 'found', message: 'The ad carries a label such as "Anzeige" or "Werbung".', source: `${SOURCES.medieng26}; ${SOURCES.ecg6}` }
    : { key: 'legal:ad-label', topic: 'Advertising label', state: 'look', message: 'This looks like an ad or sponsored content, and no label such as "Anzeige", "Werbung" or "Sponsored" is on it. Paid content has to be recognisable as such.', source: `${SOURCES.medieng26}; ${SOURCES.ecg6}` });
  const aiImages = live.filter((n) => (n.type === 'image' || n.type === 'video') && (n.attrs?.['data-ai-generated'] === 'true' || AI_MARK.test(`${n.name} ${n.attrs?.['data-source'] ?? ''} ${n.attrs?.['data-credit'] ?? ''}`)));
  if (aiImages.length && !AI_LABEL.test(text)) for (const img of aiImages.slice(0, 3)) add({ key: 'legal:ai-label', topic: 'AI-made pictures', state: 'look', node_id: img.id, message: 'This picture is marked as made with AI and nothing near it says so. If it shows real people, places or events that look authentic (a deepfake), it has to be disclosed clearly; other AI pictures are good practice to label.', source: SOURCES.ai50 });

  // Rights: where pictures and fonts come from.
  const images = live.filter((n) => n.type === 'image' && (n.src || n.attrs?.src));
  const unknown = images.filter((n) => !n.attrs?.['data-license'] && !n.attrs?.['data-licence'] && !n.attrs?.['data-credit'] && !n.attrs?.['data-source']);
  if (unknown.length) add({ key: 'legal:licences', topic: 'Licences of pictures', state: 'look', node_id: unknown[0]!.id, message: `${unknown.length === 1 ? 'One picture has' : `${unknown.length} pictures have`} no recorded licence or source. Record it with layer_attrs (data-license, data-credit) so the right to use it can be shown.`, source: SOURCES.licence });

  if (email) {
    const unsub = controls.find((c) => UNSUBSCRIBE.test(`${c.words} ${c.n.attrs?.href ?? ''}`));
    add(unsub
      ? { key: 'legal:unsubscribe', topic: 'Advertising e-mail', state: 'found', node_id: unsub.n.id, message: `"${unsub.words.slice(0, 40)}" lets people unsubscribe.`, source: SOURCES.ecg7 }
      : { key: 'legal:unsubscribe', topic: 'Advertising e-mail', state: 'look', message: 'This looks like a newsletter, and it has no unsubscribe link. Advertising e-mail needs prior consent, and every message a free way to opt out.', source: SOURCES.ecg7 });
  }

  const manual = [
    { key: 'legal:imprint-content', topic: 'Impressum content', test: 'The Impressum names provider, address, e-mail, register number and court, VAT number, chamber, supervisory authority and the rules of the profession where they apply; the Offenlegung names owner and line.', source: `${SOURCES.ecg5}; ${SOURCES.medieng25}` },
    { key: 'legal:trackers', topic: 'Cookies and trackers', test: 'List every cookie, pixel, analytics and embed of the built site. Only strictly necessary ones load before consent; the banner and the privacy notice name the rest.', source: `${SOURCES.tkg165}; ${SOURCES.edpbBanner}` },
    ...(shop ? [{ key: 'legal:pre-contract', topic: 'Information before the order', test: 'Before the order button: the main features, total price with VAT and delivery, payment and delivery terms, the right of withdrawal and its form, and the trader\'s identity are shown.', source: SOURCES.fagg4 }] : []),
    { key: 'legal:geo-blocking', topic: 'Access from other EU countries', test: 'Visitors from other EU countries are not blocked or redirected without consent because of their nationality or residence.', source: SOURCES.geo },
    { key: 'legal:rights', topic: 'Rights in the design', test: 'For every font, picture, icon and third-party trademark in the design, the licence or permission covers this use.', source: SOURCES.licence },
  ];
  return { kind: { site, shop, consent_banner: Boolean(banner), email }, reminders: out, manual, disclaimer: 'Reminders with their sources, not legal advice. Whether a rule applies depends on who offers what to whom; a person decides, and for anything uncertain, a lawyer.' };
}
