import { APP_LIMITS } from './app-checks.ts';

/**
 * guide_get apps: how a phone app screen is built so that it reads as made by a senior product designer. Numbers, not
 * adjectives, because what goes wrong on app screens is measurable: a 98pt tab bar, a button in the home indicator
 * strip, 14 next to 16, a third of the screen empty. The direction (idea, type, colour) stays the agent's own.
 */
export const APPS_GUIDE = `Measure spacing, alignment and targets from the canvas_screenshot layout map; use the small picture for the impression. Check edits with map_only and take a picture for the first and the final look; detail full gives a large picture.

App screens (iPhone and Android)

Native first, brand second: a screen should look like a well-made app of its platform with the brand switched off. The brand then lives in colour, one display face, the hero of each screen and one signature element. What goes wrong on generated app screens is measurable, so this guide gives numbers.

1. Start from the platform kit
kit_use ionic-ios for iPhone (393x852) or material-3 for Android (412x915), with from_brand, or theme with your direction's colours and reading face, such as {"ion-color-primary":"#2a43c4","ion-background-color":"#f4f2ec","ion-font-family":"'Alegreya Sans', sans-serif"} (quote a family name with a space or a digit, or the browser drops it). The kit draws the parts at the platform's sizes, so they are right before you style them:
- iPhone: Status bar (54pt), Toolbar (44pt bar; size large adds the 34pt bold title under it; prop-show-back="false" on a tab's root), List section (13pt header, rows in a 10pt rounded group 16pt in from the edges, footer) filled with List row (44pt and up; accessory chevron, value, toggle or check), Segment (32pt), Searchbar, Input rows, Button (large is 50pt; width full for the one primary action), Sheet (grabber, Cancel, title, Done), Empty state, Tab bar (49pt over the 34pt home indicator inset, Tab item instances in its slot for your icons), Home indicator.
- Android: Status bar (24dp), Top app bar (64dp; large adds the 28sp title), List item, Text field, Chip, Switch, Button (40dp, filled for the primary action), FAB, Navigation bar (80dp over the 24dp gesture inset), Gesture bar.
The skeleton of every screen, in order: Status bar, the navigation bar, one content section, then the Tab bar on a top-level screen or the pinned primary Button and the Home indicator on a flow step:
<main style="width:393px;height:852px;display:flex;flex-direction:column;background:var(--ion-background-color)">
  <x-instance component="Status bar"></x-instance>
  <x-instance component="Toolbar" prop-size="large" prop-title="Pantry" prop-show-back="false"></x-instance>
  <section style="flex:1;display:flex;flex-direction:column;gap:var(--space-6);padding:var(--space-2) var(--space-4) var(--space-6)">…</section>
  <x-instance component="Tab bar"><x-instance component="Tab item" prop-selected="true" prop-label="Today"><svg …/></x-instance>…</x-instance>
</main>
Variant values and props are both written prop-*: prop-size="large", prop-accessory="chevron", prop-width="full". A list is <x-instance component="List section" prop-header="Due today"> with <x-instance component="List row" prop-accessory="chevron" prop-title="Perfect fifth" prop-subtitle="Sing it back" prop-detail="2 min"> children. A flow step ends with <x-instance component="Button" prop-size="large" prop-width="full" prop-label="Continue"> and the Home indicator instead of the Tab bar.
Draw your own only what the platform has no part for: the hero, the signature interaction, a chart. Those carry the direction. A hand-drawn tab bar, list row or button drifts (77 to 98pt tab bars, 22pt chips, labels off centre) and reads as a web page dressed as an app.
The kit is the frame, not the content. List rows are for settings, history, libraries and plans; the signature interaction, its result and each screen's hero are drawn from the subject at real size (seven jars with their headspace lines, the pitch trace across the full width, the ladder with its rungs), and every screen keeps one such element. Measured blind, screens that turned their subject into rows of label and value lost to hand-drawn ones on originality and density even while they won on platform and spacing. A state screen (empty, error, permission) gets that element too: the Empty state's icon slot takes the subject's own drawing, and the reason is shown, not only told (a pH scale with the line at 4.6, the camera's view with the body outline).

2. One spacing system, applied by the parent
- Scale on a 4pt base: 4, 8, 12, 16, 24, 32, 48. Make it tokens (space-1 4px, space-2 8px, space-3 12px, space-4 16px, space-6 24px, space-8 32px, space-12 48px) and write every gap and padding as var(--space-…).
- Screen margin: 16 on iPhone and Android (20 on the 430 and 440pt iPhones). Set it once, as the content section's padding; never per element.
- Inside a group 8 (a title and its line), between related items 12 to 16, between groups 24, between sections 32. A section gap is at least twice the gap inside it; that difference is what groups things.
- Space with the parent's gap, not with margins on children: one gap per stack is equal by construction. Two values in one stack are a decision (8 inside, 24 between); 14 next to 16 is a slip, and design_lint reports it as hard.
- Cards and buttons: equal padding on opposite sides (16 all round on a card; a button's label centred). A row: 12 vertical and 16 horizontal, 44pt at least.
- Edges: everything that starts a line starts on the margin, or on the inset of its group (16 + 16 = 32 inside an inset list). An edge 1 to 3px off its line is a slip, reported as hard.

3. Type: five sizes, stepping clearly
- iOS text styles: large title 34, title 28, title 2 22, title 3 20, headline 17 semibold, body 17, callout 16, subheadline 15, footnote 13, caption 12, tab labels 10. Android: display 36 to 57, headline 24 to 32, title 16 to 22, body 14 to 16, label 11 to 14.
- At most five sizes on a screen, each step at least 1.2 times the one below; 15 next to 17 reads as one size set twice. One display size for the hero number or title, 48 to 96, with its unit on the same baseline.
- Sentences at 15 to 17 (16 on Android); 13 and 12 only for footnotes, captions and the small print of a paywall.
- Heading levels step down: one h1 per screen (the large title or the hero), then h2 for sections.

4. Hierarchy by screen type: what leads, what follows, where the action sits
- Home or today: the one number or object that shows progress, large (the hero), its context in one line, then today's one next action as a full-width button or the first row of a list; the rest in list sections below. Not three equal cards.
- List or library: large title, an optional search or segment, then List sections with a header each; every row a title, one line of detail and an accessory. The selected or due item marked in the row, not in a banner.
- Detail: inline title with Back; the object itself large (a picture, a chart, the step); facts as a list section of label and value rows; the one action pinned at the bottom.
- Form or settings: inline title with Cancel and Done (or Save) in the bar; inset grouped sections of Input, toggle and value rows, a header per group and a footer that explains a choice; no primary button floating in the content.
- Dashboard or progress: one chart that answers the question the screen asks, with its axis labelled and units, then the figures that explain it as a list; a segment for the time range.
- Onboarding step: progress (2 of 3) and Skip in the bar, a title (28 or 34) and one sentence, the interactive element in the middle at real size, Continue pinned above the home indicator. The first win happens on the screen.
- Paywall: a sheet with close top right; the person's own result as the hero; three or four benefit rows with icons; the plans as selectable rows with the billed price largest; the purchase button pinned, its label matching the plan; Restore, Terms and Privacy as 44pt links above the home indicator.
- Empty, error or permission: an Empty state or your own drawing that shows the reason, a 22pt title that says what is going on, why in one sentence, one action (Open Settings) and an alternative. Fill the height with the reason drawn large; a centred icon above 100pt of nothing on each side is a hole, not calm.

5. Platform numbers that are checked
- iPhone: status bar 54pt (393x852, 430x932), 62pt (402x874, 440x956), 47pt (390x844); nothing but backgrounds in the 34pt home indicator strip; navigation bar 44pt; tab bar 49pt plus the 34pt inset, three to five tabs, 10pt labels; targets 44x44pt; switch 51x31, segmented control 32pt.
- Android: status bar 24dp, gesture strip 24dp, top app bar 64dp, navigation bar 80dp, targets 48x48dp, FAB 56dp.
- design_lint on an app artboard measures: text or a control under the status bar or in the home indicator strip (hard), a real control under ${APP_LIMITS.wcagTarget}px (hard) or under ${APP_LIMITS.iosTarget}pt or ${APP_LIMITS.androidTarget}dp (advisory), edges ${APP_LIMITS.slipMin} to ${APP_LIMITS.slipMax}px off their line and gaps or paddings that differ by as much (hard), a label off its button's centre by more than ${APP_LIMITS.offCentre}px (hard), an empty band of ${APP_LIMITS.emptyBandPx}px and ${APP_LIMITS.emptyBandRatio} times the stack's gap (advisory), sentences under ${APP_LIMITS.minSentencePx}px, a tab bar off its size, shapes drawn as buttons that are not <button>, and a screen with no platform kit (advisory).

6. Good and sloppy, side by side
- Today screen. Sloppy: a 98pt tab bar with a filled black tile on the selected tab, the Start button 21pt above it, the hero headline at 30 next to a 28 sub-figure, paddings 14 on one card and 16 on the next. Good: the kit's Tab bar (83pt), the hero figure at 64 with its unit, one line of context at 17, the Start button as the first thing under it, cards at 16 all round, gaps 8 inside and 24 between.
- Permission off. Sloppy: the title at the top, two lines of text, 140pt of nothing, then two buttons at the bottom edge with the small print in the home indicator strip. Good: the Empty state centred in the space, Open Settings as its action, the alternative (log by hand) as a plain button under it, the small print ending above 818pt.
- Paywall. Sloppy: a dismiss link in 13pt grey text, plans as two equal cards, Restore Terms Privacy at y=828. Good: a Sheet with close top right, the person's own first result as the hero, plans as List rows with the billed price at 17 semibold, the button pinned above the home indicator, the links in a row of 44pt targets above it.
- Library. Sloppy: rows of different heights (52, 56, 60) because each row is drawn by hand, titles at x=24 in one section and x=26 in the next. Good: List sections of List rows, every title on the 32pt inset line, a value or chevron at the end.

7. Done means measured
For each screen: design_lint with no hard finding left. Use at most one design_critique round on the flow: fix its objective defects without re-reviewing. Scores never block completion. Only loop if the person explicitly asked; quote their request as loop_request when passing until/max_rounds. Then design_verify once per screen with the rubric, and once more only if it found hard defects you fixed. Report a line per screen with its hard findings (0), the critique score and the rubric total, and what is still open.`;
