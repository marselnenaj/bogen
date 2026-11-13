import type { ComplianceReport } from './run.ts';

/**
 * A draft accessibility statement (Erklärung zur Barrierefreiheit) from a check, in German and English, in the sections
 * of the model in Implementing Decision (EU) 2018/1523: compliance status, non-accessible content with reasons,
 * preparation (date and method), feedback and contact, and the enforcement procedure. Everything Bogen cannot know is
 * left as a field marked [Ausfüllen: ...] or [Fill in: ...], and the status is never better than the check allows.
 *
 * Enforcement under the WZG (§ 5): the complaint body of the FFG for federal bodies; under the BaFG (§ 35): reports to
 * the Sozialministeriumservice. Both checked on 2026-11-13.
 */

export type StatementLanguage = 'de' | 'en';
export type StatementLaw = 'wzg' | 'bafg' | 'none';
export interface StatementFields {
  organisation?: string;
  website?: string;
  contact?: string;
  law?: StatementLaw;
  /** Set when the content is an app. */
  app?: boolean;
}
export interface StatementDraft { language: StatementLanguage; markdown: string; html: string; open_fields: string[] }

const FFG_FORM = 'https://www.digitalbarrierefrei.at/de/beschwerdestelle/kontaktformular-beschwerdestelle';
const FFG_MAIL = 'beschwerdestelle-wzg@ffg.at';
const SMS_PAGE = 'https://www.sozialministeriumservice.gv.at/Marktueberwachung_digitale_Barrierefreiheit/Allgemeine_Informationen_zum_Barrierefreiheitsgesetz/Allgemeine-Informationen-zum-Barrierefreiheitsgesetz.de.html';

const T = {
  de: {
    title: 'Erklärung zur Barrierefreiheit',
    fill: (what: string) => `[Ausfüllen: ${what}]`,
    org: 'Name der Stelle oder des Unternehmens', site: 'Adresse der Website oder Name der App', contact: 'E-Mail-Adresse oder Formular für Rückmeldungen', reason: 'Grund: Unvereinbarkeit, unverhältnismäßige Belastung oder nicht im Anwendungsbereich', alt: 'barrierefreie Alternative, falls vorhanden', review: 'Datum der letzten Überprüfung', tester: 'wer geprüft hat', land: 'Beschwerdestelle des Landes, für Stellen eines Landes',
    intro: (org: string, site: string, law: StatementLaw) => `${org} ist bemüht, ${law === 'bafg' ? 'ihre Dienstleistung' : 'ihre Website'} ${law === 'wzg' ? 'im Einklang mit dem Web-Zugänglichkeits-Gesetz (WZG) ' : law === 'bafg' ? 'im Einklang mit dem Barrierefreiheitsgesetz (BaFG) ' : ''}barrierefrei zugänglich zu machen. Diese Erklärung gilt für ${site}.`,
    status: 'Stand der Vereinbarkeit mit den Anforderungen',
    full: (std: string) => `Diese Website ist mit ${std} vollständig vereinbar.`,
    partly: (std: string) => `Diese Website ist wegen der folgenden Unvereinbarkeiten mit ${std} teilweise vereinbar.`,
    not: (std: string) => `Diese Website ist mit ${std} nicht vereinbar. Die Unvereinbarkeiten sind unten aufgeführt.`,
    open: (std: string, n: number) => `[Ausfüllen nach der Prüfung durch eine Person: vollständig, teilweise oder nicht vereinbar mit ${std}. ${n} Kriterien sind noch offen.]`,
    content: 'Nicht barrierefreie Inhalte', none: 'Die automatischen Prüfungen haben keine Unvereinbarkeit gefunden.', openList: (n: number) => `[Ausfüllen: Ergebnisse der ${n} Kriterien, die noch eine Person prüfen muss.]`,
    prep: 'Erstellung dieser Erklärung',
    prepText: (date: string, by: string) => `Diese Erklärung wurde am ${date} erstellt. Methode: Selbstbewertung, unterstützt durch die automatischen Prüfungen von Bogen und die Prüfung durch ${by}.`,
    lastReview: 'Letzte Überprüfung',
    feedback: 'Feedback und Kontaktangaben',
    feedbackText: (contact: string) => `Sind Ihnen Mängel bei der Barrierefreiheit aufgefallen, oder brauchen Sie Inhalte, die nicht barrierefrei sind, in anderer Form? Schreiben Sie uns: ${contact}. Wir prüfen Ihre Meldung und antworten innerhalb von zwei Monaten.`,
    enforcement: 'Durchsetzungsverfahren',
    wzg: `Wenn Sie auf Ihre Meldung keine zufriedenstellende Antwort erhalten, können Sie sich mit einer Beschwerde an die Beschwerdestelle der FFG (Österreichische Forschungsförderungsgesellschaft mbH) wenden. Beschwerden werden über das Kontaktformular angenommen: ${FFG_FORM} (bei Problemen mit dem Formular: ${FFG_MAIL}).`,
    bafg: `Wenn Sie meinen, dass diese Dienstleistung die Anforderungen an die Barrierefreiheit nicht erfüllt, können Sie das dem Sozialministeriumservice als Marktüberwachungsbehörde melden: ${SMS_PAGE}`,
    noneLaw: '[Ausfüllen: Stelle, an die man sich wenden kann, wenn die Antwort nicht genügt]',
    draft: 'Entwurf von Bogen. Bitte prüfen und die markierten Felder ausfüllen, bevor Sie die Erklärung veröffentlichen. Keine Rechtsberatung.',
  },
  en: {
    title: 'Accessibility statement',
    fill: (what: string) => `[Fill in: ${what}]`,
    org: 'name of the body or company', site: 'address of the website or name of the app', contact: 'e-mail address or form for feedback', reason: 'reason: non-compliance, disproportionate burden, or out of scope', alt: 'accessible alternative, if there is one', review: 'date of the last review', tester: 'who tested', land: 'complaint body of the Land, for bodies of a Land',
    intro: (org: string, site: string, law: StatementLaw) => `${org} is committed to making ${law === 'bafg' ? 'its service' : 'its website'} accessible${law === 'wzg' ? ' in accordance with the Austrian Web Accessibility Act (Web-Zugänglichkeits-Gesetz, WZG)' : law === 'bafg' ? ' in accordance with the Austrian Accessibility Act (Barrierefreiheitsgesetz, BaFG)' : ''}. This statement applies to ${site}.`,
    status: 'Compliance status',
    full: (std: string) => `This website is fully compliant with ${std}.`,
    partly: (std: string) => `This website is partially compliant with ${std} due to the non-compliances listed below.`,
    not: (std: string) => `This website is not compliant with ${std}. The non-compliances are listed below.`,
    open: (std: string, n: number) => `[Fill in after a person has tested: fully, partially or not compliant with ${std}. ${n} criteria are still open.]`,
    content: 'Non-accessible content', none: 'The automated checks found no non-compliance.', openList: (n: number) => `[Fill in: results of the ${n} criteria a person still has to test.]`,
    prep: 'Preparation of this statement',
    prepText: (date: string, by: string) => `This statement was prepared on ${date}. Method: self-assessment, supported by Bogen's automated checks and testing by ${by}.`,
    lastReview: 'Last reviewed',
    feedback: 'Feedback and contact information',
    feedbackText: (contact: string) => `Have you found an accessibility problem, or do you need content that is not accessible in another form? Write to us: ${contact}. We look into every report and answer within two months.`,
    enforcement: 'Enforcement procedure',
    wzg: `If you do not get a satisfactory answer, you can file a complaint with the complaint body at the FFG (Austrian Research Promotion Agency). Complaints are accepted through its contact form: ${FFG_FORM} (for problems with the form: ${FFG_MAIL}).`,
    bafg: `If you think this service does not meet the accessibility requirements, you can report it to the Sozialministeriumservice, the market surveillance authority: ${SMS_PAGE}`,
    noneLaw: '[Fill in: where people can turn if the answer is not enough]',
    draft: 'Draft by Bogen. Check it and fill in the marked fields before you publish it. Not legal advice.',
  },
};

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function statementDraft(report: ComplianceReport, language: StatementLanguage, fields: StatementFields = {}): StatementDraft {
  const t = T[language];
  const law: StatementLaw = fields.law ?? (report.profile.id === 'wzg' ? 'wzg' : report.profile.id === 'eaa-bafg' ? 'bafg' : 'none');
  const open: string[] = [];
  const val = (v: string | undefined, label: string) => {
    if (v?.trim()) return v.trim();
    open.push(label);
    return t.fill(label);
  };
  const std = report.profile.id === 'wcag-2.2-aa' ? 'WCAG 2.2 AA' : report.profile.id === 'wcag-2.1-aa' ? 'WCAG 2.1 AA' : 'EN 301 549 V3.2.1 (WCAG 2.1 AA)';
  const failed = report.criteria.filter((c) => c.status === 'failed');
  const decided = report.criteria.filter((c) => c.status === 'failed' || c.status === 'passed').length;
  const s = report.score;
  const statusLine = s.overall === 'all-criteria-met' ? t.full(std) : failed.length ? (failed.length > decided / 2 ? t.not(std) : t.partly(std)) : t.open(std, s.counts.needs_person);
  if (s.overall === 'incomplete') open.push(language === 'de' ? 'Stand der Vereinbarkeit' : 'compliance status');
  const date = new Intl.DateTimeFormat(language === 'de' ? 'de-AT' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(report.checked_at);
  const people = s.person.by.length ? s.person.by.join(', ') : val(undefined, t.tester);
  const reasonLabel = t.reason;
  const items = failed.map((c) => {
    const first = c.evidence.find((e) => e.outcome === 'fail');
    return `WCAG ${c.id} ${c.name}${first ? `: ${first.message}` : ''} ${t.fill(reasonLabel)} ${t.fill(t.alt)}`;
  });
  if (failed.length) open.push(reasonLabel, t.alt);
  const enforcement = law === 'wzg' ? `${t.wzg} ${t.fill(t.land)}` : law === 'bafg' ? t.bafg : t.noneLaw;
  if (law === 'wzg') open.push(t.land);
  if (law === 'none') open.push(language === 'de' ? 'Durchsetzungsverfahren' : 'enforcement procedure');
  const org = val(fields.organisation, t.org);
  const site = val(fields.website, t.site);
  const contact = val(fields.contact, t.contact);
  const sections: [string, string[]][] = [
    ['', [t.intro(org, site, law)]],
    [t.status, [statusLine]],
    [t.content, items.length ? items : [s.counts.needs_person ? t.openList(s.counts.needs_person) : t.none]],
    [t.prep, [t.prepText(date, people), `${t.lastReview}: ${val(undefined, t.review)}`]],
    [t.feedback, [t.feedbackText(contact)]],
    [t.enforcement, [enforcement]],
  ];
  const md = [`# ${t.title}`, '', `> ${t.draft}`, '', ...sections.flatMap(([h, body]) => [...(h ? [`## ${h}`, ''] : []), ...(h === t.content && items.length ? body.map((b) => `- ${b}`) : body), ''])].join('\n');
  const mark = (s: string) => escape(s).replace(/\[(Ausfüllen|Fill in)([^\]]*)\]/g, '<mark>[$1$2]</mark>');
  const html = `<article lang="${language}" class="statement"><h1>${escape(t.title)}</h1><p class="draft">${escape(t.draft)}</p>${sections.map(([h, body]) => `${h ? `<h2>${escape(h)}</h2>` : ''}${h === t.content && items.length ? `<ul>${body.map((b) => `<li>${mark(b)}</li>`).join('')}</ul>` : body.map((b) => `<p>${mark(b)}</p>`).join('')}`).join('')}</article>`;
  return { language, markdown: md, html, open_fields: [...new Set(open)] };
}
