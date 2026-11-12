import { eachAxis, el, icon, ICONS, text, type Css } from './markup.ts';
import type { Kit, KitComponent, KitProp, Variant } from './types.ts';

/**
 * shadcn/ui (MIT, shadcn): its components as its public docs show them, drawn by Bogen with inline styles over
 * shadcn's own CSS variables (`--background`, `--primary`, `--radius` and the rest) and their light and dark
 * values. Code handoff writes what `npx shadcn add` puts in a project: `@/components/ui/<name>`.
 */
const v = (name: string) => `var(--${name})`;
const RADIUS = { sm: 'calc(var(--radius) - 4px)', md: 'calc(var(--radius) - 2px)', lg: v('radius'), xl: 'calc(var(--radius) + 4px)' };
const FONT = { fontFamily: v('font-sans'), fontSize: '14px', lineHeight: '20px', color: v('foreground') } as const;
const SHADOW_XS = '0 1px 2px 0 rgb(0 0 0 / 0.05)';
const SHADOW_SM = '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)';
const SHADOW_MD = '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)';
const SHADOW_LG = '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)';
const ui = (file: string) => `@/components/ui/${file}`;

const BUTTON_LOOKS: Record<string, Css> = {
  default: { background: v('primary'), color: v('primary-foreground'), boxShadow: SHADOW_XS },
  secondary: { background: v('secondary'), color: v('secondary-foreground'), boxShadow: SHADOW_XS },
  outline: { background: v('background'), color: v('foreground'), border: `1px solid ${v('border')}`, boxShadow: SHADOW_XS },
  ghost: { background: 'transparent', color: v('foreground') },
  destructive: { background: v('destructive'), color: '#ffffff', boxShadow: SHADOW_XS },
  link: { background: 'transparent', color: v('primary'), textDecoration: 'underline', textUnderlineOffset: '4px' },
};
const BUTTON_SIZES: Record<string, Css> = {
  default: { height: '36px', padding: '8px 16px', gap: '8px' },
  sm: { height: '32px', padding: '0 12px', gap: '6px' },
  lg: { height: '40px', padding: '0 24px', gap: '8px' },
  icon: { width: '36px', height: '36px', padding: '0' },
};

function button(variant: Variant): string {
  const size = variant.size!;
  const css: Css = { ...FONT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', borderRadius: RADIUS.md, fontWeight: 500, whiteSpace: 'nowrap', flex: 'none', border: '1px solid transparent', ...BUTTON_LOOKS[variant.variant!], ...BUTTON_SIZES[size] };
  const body = size === 'icon' ? icon(ICONS.chevronRight, 16) : text('span', {}, 'Button', 'Label');
  return el('button', css, body, { type: 'button' });
}

function badge(variant: Variant): string {
  const look: Record<string, Css> = {
    default: { background: v('primary'), color: v('primary-foreground') },
    secondary: { background: v('secondary'), color: v('secondary-foreground') },
    destructive: { background: v('destructive'), color: '#ffffff' },
    outline: { color: v('foreground'), borderColor: v('border') },
  };
  return el('span', { ...FONT, display: 'inline-flex', alignItems: 'center', padding: '2px 8px', fontSize: '12px', lineHeight: '16px', fontWeight: 500, borderRadius: RADIUS.md, border: '1px solid transparent', flex: 'none', ...look[variant.variant!] }, text('span', {}, 'Badge', 'Label'));
}

const field = (extra: Css = {}): Css => ({ ...FONT, display: 'flex', alignItems: 'center', width: '280px', height: '36px', padding: '4px 12px', boxSizing: 'border-box', borderRadius: RADIUS.md, border: `1px solid ${v('input')}`, background: 'transparent', boxShadow: SHADOW_XS, ...extra });

function input(variant: Variant): string {
  const state: Css = variant.state === 'disabled' ? { opacity: 0.5 } : variant.state === 'invalid' ? { borderColor: v('destructive'), boxShadow: `0 0 0 3px color-mix(in oklch, ${v('destructive')} 20%, transparent)` } : {};
  return el('div', field(state), text('span', { color: v('muted-foreground') }, 'you@example.com', 'Placeholder'), { role: 'textbox' });
}

function textarea(): string {
  return el('div', field({ alignItems: 'flex-start', height: 'auto', minHeight: '64px', padding: '8px 12px' }), text('span', { color: v('muted-foreground') }, 'Type your message here.', 'Placeholder'), { role: 'textbox' });
}

function label(): string {
  return text('label', { ...FONT, fontWeight: 500, lineHeight: '14px' }, 'Email', 'Text');
}

function checkbox(variant: Variant): string {
  const on = variant.checked === 'true';
  const box = el('span', { width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: '4px', border: `1px solid ${on ? v('primary') : v('input')}`, background: on ? v('primary') : 'transparent', color: v('primary-foreground'), boxShadow: SHADOW_XS, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, on ? icon(ICONS.check, 14, 'Check', 3) : '', { 'data-name': 'Box', role: 'checkbox' });
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 500 }, [box, text('span', {}, 'Accept terms and conditions', 'Label')]);
}

function switchControl(variant: Variant): string {
  const on = variant.checked === 'true';
  const track = el('span', { width: '32px', height: '18px', boxSizing: 'border-box', borderRadius: '999px', border: '1px solid transparent', background: on ? v('primary') : v('input'), display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', flex: 'none', boxShadow: SHADOW_XS }, el('span', { width: '16px', height: '16px', borderRadius: '999px', background: on ? v('primary-foreground') : v('background') }, [], { 'data-name': 'Thumb' }), { 'data-name': 'Track', role: 'switch' });
  return el('label', { ...FONT, display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 500 }, [track, text('span', {}, 'Airplane mode', 'Label')]);
}

function radioGroup(): string {
  const item = (label: string, on: boolean, name: string) => el('label', { display: 'flex', alignItems: 'center', gap: '12px' }, [
    el('span', { width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: '999px', border: `1px solid ${on ? v('primary') : v('input')}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', boxShadow: SHADOW_XS }, on ? el('span', { width: '8px', height: '8px', borderRadius: '999px', background: v('primary') }) : '', { 'data-name': `${name} mark` }),
    text('span', {}, label, `${name} label`),
  ], { 'data-name': name });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '12px' }, [item('Default', true, 'Option 1'), item('Comfortable', false, 'Option 2'), item('Compact', false, 'Option 3')], { role: 'radiogroup' });
}

function select(): string {
  return el('div', field({ width: '180px', justifyContent: 'space-between', gap: '8px' }), [text('span', { color: v('muted-foreground') }, 'Select a fruit', 'Placeholder'), el('span', { display: 'flex', opacity: 0.5 }, icon(ICONS.chevronDown, 16))], { role: 'combobox' });
}

function tabs(): string {
  const trigger = (label: string, active: boolean, name: string) => el('span', { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '4px 8px', boxSizing: 'border-box', borderRadius: RADIUS.md, fontWeight: 500, color: active ? v('foreground') : v('muted-foreground'), background: active ? v('background') : 'transparent', boxShadow: active ? SHADOW_SM : undefined }, text('span', {}, label, `${name} label`), { 'data-name': name, role: 'tab' });
  return el('div', { ...FONT, display: 'flex', width: '400px', height: '36px', padding: '3px', boxSizing: 'border-box', borderRadius: RADIUS.lg, background: v('muted') }, [trigger('Account', true, 'Tab 1'), trigger('Password', false, 'Tab 2')], { role: 'tablist' });
}

function card(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '24px', width: '360px', padding: '24px 0', boxSizing: 'border-box', borderRadius: RADIUS.xl, border: `1px solid ${v('border')}`, background: v('card'), color: v('card-foreground'), boxShadow: SHADOW_SM }, [
    el('div', { display: 'flex', flexDirection: 'column', gap: '6px', padding: '0 24px' }, [
      text('div', { fontWeight: 600, lineHeight: '16px' }, 'Card title', 'Title'),
      text('div', { color: v('muted-foreground') }, 'Card description, with a slot for content below.', 'Description'),
    ], { 'data-name': 'Header' }),
    el('div', { display: 'flex', flexDirection: 'column', gap: '12px', padding: '0 24px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
  ]);
}

function alert(variant: Variant): string {
  const bad = variant.variant === 'destructive';
  return el('div', { ...FONT, display: 'flex', gap: '12px', width: '480px', padding: '12px 16px', boxSizing: 'border-box', borderRadius: RADIUS.lg, border: `1px solid ${v('border')}`, background: v('card'), color: bad ? v('destructive') : v('card-foreground') }, [
    el('span', { display: 'flex', paddingTop: '2px' }, icon(bad ? ICONS.alert : ICONS.circleCheck, 16)),
    el('div', { display: 'flex', flexDirection: 'column', gap: '2px' }, [
      text('div', { fontWeight: 500 }, bad ? 'Something went wrong' : 'Success! Your changes have been saved', 'Title'),
      text('div', { color: bad ? v('destructive') : v('muted-foreground'), opacity: bad ? 0.9 : undefined }, bad ? 'Your session has expired. Please log in again.' : 'This is an alert with an icon, a title and a description.', 'Description'),
    ]),
  ], { role: 'alert' });
}

function avatar(): string {
  return el('span', { ...FONT, width: '32px', height: '32px', borderRadius: '999px', background: v('muted'), display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flex: 'none' }, text('span', { fontSize: '12px' }, 'CN', 'Initials'));
}

function separator(): string {
  return el('div', { width: '240px', height: '1px', background: v('border'), flex: 'none' }, [], { role: 'separator' });
}

function progress(variant: Variant): string {
  return el('div', { width: '320px', height: '8px', borderRadius: '999px', background: `color-mix(in oklch, ${v('primary')} 20%, transparent)`, overflow: 'hidden', display: 'flex', flex: 'none' }, el('div', { width: `${variant.value}%`, height: '100%', background: v('primary') }, [], { 'data-name': 'Indicator' }), { role: 'progressbar' });
}

function slider(): string {
  return el('div', { position: 'relative', width: '320px', height: '16px', display: 'flex', alignItems: 'center', flex: 'none' }, [
    el('div', { flex: '1', height: '6px', borderRadius: '999px', background: v('muted'), overflow: 'hidden', display: 'flex' }, el('div', { width: '50%', height: '100%', background: v('primary') }, [], { 'data-name': 'Range' }), { 'data-name': 'Track' }),
    el('span', { position: 'absolute', left: 'calc(50% - 8px)', top: '0', width: '16px', height: '16px', boxSizing: 'border-box', borderRadius: '999px', border: `1px solid ${v('primary')}`, background: v('background'), boxShadow: SHADOW_SM }, [], { 'data-name': 'Thumb' }),
  ], { role: 'slider' });
}

function skeleton(): string {
  const bone = (css: Css, name: string) => el('div', { background: v('accent'), borderRadius: RADIUS.md, ...css }, [], { 'data-name': name });
  return el('div', { display: 'flex', alignItems: 'center', gap: '16px' }, [
    bone({ width: '48px', height: '48px', borderRadius: '999px' }, 'Circle'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [bone({ width: '250px', height: '16px' }, 'Line 1'), bone({ width: '200px', height: '16px' }, 'Line 2')]),
  ]);
}

function tooltip(): string {
  return el('div', { ...FONT, fontSize: '12px', lineHeight: '16px', padding: '6px 12px', borderRadius: RADIUS.md, background: v('primary'), color: v('primary-foreground'), flex: 'none' }, text('span', {}, 'Add to library', 'Text'), { role: 'tooltip' });
}

function dialog(): string {
  const btn = (label: string, look: string, name: string) => el('span', { display: 'inline-flex', alignItems: 'center', height: '36px', padding: '0 16px', boxSizing: 'border-box', borderRadius: RADIUS.md, fontWeight: 500, border: '1px solid transparent', ...BUTTON_LOOKS[look] }, text('span', {}, label, `${name} label`), { 'data-name': name });
  return el('div', { ...FONT, position: 'relative', display: 'flex', flexDirection: 'column', gap: '16px', width: '425px', padding: '24px', boxSizing: 'border-box', borderRadius: RADIUS.lg, border: `1px solid ${v('border')}`, background: v('background'), boxShadow: SHADOW_LG }, [
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [
      text('div', { fontSize: '18px', lineHeight: '18px', fontWeight: 600 }, 'Edit profile', 'Title'),
      text('div', { color: v('muted-foreground') }, 'Make changes to your profile here. Click save when you\'re done.', 'Description'),
    ], { 'data-name': 'Header' }),
    el('div', { display: 'flex', flexDirection: 'column', gap: '12px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
    el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px' }, [btn('Cancel', 'outline', 'Cancel'), btn('Save changes', 'default', 'Action')], { 'data-name': 'Footer' }),
    el('span', { position: 'absolute', top: '16px', right: '16px', display: 'flex', opacity: 0.7 }, icon(ICONS.x, 16, 'Close')),
  ], { role: 'dialog' });
}

function dropdownMenu(): string {
  const item = (label: string, name: string, active = false) => text('div', { padding: '6px 8px', borderRadius: RADIUS.sm, background: active ? v('accent') : 'transparent', color: active ? v('accent-foreground') : v('popover-foreground') }, label, name);
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '224px', padding: '4px', boxSizing: 'border-box', borderRadius: RADIUS.md, border: `1px solid ${v('border')}`, background: v('popover'), color: v('popover-foreground'), boxShadow: SHADOW_MD }, [
    text('div', { padding: '6px 8px', fontWeight: 500 }, 'My Account', 'Heading'),
    el('div', { height: '1px', margin: '4px -4px', background: v('border') }, [], { 'data-name': 'Separator' }),
    item('Profile', 'Item 1', true), item('Billing', 'Item 2'), item('Settings', 'Item 3'), item('Log out', 'Item 4'),
  ], { role: 'menu' });
}

function toggle(variant: Variant): string {
  const on = variant.pressed === 'true';
  const outline = variant.variant === 'outline';
  return el('button', { ...FONT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '36px', minWidth: '36px', padding: '0 8px', boxSizing: 'border-box', borderRadius: RADIUS.md, fontWeight: 500, border: outline ? `1px solid ${v('input')}` : '1px solid transparent', background: on ? v('accent') : 'transparent', color: on ? v('accent-foreground') : v('foreground'), boxShadow: outline ? SHADOW_XS : undefined, flex: 'none' }, [icon(ICONS.star, 16), text('span', {}, 'Star', 'Label')], { type: 'button' });
}

function table(): string {
  const cell = (value: string, head: boolean, name: string, right = false) => text(head ? 'th' : 'td', { padding: head ? '0 8px' : '8px', height: head ? '40px' : undefined, textAlign: right ? 'right' : 'left', fontWeight: head ? 500 : 400, color: head ? v('muted-foreground') : v('foreground'), borderBottom: `1px solid ${v('border')}` }, value, name);
  const rows = [['INV001', 'Paid', 'Credit Card', '$250.00'], ['INV002', 'Pending', 'PayPal', '$150.00'], ['INV003', 'Unpaid', 'Bank Transfer', '$350.00']];
  return el('table', { ...FONT, width: '520px', borderCollapse: 'collapse' }, [
    el('thead', {}, el('tr', {}, ['Invoice', 'Status', 'Method', 'Amount'].map((h, i) => cell(h, true, `Head ${i + 1}`, i === 3)))),
    el('tbody', {}, rows.map((row, r) => el('tr', {}, row.map((x, i) => cell(x, false, `Cell ${r + 1}.${i + 1}`, i === 3))))),
  ]);
}

function breadcrumb(): string {
  const sep = (n: number) => el('span', { display: 'flex' }, icon(ICONS.chevronRight, 14, `Separator ${n}`));
  return el('nav', { ...FONT, display: 'flex', alignItems: 'center', gap: '8px', color: v('muted-foreground') }, [text('span', {}, 'Home', 'Item 1'), sep(1), text('span', {}, 'Components', 'Item 2'), sep(2), text('span', { color: v('foreground') }, 'Breadcrumb', 'Page')], { 'aria-label': 'breadcrumb' });
}

function pagination(): string {
  const link = (label: string, name: string, active = false) => el('span', { display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '36px', height: '36px', padding: '0 4px', boxSizing: 'border-box', borderRadius: RADIUS.md, border: active ? `1px solid ${v('border')}` : '1px solid transparent', background: active ? v('background') : 'transparent', boxShadow: active ? SHADOW_XS : undefined, fontWeight: 500 }, text('span', {}, label, `${name} label`), { 'data-name': name });
  const step = (label: string, ic: string, name: string, after: boolean) => el('span', { display: 'flex', alignItems: 'center', gap: '4px', height: '36px', padding: '0 10px', fontWeight: 500 }, after ? [text('span', {}, label, `${name} label`), icon(ic, 16)] : [icon(ic, 16), text('span', {}, label, `${name} label`)], { 'data-name': name });
  return el('nav', { ...FONT, display: 'flex', alignItems: 'center', gap: '4px' }, [step('Previous', ICONS.chevronLeft, 'Previous', false), link('1', 'Page 1'), link('2', 'Page 2', true), link('3', 'Page 3'), link('...', 'Ellipsis'), step('Next', ICONS.chevronRight, 'Next', true)], { 'aria-label': 'pagination' });
}

function accordion(): string {
  const item = (q: string, a: string | null, name: string, last = false) => el('div', { display: 'flex', flexDirection: 'column', borderBottom: last ? undefined : `1px solid ${v('border')}` }, [
    el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 0', fontWeight: 500 }, [text('span', {}, q, `${name} title`), el('span', { display: 'flex', color: v('muted-foreground') }, icon(a ? ICONS.chevronDown : ICONS.chevronRight, 16))]),
    a ? text('div', { paddingBottom: '16px' }, a, `${name} content`) : '',
  ], { 'data-name': name });
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', width: '400px' }, [item('Is it accessible?', 'Yes. It adheres to the WAI-ARIA design pattern.', 'Item 1'), item('Is it styled?', null, 'Item 2'), item('Is it animated?', null, 'Item 3', true)]);
}

function popover(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '8px', width: '288px', padding: '16px', boxSizing: 'border-box', borderRadius: RADIUS.md, border: `1px solid ${v('border')}`, background: v('popover'), color: v('popover-foreground'), boxShadow: SHADOW_MD }, [
    text('div', { fontWeight: 500, lineHeight: '16px' }, 'Dimensions', 'Title'),
    text('div', { color: v('muted-foreground') }, 'Set the dimensions for the layer.', 'Description'),
    el('div', { display: 'flex', flexDirection: 'column', gap: '8px' }, [], { 'data-name': 'Content', 'data-slot': 'content' }),
  ], { role: 'dialog' });
}

function toast(): string {
  return el('div', { ...FONT, display: 'flex', flexDirection: 'column', gap: '2px', width: '356px', padding: '16px', boxSizing: 'border-box', borderRadius: RADIUS.lg, border: `1px solid ${v('border')}`, background: v('popover'), color: v('popover-foreground'), boxShadow: SHADOW_LG, fontSize: '13px' }, [
    text('div', { fontWeight: 500 }, 'Event has been created', 'Title'),
    text('div', { color: v('muted-foreground') }, 'Sunday, December 03, 2023 at 9:00 AM', 'Description'),
  ], { role: 'status' });
}

const TEXT = (name: string, target: string): KitProp => ({ name, type: 'text', target });
const LABEL = [TEXT('label', 'Label')];
const BUTTON_AXES = { variant: ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'], size: ['default', 'sm', 'lg', 'icon'] };
const LABELLED = (file: string, name: string, control: string) => ({ from: ui(file), name, props: { checked: '', label: '' }, flags: { checked: { true: control } }, more: [{ from: ui('label'), imports: ['Label'] }] });

const components: KitComponent[] = [
  { name: 'Button', group: 'Actions', description: 'A button in six looks and four sizes, one of them a square for an icon.', axes: BUTTON_AXES, members: eachAxis(BUTTON_AXES), props: LABEL, html: button, handoff: { from: ui('button'), name: 'Button', props: { label: 'children' } } },
  { name: 'Toggle', group: 'Actions', description: 'A two-state button, plain or outlined.', axes: { variant: ['default', 'outline'], pressed: ['false', 'true'] }, props: LABEL, html: toggle, handoff: { from: ui('toggle'), name: 'Toggle', props: { pressed: '', label: '' }, flags: { pressed: { true: 'defaultPressed' } }, usage: '<Toggle aria-label="{{label}}"{{attrs}}>\n  <Star />\n  {{label}}\n</Toggle>', more: [{ from: 'lucide-react', imports: ['Star'] }] } },
  { name: 'Badge', group: 'Content', description: 'A small label for a status or a count.', axes: { variant: ['default', 'secondary', 'destructive', 'outline'] }, props: LABEL, html: badge, handoff: { from: ui('badge'), name: 'Badge', props: { label: 'children' } } },
  { name: 'Card', group: 'Content', description: 'A card with a title, a description and a slot for content.', props: [TEXT('title', 'Title'), TEXT('description', 'Description')], html: card, handoff: { from: ui('card'), name: 'Card', imports: ['CardContent', 'CardDescription', 'CardHeader', 'CardTitle'], props: { title: '', description: '' }, usage: '<Card{{attrs}}>\n  <CardHeader>\n    <CardTitle>{{title}}</CardTitle>\n    <CardDescription>{{description}}</CardDescription>\n  </CardHeader>\n  <CardContent>{{children}}</CardContent>\n</Card>' } },
  { name: 'Avatar', group: 'Content', description: 'A round image of a person, with initials as the fallback.', props: [TEXT('initials', 'Initials')], html: avatar, handoff: { from: ui('avatar'), name: 'Avatar', imports: ['AvatarFallback', 'AvatarImage'], props: { initials: '' }, usage: '<Avatar{{attrs}}>\n  <AvatarImage alt="" />\n  <AvatarFallback>{{initials}}</AvatarFallback>\n</Avatar>' } },
  { name: 'Separator', group: 'Content', description: 'A thin line between content.', html: separator, handoff: { from: ui('separator'), name: 'Separator' } },
  { name: 'Skeleton', group: 'Content', description: 'Placeholders while content loads.', html: skeleton, handoff: { from: ui('skeleton'), name: 'Skeleton', usage: '<div className="flex items-center gap-4"{{attrs}}>\n  <Skeleton className="h-12 w-12 rounded-full" />\n  <div className="space-y-2">\n    <Skeleton className="h-4 w-[250px]" />\n    <Skeleton className="h-4 w-[200px]" />\n  </div>\n</div>' } },
  { name: 'Table', group: 'Content', description: 'A table with a header row and rows.', html: table, handoff: { from: ui('table'), name: 'Table', imports: ['TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'], usage: '<Table{{attrs}}>\n  <TableHeader>\n    <TableRow>\n      <TableHead>Invoice</TableHead>\n      <TableHead>Status</TableHead>\n      <TableHead>Method</TableHead>\n      <TableHead className="text-right">Amount</TableHead>\n    </TableRow>\n  </TableHeader>\n  <TableBody>\n    <TableRow>\n      <TableCell>INV001</TableCell>\n      <TableCell>Paid</TableCell>\n      <TableCell>Credit Card</TableCell>\n      <TableCell className="text-right">$250.00</TableCell>\n    </TableRow>\n  </TableBody>\n</Table>' } },
  { name: 'Accordion', group: 'Content', description: 'Sections that open one at a time.', html: accordion, handoff: { from: ui('accordion'), name: 'Accordion', imports: ['AccordionContent', 'AccordionItem', 'AccordionTrigger'], usage: '<Accordion type="single" collapsible defaultValue="item-1"{{attrs}}>\n  <AccordionItem value="item-1">\n    <AccordionTrigger>Is it accessible?</AccordionTrigger>\n    <AccordionContent>Yes. It adheres to the WAI-ARIA design pattern.</AccordionContent>\n  </AccordionItem>\n  <AccordionItem value="item-2">\n    <AccordionTrigger>Is it styled?</AccordionTrigger>\n    <AccordionContent>Yes.</AccordionContent>\n  </AccordionItem>\n</Accordion>' } },
  { name: 'Input', group: 'Forms', description: 'A text input, with disabled and invalid states.', axes: { state: ['default', 'disabled', 'invalid'] }, props: [TEXT('placeholder', 'Placeholder')], html: input, handoff: { from: ui('input'), name: 'Input', props: { placeholder: 'placeholder', state: '' }, flags: { state: { disabled: 'disabled', invalid: 'aria-invalid="true"' } } } },
  { name: 'Textarea', group: 'Forms', description: 'A text input of several lines.', props: [TEXT('placeholder', 'Placeholder')], html: textarea, handoff: { from: ui('textarea'), name: 'Textarea', props: { placeholder: 'placeholder' } } },
  { name: 'Label', group: 'Forms', description: 'The label of a form control.', props: [TEXT('text', 'Text')], html: label, handoff: { from: ui('label'), name: 'Label', props: { text: 'children' } } },
  { name: 'Checkbox', group: 'Forms', description: 'A checkbox with its label.', axes: { checked: ['false', 'true'] }, props: LABEL, html: checkbox, handoff: { ...LABELLED('checkbox', 'Checkbox', 'defaultChecked'), usage: '<div className="flex items-center gap-2">\n  <Checkbox id="terms"{{attrs}} />\n  <Label htmlFor="terms">{{label}}</Label>\n</div>' } },
  { name: 'Switch', group: 'Forms', description: 'A switch with its label.', axes: { checked: ['false', 'true'] }, props: LABEL, html: switchControl, handoff: { ...LABELLED('switch', 'Switch', 'defaultChecked'), usage: '<div className="flex items-center gap-2">\n  <Switch id="airplane-mode"{{attrs}} />\n  <Label htmlFor="airplane-mode">{{label}}</Label>\n</div>' } },
  { name: 'Radio group', group: 'Forms', description: 'A set of options of which one is chosen.', html: radioGroup, handoff: { from: ui('radio-group'), name: 'RadioGroup', imports: ['RadioGroupItem'], more: [{ from: ui('label'), imports: ['Label'] }], usage: '<RadioGroup defaultValue="default"{{attrs}}>\n  <div className="flex items-center gap-3">\n    <RadioGroupItem value="default" id="r1" />\n    <Label htmlFor="r1">Default</Label>\n  </div>\n  <div className="flex items-center gap-3">\n    <RadioGroupItem value="comfortable" id="r2" />\n    <Label htmlFor="r2">Comfortable</Label>\n  </div>\n  <div className="flex items-center gap-3">\n    <RadioGroupItem value="compact" id="r3" />\n    <Label htmlFor="r3">Compact</Label>\n  </div>\n</RadioGroup>' } },
  { name: 'Select', group: 'Forms', description: 'A closed select with its placeholder.', props: [TEXT('placeholder', 'Placeholder')], html: select, handoff: { from: ui('select'), name: 'Select', imports: ['SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue'], props: { placeholder: '' }, usage: '<Select{{attrs}}>\n  <SelectTrigger className="w-[180px]">\n    <SelectValue placeholder="{{placeholder}}" />\n  </SelectTrigger>\n  <SelectContent>\n    <SelectItem value="apple">Apple</SelectItem>\n    <SelectItem value="banana">Banana</SelectItem>\n  </SelectContent>\n</Select>' } },
  { name: 'Slider', group: 'Forms', description: 'A value picked along a track.', html: slider, handoff: { from: ui('slider'), name: 'Slider' } },
  { name: 'Tabs', group: 'Navigation', description: 'Tabs that switch between views.', html: tabs, handoff: { from: ui('tabs'), name: 'Tabs', imports: ['TabsContent', 'TabsList', 'TabsTrigger'], usage: '<Tabs defaultValue="account"{{attrs}}>\n  <TabsList>\n    <TabsTrigger value="account">Account</TabsTrigger>\n    <TabsTrigger value="password">Password</TabsTrigger>\n  </TabsList>\n  <TabsContent value="account">{{children}}</TabsContent>\n</Tabs>' } },
  { name: 'Breadcrumb', group: 'Navigation', description: 'Where the page is in the site.', html: breadcrumb, handoff: { from: ui('breadcrumb'), name: 'Breadcrumb', imports: ['BreadcrumbItem', 'BreadcrumbLink', 'BreadcrumbList', 'BreadcrumbPage', 'BreadcrumbSeparator'], usage: '<Breadcrumb{{attrs}}>\n  <BreadcrumbList>\n    <BreadcrumbItem>\n      <BreadcrumbLink href="/">Home</BreadcrumbLink>\n    </BreadcrumbItem>\n    <BreadcrumbSeparator />\n    <BreadcrumbItem>\n      <BreadcrumbLink href="/components">Components</BreadcrumbLink>\n    </BreadcrumbItem>\n    <BreadcrumbSeparator />\n    <BreadcrumbItem>\n      <BreadcrumbPage>Breadcrumb</BreadcrumbPage>\n    </BreadcrumbItem>\n  </BreadcrumbList>\n</Breadcrumb>' } },
  { name: 'Pagination', group: 'Navigation', description: 'Links between pages of a list.', html: pagination, handoff: { from: ui('pagination'), name: 'Pagination', imports: ['PaginationContent', 'PaginationEllipsis', 'PaginationItem', 'PaginationLink', 'PaginationNext', 'PaginationPrevious'], usage: '<Pagination{{attrs}}>\n  <PaginationContent>\n    <PaginationItem><PaginationPrevious href="#" /></PaginationItem>\n    <PaginationItem><PaginationLink href="#">1</PaginationLink></PaginationItem>\n    <PaginationItem><PaginationLink href="#" isActive>2</PaginationLink></PaginationItem>\n    <PaginationItem><PaginationLink href="#">3</PaginationLink></PaginationItem>\n    <PaginationItem><PaginationEllipsis /></PaginationItem>\n    <PaginationItem><PaginationNext href="#" /></PaginationItem>\n  </PaginationContent>\n</Pagination>' } },
  { name: 'Dropdown menu', group: 'Overlays', description: 'An open menu with a heading and items.', html: dropdownMenu, handoff: { from: ui('dropdown-menu'), name: 'DropdownMenu', imports: ['DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuLabel', 'DropdownMenuSeparator', 'DropdownMenuTrigger'], more: [{ from: ui('button'), imports: ['Button'] }], usage: '<DropdownMenu{{attrs}}>\n  <DropdownMenuTrigger asChild>\n    <Button variant="outline">Open</Button>\n  </DropdownMenuTrigger>\n  <DropdownMenuContent className="w-56">\n    <DropdownMenuLabel>My Account</DropdownMenuLabel>\n    <DropdownMenuSeparator />\n    <DropdownMenuItem>Profile</DropdownMenuItem>\n    <DropdownMenuItem>Billing</DropdownMenuItem>\n    <DropdownMenuItem>Settings</DropdownMenuItem>\n    <DropdownMenuItem>Log out</DropdownMenuItem>\n  </DropdownMenuContent>\n</DropdownMenu>' } },
  { name: 'Dialog', group: 'Overlays', description: 'A dialog with a title, a description, a slot and its buttons.', props: [TEXT('title', 'Title'), TEXT('description', 'Description'), TEXT('action', 'Action label')], html: dialog, handoff: { from: ui('dialog'), name: 'Dialog', imports: ['DialogClose', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle'], more: [{ from: ui('button'), imports: ['Button'] }], props: { title: '', description: '', action: '' }, usage: '<Dialog open{{attrs}}>\n  <DialogContent className="sm:max-w-[425px]">\n    <DialogHeader>\n      <DialogTitle>{{title}}</DialogTitle>\n      <DialogDescription>{{description}}</DialogDescription>\n    </DialogHeader>\n    {{children}}\n    <DialogFooter>\n      <DialogClose asChild>\n        <Button variant="outline">Cancel</Button>\n      </DialogClose>\n      <Button type="submit">{{action}}</Button>\n    </DialogFooter>\n  </DialogContent>\n</Dialog>' } },
  { name: 'Popover', group: 'Overlays', description: 'A small panel next to what opened it, with a slot.', props: [TEXT('title', 'Title'), TEXT('description', 'Description')], html: popover, handoff: { from: ui('popover'), name: 'Popover', imports: ['PopoverContent', 'PopoverTrigger'], props: { title: '', description: '' }, usage: '<Popover open{{attrs}}>\n  <PopoverTrigger>Open</PopoverTrigger>\n  <PopoverContent className="w-72">\n    <h4 className="leading-none font-medium">{{title}}</h4>\n    <p className="text-muted-foreground text-sm">{{description}}</p>\n    {{children}}\n  </PopoverContent>\n</Popover>' } },
  { name: 'Tooltip', group: 'Overlays', description: 'A short hint on hover.', props: [TEXT('text', 'Text')], html: tooltip, handoff: { from: ui('tooltip'), name: 'Tooltip', imports: ['TooltipContent', 'TooltipProvider', 'TooltipTrigger'], props: { text: '' }, usage: '<TooltipProvider>\n  <Tooltip{{attrs}}>\n    <TooltipTrigger>Hover</TooltipTrigger>\n    <TooltipContent>{{text}}</TooltipContent>\n  </Tooltip>\n</TooltipProvider>' } },
  { name: 'Progress', group: 'Feedback', description: 'How far something has come.', axes: { value: ['60', '30', '100'] }, html: progress, handoff: { from: ui('progress'), name: 'Progress', props: { value: '' }, flags: { value: { 60: 'value={60}', 30: 'value={30}', 100: 'value={100}' } } } },
  { name: 'Alert', group: 'Feedback', description: 'A message with an icon, a title and a description.', axes: { variant: ['default', 'destructive'] }, props: [TEXT('title', 'Title'), TEXT('description', 'Description')], html: alert, handoff: { from: ui('alert'), name: 'Alert', imports: ['AlertDescription', 'AlertTitle'], props: { title: '', description: '' }, usage: '<Alert{{attrs}}>\n  <AlertTitle>{{title}}</AlertTitle>\n  <AlertDescription>{{description}}</AlertDescription>\n</Alert>' } },
  { name: 'Toast', group: 'Feedback', description: 'A notification as Sonner shows it. In code it is a call, so the handoff places the Toaster.', props: [TEXT('title', 'Title'), TEXT('description', 'Description')], html: toast, handoff: { from: ui('sonner'), name: 'Toaster', props: { title: '', description: '' } } },
];

const color = (name: string, light: string, dark: string, role?: Kit['tokens'][number]['role']) => ({ name, kind: 'color' as const, light, dark, ...(role ? { role } : {}) });

export const shadcnKit: Kit = {
  id: 'shadcn',
  name: 'shadcn/ui',
  description: 'The shadcn/ui components with its CSS variables, in its light and dark themes.',
  platform: 'web',
  library: { name: 'shadcn/ui', package: 'shadcn', license: 'MIT', url: 'https://ui.shadcn.com' },
  font: 'Inter, ui-sans-serif, system-ui, sans-serif',
  version: 2,
  tokens: [
    color('background', 'oklch(1 0 0)', 'oklch(0.145 0 0)', 'background'),
    color('foreground', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)', 'foreground'),
    color('card', 'oklch(1 0 0)', 'oklch(0.205 0 0)', 'surface'),
    color('card-foreground', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)'),
    color('popover', 'oklch(1 0 0)', 'oklch(0.205 0 0)'),
    color('popover-foreground', 'oklch(0.145 0 0)', 'oklch(0.985 0 0)'),
    color('primary', 'oklch(0.205 0 0)', 'oklch(0.922 0 0)', 'primary'),
    color('primary-foreground', 'oklch(0.985 0 0)', 'oklch(0.205 0 0)', 'on-primary'),
    color('secondary', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)', 'secondary'),
    color('secondary-foreground', 'oklch(0.205 0 0)', 'oklch(0.985 0 0)'),
    color('muted', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)', 'muted'),
    color('muted-foreground', 'oklch(0.556 0 0)', 'oklch(0.708 0 0)'),
    color('accent', 'oklch(0.97 0 0)', 'oklch(0.269 0 0)', 'accent'),
    color('accent-foreground', 'oklch(0.205 0 0)', 'oklch(0.985 0 0)'),
    color('destructive', 'oklch(0.577 0.245 27.325)', 'oklch(0.704 0.191 22.216)', 'danger'),
    color('border', 'oklch(0.922 0 0)', 'oklch(1 0 0 / 10%)', 'border'),
    color('input', 'oklch(0.922 0 0)', 'oklch(1 0 0 / 15%)'),
    color('ring', 'oklch(0.708 0 0)', 'oklch(0.556 0 0)'),
    { name: 'radius', kind: 'radius', light: '0.625rem', role: 'radius' },
    { name: 'font-sans', kind: 'font-family', light: 'Inter, ui-sans-serif, system-ui, sans-serif', role: 'font' },
  ],
  components,
};

/**
 * shadcn/ui on Base UI (`npx shadcn init --base base`, and the base `shadcn init --defaults` picks): the same
 * components, files and props, with Base UI's own API where it differs from Radix. A trigger takes another
 * element through `render` rather than `asChild`, an accordion's open items are a list and it has no `type`, and
 * a menu's label sits in a group. Checked against the components `shadcn add` writes for both bases.
 */
const BASE_UI_USAGE: Record<string, string> = {
  Accordion: '<Accordion defaultValue={["item-1"]}{{attrs}}>\n  <AccordionItem value="item-1">\n    <AccordionTrigger>Is it accessible?</AccordionTrigger>\n    <AccordionContent>Yes. It adheres to the WAI-ARIA design pattern.</AccordionContent>\n  </AccordionItem>\n  <AccordionItem value="item-2">\n    <AccordionTrigger>Is it styled?</AccordionTrigger>\n    <AccordionContent>Yes.</AccordionContent>\n  </AccordionItem>\n</Accordion>',
  'Dropdown menu': '<DropdownMenu{{attrs}}>\n  <DropdownMenuTrigger render={<Button variant="outline" />}>Open</DropdownMenuTrigger>\n  <DropdownMenuContent className="w-56">\n    <DropdownMenuGroup>\n      <DropdownMenuLabel>My Account</DropdownMenuLabel>\n    </DropdownMenuGroup>\n    <DropdownMenuSeparator />\n    <DropdownMenuGroup>\n      <DropdownMenuItem>Profile</DropdownMenuItem>\n      <DropdownMenuItem>Billing</DropdownMenuItem>\n      <DropdownMenuItem>Settings</DropdownMenuItem>\n      <DropdownMenuItem>Log out</DropdownMenuItem>\n    </DropdownMenuGroup>\n  </DropdownMenuContent>\n</DropdownMenu>',
  // Radix's Tooltip throws without a TooltipProvider around it; Base UI's renders without one.
  Tooltip: '<Tooltip{{attrs}}>\n  <TooltipTrigger>Hover</TooltipTrigger>\n  <TooltipContent>{{text}}</TooltipContent>\n</Tooltip>',
  Dialog: '<Dialog open{{attrs}}>\n  <DialogContent className="sm:max-w-[425px]">\n    <DialogHeader>\n      <DialogTitle>{{title}}</DialogTitle>\n      <DialogDescription>{{description}}</DialogDescription>\n    </DialogHeader>\n    {{children}}\n    <DialogFooter>\n      <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>\n      <Button type="submit">{{action}}</Button>\n    </DialogFooter>\n  </DialogContent>\n</Dialog>',
};
const BASE_UI_IMPORTS: Record<string, string[]> = {
  Tooltip: ['TooltipContent', 'TooltipTrigger'],
  'Dropdown menu': ['DropdownMenuContent', 'DropdownMenuGroup', 'DropdownMenuItem', 'DropdownMenuLabel', 'DropdownMenuSeparator', 'DropdownMenuTrigger'],
};

export const shadcnBaseUiKit: Kit = {
  ...shadcnKit,
  id: 'shadcn-base-ui',
  name: 'shadcn/ui (Base UI)',
  description: 'The shadcn/ui components on Base UI, the default of shadcn init: the same look and CSS variables as shadcn/ui, with code in Base UI\'s API (render instead of asChild).',
  library: { name: 'shadcn/ui on Base UI', package: 'shadcn', license: 'MIT', url: 'https://ui.shadcn.com/docs/components' },
  components: components.map((c) => {
    const usage = BASE_UI_USAGE[c.name];
    const imports = BASE_UI_IMPORTS[c.name];
    return usage || imports ? { ...c, handoff: { ...c.handoff, ...(usage ? { usage } : {}), ...(imports ? { imports } : {}) } } : c;
  }),
};
