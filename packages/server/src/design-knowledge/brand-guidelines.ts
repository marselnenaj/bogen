import type { DesignPlaybook } from './playbooks.ts';
import type { DesignRecipe } from './types.ts';

/**
 * Brand guidelines as a studio would art-direct them: a book of fixed landscape pages with an argument, made from one
 * brand's own facts, marks and voice. The generated brand book (brand-book-html.ts) is one template for every brand;
 * this is the brief for the designed edition an agent makes from it (brand-edition.ts), and for any agent asked for a
 * guidelines book. Kept apart from the other playbooks so that they can change without touching each other.
 */

const lines = `
One idea per page | A page holds several topics | Give it one claim as the headline, in the brand's voice, and make the proof the largest thing on it | Say each page's point from its largest element | Split the page or cut the weaker topic | A spec page may be dense | Pages that say three things
An argument in order | Pages follow the data's order | Run cover, idea, logo, colour, type, voice, imagery, applications, rules; fold each opener into its first page | Read the headlines in order as one paragraph | Merge or reorder until they tell one story | A sparse brand gets a shorter arc, never filler | Contents page and ten dividers
The book in the brand | The book needs type, colour and a grid | Use the brand's families, type roles and confirmed palette in its real proportion; margins, folio and running head from its spacing | Every family and hex is in brand_get | Swap house fonts and colours for the brand's | Neutral paper and ink when it has none | Template with swatches pasted in
A layout per page | Pages share one skeleton | Compose each from what it shows: the mark full bleed, colour as fields, set text, voice as dialogue, an application at scale | No two neighbouring pages share a composition | Recompose around the evidence | Rules pages may share a system | One template twelve times
Applications from its world | Applications are planned | Draw two to four things its customers really meet, from its industry, examples, assets and voice, at true scale with its own copy | Each names its source | Read the recipes for archetypes | A person who hands out cards keeps one | Card, letterhead, tote bag
Its quirks on show | The book could belong to anyone | Give what only this brand does (an avoided word, a held-back colour, a crop) a page or a large detail | Name each page's quirk | Swap generic praise for its own odd rule | A quiet brand's quirk can be restraint | Interchangeable copy
Honest gaps | Data is missing | Leave it out or set it as an open question; never a made-up value, claim, licence, customer or figure | Every fact traces to brand_get, brand_book_get or an example | Remove or mark it | A labelled sample in a mock | Invented proof
Rules you can see | Rules are a wall of text | Draw each must as a small do and don't from the real mark or copy, with its reason | Each must has a picture and a reason | Draw the misuse | Soft rules can stay a list | Text-only rules
`;

const decisions = lines.trim().split('\n').map((line, i) => {
  const [title, when, action, check, repair, exception, failure] = line.split('|').map((s) => s.trim()) as [string, string, string, string, string, string, string];
  return { id: `brand-guidelines-${i + 1}`, title, when, action, check, repair: `${failure}: ${repair}`, exception, failure };
});

export const BRAND_GUIDELINES_PLAYBOOK: DesignPlaybook = {
  id: 'brand-guidelines',
  name: 'Brand guidelines books',
  aliases: ['designed edition', 'art-directed edition', 'guidelines book', 'markenhandbuch'],
  responsive: false,
  goal: 'Art-direct a brand\'s guidelines as a studio book: one argument in fixed landscape pages, made only from the brand\'s own facts, marks and voice.',
  ambition: [
    'A book with an argument: cover, idea, logo, colour, type, voice, imagery, applications and rules, each page one point you can say in a sentence, its proof the largest thing on it.',
    'Applications from this brand\'s own world, drawn from its data, assets, voice and examples: what its customers really meet, not the card and letter every book has.',
    'The quirks only this brand has, given room; everything it does not state left out or set as an open question.',
  ],
  brief: ['Brand data, assets, voice and examples', 'Who reads the book and what they make with it', 'What is missing and stays open', 'The language the brand writes in'],
  states: ['Cover', 'Chapter page', 'Dense reference page', 'Application spread', 'Short book for a sparse brand', 'Open question'],
  deliver: ['10 to 14 pages at 1280x800', 'The book\'s idea in a sentence', 'The open questions'],
  review: [
    'Can a reader say each page\'s point from its largest element?',
    'Does every value, claim and application trace to the brand\'s data, assets or examples?',
    'Would this book fit only this brand: its world, its voice, its quirks?',
  ].map((question, i) => ({ id: (['priority', 'content', 'context'] as const)[i]!, question })),
  decisions,
};

function recipe(id: string, name: string, useWhen: string, sequence: string[], requiredContent: string[], avoid: string[]): DesignRecipe {
  return { id, discipline: 'brand-guidelines', name, useWhen, sequence, requiredContent, avoid, sources: [], evidence: 'synthesis' };
}

/** The book's arc, and applications by the kind of business, to choose from, not to fill in. */
export const BRAND_GUIDELINES_RECIPES: readonly DesignRecipe[] = [
  recipe('studio-book-arc', 'Studio book arc', 'The book in 10 to 14 pages, in order.', [
    'Cover: the mark large, cropped or in use, the name, one line in the brand\'s voice; no "Brand guidelines" label as the hero',
    'Idea: the one sentence the brand stands for, from its positioning, with what proves it',
    'Logo: the mark at scale; clear space and minimum size measured on the mark; misuse drawn from the real mark',
    'Colour: the palette as fields in its real proportion, each with role, values and token; the pairs that pass and the one that fails',
    'Type: a composed page in the brand\'s own hierarchy first, then the scale with sizes and roles',
    'Voice: how it speaks, its own examples set as an exchange, the words it avoids with what it says instead',
    'Imagery: what its pictures show and how they are treated; an open question when the brand has none',
    'Applications: two to four spreads of real touchpoints at scale, one per page',
    'Rules: the musts as drawn do and don\'t, each with its reason',
    'Close: open questions, version and date',
  ], ['brand_get', 'brand_book_get chapters', 'brand assets and examples', 'The generated book as a reference'], ['A contents page and a divider per chapter', 'Pages that only list values', 'The same two-column skeleton on every page']),
  recipe('applications-services', 'Applications: professional services', 'Consultants, studios, agencies, practices.', [
    'An offer or proposal: cover and one inside page with the brand\'s own service names',
    'An invoice or quote, figures labelled sample',
    'An email and its signature, written in the brand\'s voice and address',
    'A talk slide or a social post with one claim from the positioning',
  ], ['Services and positioning', 'Voice examples', 'Name and contact as the brand states them'], ['Invented clients or case results', 'A tote bag']),
  recipe('applications-software', 'Applications: software and tools', 'Apps, developer tools, online services.', [
    'The product\'s own screen at full size, in the brand, from an example or a capture',
    'An empty state or onboarding step, its copy in the voice',
    'A release note, changelog or docs page',
    'The app icon and a social card at their delivery sizes',
  ], ['Product screens or captures', 'Voice and words', 'Logo variants'], ['A laptop mock-up with a made-up dashboard', 'Feature claims the brand does not make']),
  recipe('applications-places', 'Applications: hospitality, shops and places', 'Cafés, shops, hotels, venues, products.', [
    'A menu, price list or label with real items labelled sample',
    'Signage or a window at the street',
    'Packaging, a bag or a receipt',
    'A post from the place in its voice',
  ], ['Products or menu items', 'Address and opening hours as stated', 'Imagery rules'], ['Invented prices presented as real', 'Stock lifestyle photography']),
  recipe('applications-public', 'Applications: public bodies, associations and schools', 'Offices, associations, NGOs, schools.', [
    'A form or a notice in plain language',
    'A letter with a decision and what to do next',
    'Signage and wayfinding',
    'An event poster or a service page',
  ], ['Services and audiences', 'Language level and address', 'Accessibility rules'], ['Marketing slogans on a legal notice', 'Low-contrast signage']),
  recipe('sparse-brand-book', 'Short honest book', 'The brand holds little: a name, a few colours.', [
    'Cover: the name set in its own family, large',
    'What the brand states, on one page, in its own words',
    'Colour and type as far as they are known',
    'One application that uses only known values',
    'Open questions: what the person decides next',
  ], ['Everything brand_get returns', 'What brand_book_get marks as open'], ['Filling pages with invented rules', 'Placeholder applications']),
];
