# Changelog

## 0.4.2

The design review speaks your language and acts on one click.

- **A review in your language, in plain words.** "Review like a designer" now writes its verdict and every finding in the language you use Bogen in, for someone who may not be a designer: the problem in a short sentence, why it matters to the people using the screen, and what will change. Text on your screens is quoted as it is, in its own language.
- **Fix means fix.** Fixing the chosen findings starts the agent at once; a confirm for large fixes used to appear below the list, out of view, so the click seemed to do nothing. The fix shows at the top of the review while it runs, and one step in the chat takes it back.
- **Text, not "Copy".** The review's score for the words on a screen, and the matching choice for directions in the chat, were labelled with the same word as the copy button, so translations read "Kopieren". They are labelled Text now.

## 0.4.1

A fix for agents that load Bogen's full tool list.

- **Claude runs work again with every client.** The Claude API checks each tool's input schema against JSON Schema draft 2020-12 and refuses the whole request when one fails. Two selector patterns in `design_system_css` and `tokens_export` had an unescaped `[`, and the number pairs of `type_scale_set`, the web tools and mockup points were written as draft-07 tuples, so any Claude run that loaded the full list stopped with "input_schema: JSON schema is invalid". The patterns are escaped, the pairs are arrays of two numbers with the same limits, and a test now checks every tool schema in every list mode. Thanks to acr-sed for the precise report.
- **Tooltips sit at their element at every interface size.** At 125%, a tooltip used to land about 90 px beside the button it named.

## 0.4.0

I made Bogen something you can talk to: call your agent and it answers in a sentence or two while it works on your file. Files open as tabs, a brand opens on a real brand book, and pictures come from your own Codex CLI.

### Call your agent

- **Talk with your agent instead of typing.** The phone button in the chat head (or "Call your agent" in the command palette) puts the call on top of the chat as one calm strip: a status line for who has the line and for how long, a quiet line for what the agent is doing, and Mute, More and End. Under it is the last thing said, in a space that is kept, so the chat does not jump; the whole transcript opens from there. The voice, how the call hears, hold to talk, moving with the file, sounds, agent calls and what the call remembers are in Call settings, from More. The agent's answer, its tools and the details stay in the chat underneath.
- **A conversation, not a reading.** The voice answers in a sentence or two and never reads the agent's text out: "On it." when your request is in, quiet while the agent works (one soft sound if it takes a while), and a short spoken result at the end, such as "The headline is bigger now. Does that work?"
- **It lets you finish.** A pause mid-sentence ("Make the headline bigger and ...") no longer ends your turn, and a "mhm" or "yes" while the voice speaks only lowers it for a moment. Real words over the voice stop it at once; "stop" stops the run, "undo that" takes it back.
- **It answers what you ask, and asks back when you are vague.** "Which design are we talking about?", "What's on this page?", "Are you done?" and "What did you just do?" are answered by the voice from what is on screen and from the agent's last answer, without starting a run. "Change something" gets one short question back, about the agent's last offer when there is one. When the agent ends with a question or an offer, the voice relays it, and your "yes" goes to the agent. The voice is told never to claim a change the agent did not make.
- **Who speaks is your choice.** A signed-in Claude Code on your plan (Opus at low effort, no tools) speaks by default, because it retells the agent most faithfully. Without it, a small open model on your computer (Qwen3 4B on a GPU, Qwen3 1.7B otherwise, Apache-2.0, downloaded on request and checked by SHA-256), or plain rules.
- **A natural English voice.** English is now spoken by tiny-voca (Apache-2.0, trained on the CC BY 4.0 tiny-voca dataset), a 21 MB model with two speakers, F2 and M2, that reads a sentence in about 30 ms on the CPU. Its phonemizer, dizione, is ported to TypeScript, so nothing native is needed. The voice is chosen in the call bar; LJ (Piper) stays selectable. Calls speak English.
- **Heard on your graphics card if you like.** With a GPU, Whisper large-v3-turbo (MIT, about 574 MB) stays loaded during the call and writes a sentence down in about 0.2 s, primed with the names of your file, page and artboards; without one, Whisper base runs through Voxtype. Everything runs on your computer and is checked by SHA-256 on download.
- **Every call is kept with the chat.** What the voice heard and said, how it decided and how long it took, so a call can be looked at afterwards.
- **Say more while it works.** What you add while the agent is working ("more modern, full screen", "use Fable as an advisor") reaches it at once: the run stops where it is, what it changed stays, and it carries on with your words as the next message. Only a task you mark for later ("after that…") waits for the run to end. The voice says what it understood each time instead of the same line, and never the same acknowledgement twice in a row.
- **"Keep me updated"** gives a one-sentence update about every minute while the agent works, from what it is doing; "be quiet" stops them.
- **No minutes of silence.** In a long run the voice says one short line about every 90 seconds from the agent's latest steps, never the same news twice; "be quiet" stops it.
- **Small requests run faster.** When you have not chosen a model, Bogen picks one by the size of the request: Sonnet at medium effort for a small change ("make the headline bigger"), Sonnet at low effort for a question, and the default model for new screens, a redesign or anything unclear. The chat shows the choice next to the agent's name ("Sonnet · small change"). A model or effort you chose in the chat, in run settings or in the call always wins. Agents also check their edits with the layout map or design_lint, look at a picture only first and last, and run design_verify once at the end.
- **No more "Thank you." from nobody.** Before anything is written down, a voice activity model (Silero VAD, MIT, under 1 MB, downloaded with listening) checks that there is speech at all, so silence, room noise, typing, a cough or a door never reach Whisper. Lines Whisper is known to make up on noise ("Thank you.", "Thanks for watching", "Untertitel im Auftrag des ZDF") are dropped when little speech was behind them, and the call's own voice heard back through the speakers is recognised and ignored. The call record shows which engine heard each line, and keeps what was taken for noise and why.
- **The call hosts the conversation; the agent gets a brief.** What you say for one task is collected until you are quiet (about 2.5 s, or say "go"), then sent as a brief: a goal and conditions in plain words, your own words marked as speech recognition, your corrections ("no, I said *not* happy" replaces what it corrects), and what else you said to the voice. When a request is unclear or would throw away a lot ("from scratch"), the voice asks before it starts. Only work reaches the agent: thanks are not answered at all, remarks ("that's awesome", "I'm waiting") are only listened to, "what?" and "is it still working?" are answered by the voice, and nothing of that ever stops a run. Changes you say while it works go together after about 3 s of quiet; tasks for after are kept as a list, each sent on its own.
- **The agent keeps what it knew.** A call run keeps its Claude Code session: a change ends the turn the way Ctrl+C does, and the next run continues the same session, so the agent does not read the whole file again. The agent knows it is in a call: it never asks you to paste anything, and ends its answer with a short line for the voice, which is spoken as it is. A pause mid-sentence now waits up to 2.8 s, never longer than 12 s for one turn. Replayed against a real call of 16 Nov: 13 messages reached the agent instead of 105, 3 lines that were not requests instead of 89, 5 interruptions of a run instead of 52 (none for a remark instead of 44), and every status question answered.
- **Hears you better, on any computer.** NVIDIA Parakeet TDT 0.6B v3 (CC BY 4.0, through sherpa-onnx, Apache-2.0) is now how a call hears: 25 European languages in one 671 MB model on the CPU, about 0.3 s a sentence, with the names on screen as hotwords. On real voices it made about half Whisper turbo's word errors, and lost no sentence to a made-up "Thank you." (Whisper turbo lost 6 of 100). Whisper on the graphics card stays a choice in Call settings.
- **A question changes nothing.** Asking the agent to check, review or say what it thinks ("What do you think?", "How does it look?") no longer ends in changes you did not ask for: it gives its view and offers changes instead. Questions written down without their question mark, as speech recognition does, count as questions too.
- **The call goes where you go.** Leaving the file, going home or opening another file keeps the call, its microphone and its voice. In its own file the call is a card under the chat's header; everywhere else a bar at the foot of the content column shows the same: a ring and a glyph for who has the line (blue is you, amber is the agent, red only End and problems), a title that says what happens, what the agent does and in which file, the clock, and Mute, More and End in the same places in every state. What you said is in the card's transcript, from More; call settings are in More too. Hanging up leaves a short note with Call again. At phone width the bar spans the screen with 44 px targets.
- **It talks like a person, not a phone menu.** With Claude Code as the talking layer, one model now decides and words every turn: it answers small talk and "hello?" in its own words, asks back when a request is unclear, hands only real work to the agent (in its own words, never reading yours back), changes or stops the running task, and moves the call to another file when you name one. What it says about the agent comes from the server's record, so "is it working?" is right also for runs started from the chat. The fixed lines are only a fallback when it does not answer in time. Measured on 11 messy calls, among them a real one of 17 Nov: turns that went to the agent although they were chat, got no answer or a wrong state went from 9 of 58 to 1 (a question the echo filter took for the voice), an Opus judge scored the calls 6.5 of 10 instead of 4.1, and the first word comes after about 1.3 s (1.8 s at most for nine in ten turns).
- **It knows when to keep quiet, and starts sooner.** The voice says nothing it already told you during a run: a line that mostly repeats one of its last three is cut to its first part, or left out while the agent works and nobody asked. "Alright", "got it" or "you're amazing" while it works get no answer, and "you don't need to reply to every thanks" is kept for later calls. Half sentences ("Could you...") are let hang, with at most one "Mm?" a minute. A clear request gets a short "Okay." the moment you stop, and goes to the agent with the brief the voice wrote on its decision line, about 1.2 s after your last word instead of 5.5 s. The voice speaks from the first comma, the voice heard back is told from you by when it began (a question is never dropped), talking over it stops it after half a second, and a line you talked over is marked as not heard. Files are named by their short name, a stop is not followed by a result, and one question is asked at a time. On 14 scripted calls, among them a real one of 17 Nov, fixed lines went from 15 to 0 and no turn failed a check (3 before).
- **Call sounds.** Soft tones of its own, made in the browser, for dialling, connected, ended, mute and unmute, an incoming call and a failed one. Never over the voice, and off with one switch in Call settings.
- **Your agent can call you.** When a run you asked for (in the chat, a comment or from your phone) ends on a question, Bogen rings for 30 seconds with the question: Answer opens the call in that file and the voice asks it first, Reply in writing opens the chat or thread, Decline leaves it there. A missed call stays as a note. Off until you turn on "Agents may call you" in Call settings; never in your quiet hours, never while another call rings, never more than once every two minutes, and never twice from one file within ten minutes. A paired phone gets a notification that names the agent and the file, never the question; a desktop browser in the background shows one when you allow it.

### The call remembers

- A long call keeps short notes on itself, written every few turns while nobody speaks: the voice works from them and the newest lines instead of only the last lines, and a later call about the file starts from them.
- Open another file during a call and the call goes there too, with a soft tone and the bar naming the file for a few seconds. A run still going in the old file finishes there. It can be turned off in the call's settings.
- Wishes about how the voice talks ("keep it short", "from now on, always ask before you start", "call me Sam") are kept for every later call, in call-preferences.json in the data folder. The call's settings list them, and each can be forgotten.
- "Use the Second Shelf brand" finds the brand by its name and hands the agent its id; with two close names the voice asks which, and an unknown one is said so. Nothing is created.
- A call that ran requests ends with a note: the files it changed and the requests in each, stopped ones marked. It stays until closed and is kept with each file's chat.

### Files as tabs

- Several files open in one window as tabs above the toolbar, with Home first. Opening a file from Home, a link or `bogen open` adds its tab; the tabs come back after a reload.
- Switching back to a tab is instant: its file stays loaded for a while behind the tab, with its selection, panels, page, view and undo steps, and keeps syncing. A tab left long enough, or more than two behind, goes to sleep and loads its file again when opened; a big captured site sleeps after a minute.
- A mark on a tab says what happens in that file: an agent at work, the call, no connection, edits waiting to sync, someone else in it.
- Ctrl+Tab and Ctrl+Shift+Tab (or Ctrl+Page Down and Page Up) switch tabs, Ctrl+1 is Home, Ctrl+2 to 8 a tab by place, Ctrl+9 the last, Ctrl+W closes, Ctrl+Shift+Page Up and Page Down move the open tab. Middle click closes, tabs reorder by dragging, arrow keys and Delete work in the strip. With more tabs than fit, All tabs lists them.
- On the phone the open files are a sheet behind a button in the file's top bar.
- A file is open in one window at a time. Opened in a second window of the same browser, that window says "This file is open in another window" instead of showing a second editor, and asks the other window to come forward; Use this window moves the file over (the other window goes Home), Close goes back. `bogen open`, the Omarchy launcher and the Bogen bar use the window that has the file, or one in view, before a new window opens. On a Mac the app brings that window forward. A phone or another computer is not affected.
- Two open files with the same name read differently in the tabs: by folder, as a kept copy, or by the start of the file id. Every address of a file (with a page, a layer, a thread, or the id in capitals) is the same tab.

### Brand book, Brands and the prompt box

- A brand opens on its brand book: landscape guideline pages made from the brand's data, on its own paper and ink, with a cover in its primary lockup, a full-page opener in the brand's colour for each chapter, the logo with its clear zone, small sizes and misuse, colour as columns sized by their share with HEX, RGB and OKLCH and measured contrast, type specimens and named steps with real copy, space, voice, imagery with do and do not, rules, tokens grouped as core, semantic and component, and applications drawn from the brand (business card, email signature, letter, social post, web page) next to its own work cropped so it can be read. Approval state and what is still to add are in the colophon, not on every value. The PDF has one page per page, and on a phone the pages reflow. brand_sheet shows the same pages to agents.
- The brand page's sections are grouped into Edit, Write and Use, and each has its own address. Across files is now Files using it, and the chapters are under Write.
- Files and Brands are places on Home. Brands lists every brand and takes one from a website address, with progress, partial results and a clean failure; what it finds arrives as suggestions to review.
- A prompt box at the top of Home makes one file of a kind (website, app interface, Omarchy theme), with a brand, in the folder you are in, and starts your agent there. A link in a prompt offers its brand.
- A brand card or a file card on Home opens from anywhere on it, with a focus ring around the whole card.

### A designed edition of the brand book

- **Make a designed edition**, above a brand's book, has an agent art-direct the guidelines for that brand: a new file "*Name* · Brand book" with the generated book as a locked reference, 10 to 14 landscape pages with one idea each, applications from the brand's own world and its quirks on show, nothing invented. It runs with your chat's agent and model, on your plan, shows in the file's chat and the activity dock, and is reviewed once by `design_critique`, a fresh reviewer on another model briefed as studio guidelines, whose findings the agent fixes (a loop of up to four rounds only when asked for). `design_critique` itself now answers within 45 seconds and hands a review that is still going to the next call, so it works under the 60-second limit of Claude Code's MCP calls. The brand page then links to it, says which parts of the brand changed since, and refreshes only those pages. Agents start it with `brand_book_design`; the method is a new design playbook, brand guidelines books, with the book's arc and applications by kind of business as compositions.

### Generate image

- **Generate** sits next to every Upload image: in the Image section, the image fill editor and a shader's picture, and as **Generate image** in the command palette. Describe the picture, pick a shape (guessed from the layer) and up to four takes, then choose one from a sheet with the mouse or the arrow keys; it goes into the layer with the description as its alt.
- It uses the Codex CLI on this computer with your own sign-in, about a minute per picture, two at a time. Each runs in an empty temporary folder in Codex's sandbox with its shell turned off, and the picture is stored as a WebP like an upload. A take that fails says why and can be made again; Stop ends the rest.
- Without the Codex CLI, or signed out, the dialog says how to set it up and checks again on request. Nothing else changes.
- Agents get the same as **image_generate**, which can fill an image layer or a frame's background.

### Review like a designer

- **An independent reviewer inside Bogen.** Review like a designer (in Design checks, the command palette, and as **design_critique** for agents) renders the screens, runs the rule checks, and hands the pictures, the brand's rules and a studio brief to a fresh Claude Code session on your plan. It answers with a score out of 10, scores for state clarity, consistency, hierarchy, copy, layout and brand, every objective defect with the evidence it saw and a fix, taste notes, and what to keep. A defect points at its layer and can be pinned as a comment.
- **Never the maker's own eyes.** Every review is a new session that sees only the pictures, the brand and the brief: not the agent's session, its reasoning or earlier scores. After a fix it is told only which findings the fix took on, and checks in the pictures whether each really is fixed. It is a different model from the one that made the work (Fable reviews Opus's work and Opus reviews Fable's), and a review without evidence for a finding moves it to taste.
- **Until it is right.** An agent can loop: fix the defects, call again, and a new reviewer looks, until no objective defect is left and the score meets the target, or the rounds run out. Each round is kept on the file, so you see the history.
- **Waiting you can watch.** While the reviewer looks, the dialog pins your own screens to a wall, as the pictures the reviewer got, with a reading light walking along them and pencil marks where it has been. The stages are the real ones (rule checks, pictures, the reviewer looking, writing up, with the findings counted as they are written), the clock is real, and there is no made-up percentage. With reduced motion the wall is still.
- **A crit sheet.** The score fills its ring once, the six dimensions sit in one row, and each defect shows where it is on your screen, with Fix, Pin and Show layer. Taste notes and what to keep follow; the rounds of a loop are a small line of scores.
- **Fix at once.** Fix on a finding, or on all of them, starts your agent right away with the chat's agent and model and a brief built from the findings: no draft to send. It shows in the chat and can be stopped and undone as any run. With "Then review again until 9", a new reviewer looks after each fix, until no defect is left and the score is 9, or after three rounds.
- **Close it any time.** X, Escape and a click beside the dialog always close it. A review, a fix or pictures still being made go on as a pill in the dock at the foot of the window, where the call bar is, with Open and Stop; three or more fold into one. A brand being taken from a website shows there too when you leave Home.
- **The rules catch what a reader catches.** design_lint now flags a double negative, an unclosed quotation, the danger colour on a calm state such as "working", one label spelled two ways across screens, and text that breaks what the brand says about capitals, italic headings, the heading family or shadows. Each is a hard finding, and goes to the reviewer as input.

### App screens that hold up

- **Phone screens are measured.** design_lint knows an iPhone or Android artboard and checks what reviewers kept finding on generated app screens: text and buttons under the status bar or in the home indicator strip, real controls under 24px, edges, gaps and paddings that slip by 1 to 3px, and a button label off its centre. Each is a hard finding. Targets under 44pt or 48dp, a tab bar off its size, a large empty band, small sentences, shapes drawn as buttons and a screen without a platform kit are advice, with the numbers and why.
- **Start from the platform kit.** The iOS kit now has the parts app screens need at iOS sizes: status bar, home indicator, navigation bar with a large title, inset grouped list sections and rows, tab bar and tab items, sheet, empty state and full-width buttons, with every text a prop. The Material 3 kit gets its status and gesture bars. guide_get apps tells agents how to build a screen from them, with a spacing system, a lead for each screen type and the platform's numbers.
- **Done means reviewed.** An app screen counts as done when design_lint has no hard finding and the independent reviewer's loop scored it 8 or more, with what it still lists reported; design_verify shows where that stands, and the reviewer now also checks spacing, hierarchy and the platform on phone screens.

### Brand images

- **image_treatment** gives a photo the brand's own look, on this computer and the same every time: halftone (dots, squares, rounded cells or lines), mosaic pixels that can dissolve toward a side, ordered or error-diffusion dither, duotone and posterize, in the brand's inks. With inkBy region the subject and the backdrop each get their own ink. Halftone, mosaic and dither come out as an SVG whose fills follow the brand tokens; the others as a PNG.
- A treatment can be saved in the brand as a preset, with an example before and after. The brand page shows presets under Imagery, the brand guide and sheet have an Image treatment section, and agents in a linked file use the preset for photos.
- **image_vectorize** with palette brand traces to the brand's colours only.
- **image_search** finds free photos on Openverse and Wikimedia Commons: only CC0, public domain, CC BY and CC BY-SA, each with author, licence and source. **asset_upload from_search** imports one and keeps its credit with the file, as the provider states it; **image_credits** lists what a file owes, with text for a footer or a closing slide.
- **shader_params** lists every shader effect's parameters with defaults, choices and ranges. An attribute an effect does not take is now refused with the list, instead of doing nothing. An effect's own type, such as a dither's 8x8, is set as variant; choosing such a preset in the inspector no longer replaces the effect.

### Brand applications

- Mockups: `mockup_place` puts an artboard on one of nine scenes drawn in Bogen (poster on a wall, billboard, tote bag, badge, hanging sign, packet, cap, phone, laptop) or on a photo of your own, by four corners or a mesh for cloth. The design stays live, so a changed poster changes every mockup, and the surface's light falls on the print. In the editor, **Place in a mockup** in the command palette, and a Mockup section to swap the scene, blend, light and fit.
- Graphic devices: `pattern_set` draws a brand's motif as cells that fill by a gradient, noise, a figure (wave, mountain, tower, cloud), a bar chart, an image or a word, in the brand's tokens, as vector. A brand keeps its devices as presets in a new Graphic devices section. The inspector tunes a pattern without an agent.
- `text_outline` turns a text layer into outlines from the font the canvas uses, with its kerning and tracking: the way to build a wordmark.
- `brand_presentation` presents a brand as an agency reveal deck (26 slides from cover to close) and a guidelines book (clear space, misuse made from the real logo, colour values with CMYK and every contrast pair, type scale, grid, device), from the brand and a story the agent writes. Slides whose story is missing are left out and named. `presentation_check` says what reads as finished and what reads as generated.
- A file linked to a brand that is still all suggestions now gets the brand's tokens, marked provisional, and brand_check counts them.
- Posts, stories and posters take one of seven forms (photo with the line in a safe area, split, the one number drawn in the device, quote, device as figure, type alone, product details), and no two neighbours share one; `presentation_check` names repeats.
- A brand with an image treatment gives every photo in its deck and site that look by default.
- The system wall is its own board: every application in its own ratio and the device at favicon, card and full-bleed size, each tile checked against the brand.
- `brand_site` builds the brand as a website to publish: chapters with version and changes, colours with their measured share and every contrast pair, tokens to copy for CSS, JSON, Tailwind, Swift and Kotlin, a type tester, logo construction to switch on and off, the real applications and motion from the file.
- Mockups keep the whole design in view when its shape differs from the surface, and a selected mockup has four corner handles on the canvas.

### The editor

The editor's own interface was captured into Bogen and its design checks were worked down from 280 findings to 0. These changes carry that pass over into the editor:

- Clearer toolbar: tools in groups with separators, and the device sync state next to the file name, written out instead of cut short. On the right, Preview has a label and **Ask agent** (Ctrl K) is the main button.
- What changed while the file was closed now appears in the recent-changes strip, with **Review changes**, instead of in a separate notice.
- With nothing selected, the inspector shows the page (artboards, sections, open comments) and its design checks, with **Run checks** and **Ask agent to fix**.
- The left panel tabs show plain words, and Data is named. Page times are shorter, the page list is no longer fixed at 148px, and the canvas map shows Sections.
- Readable at a glance: interface text is at least 12px, buttons and toggles are at least 24px, the sync pill meets contrast, lane labels no longer fade across a section border, and section descriptions wrap. The spacing follows one scale of 2, 4, 8, 12, 16 and 24px.

### Faster saves

- Big files save as a log of their edits and are folded into the full file when idle, on unload and on a clean stop: on a 72 MB file, 20 small edits wrote 5.3 MB instead of 179 MB, and the longest pause fell from 505 ms to 24 ms. The full file stays in the format older builds read.
- An edit clears only the cached layers it touched; font links and shader parameters are cached until the file changes.
- Recent edits moved out of index.json into each file's history, so the file list is small and only rewritten when it changes. Tool results are compact JSON.

### Security

- Every listener refuses paths spelled another way (empty or dot segments, backslashes, encoded slashes), which closed a way around the tailnet and phone route blocks. Peer administration is only allowed from this computer.
- The headless browser reaches the web through a guard in the server that resolves each address once and refuses private ones, which closes DNS rebinding, and WebSockets go through it too. Local captures may only fetch from this computer.
- batch checks the branch, revision and critique rules like a single write; image decoding and received commits have size limits; the editor has a strict content security policy; every dependency is pinned and npm audit is clean.
- Thumbnails are written atomically and temp files left by a crash are removed on start.

### Fixes

- `bogen mcp`, `bogen stop` and the other commands keep to the data folder `BOGEN_HOME` names: they use the server that folder records, and refuse a server that serves another folder instead of writing into it. Before, a test with its own folder could reach the everyday server on the default port.
- A tab opened after the window fetched the file names (a link, the call moving to another file, a new file) showed "Untitled file" until the next change to the file list; it now gets its name at once.
- Switching tabs is Ctrl+Tab and Ctrl+Page Up/Down on a Mac too, where Cmd+Tab is the system's app switcher; Cmd+1 to 9 and Cmd+W stay.
- The brand book sets a long type scale on one or two pages, each size with words from the brand instead of its name.
- The brand book follows the brand's own rules (capitals only, italic headlines, no shadows, no dashed lines, no screenshots of other brands), and `scripts/check-brand-book-render.ts` fails a page that breaks one. Its applications carry only the brand's own words: no invented names, grey placeholder lines, agency navigation or window chrome. A brand with little written down gets a short book without openers, and logos drawn with an empty margin are trimmed to the mark.
- The brand book fits its pages: nothing runs past a page or into its folio, the cover and the brand idea lead with a short statement instead of a cut sentence, the core colours are large and the rest sit in one table grouped by job, only the contrast pairs that matter are shown, working notes from the data (file paths, sources, notes to agents) stay in the Markdown export, and a German brand gets a German book. I check every page of every brand on my machine in a browser for this (`scripts/check-brand-book-render.ts`).
- The brand book keeps its own rules in its pieces too: a logo only sits on a ground it is made for, so the business card no longer shows the mark on the colour its misuse page crosses out; screenshots stay whole and portraits grey when the brand says so; display lines take the brand's width; headings stay in its heading face. It closes every quotation it cuts, never says no twice ("Never Do not"), marks unconfirmed rules as proposals, draws corners, shadows and gradients next to the rules about them, and shows the brand's example artboards from its linked files, sharp. The render check now also fails a logo on the wrong ground, a doubled rule under the running head, a double negative, an open quotation, a heading in the body face and an enlarged picture.
- The brand book holds its own copy to the brand's voice: a headline says one thing when the brand asks for that, a brand that speaks as "I" is not shown saying "we", and an example that breaks the brand's rules is left out and counted in the colophon. Every column sits on one twelve-column grid, every page has the same running head, quotes and apostrophes are typographic and hex values in capitals. The colophon counts the chapters the contents lists. Openers carry their chapter's own thing (the mark, the colours, the letters, the spacing, a picture, the tokens, the brand's work), the brand's real screens lead the applications, sized to show whole or cut where no line is cut, and a picture whose text would be too small to read is left out. `scripts/check-brand-book-render.ts` now also fails boxes past the margins, off-grid columns, a second head system, straight quotes, lower-case hex, ornamental quote marks, unreadable screenshots, captions that repeat their heading, list columns without their heading, samples that fail the brand's voice rules and a colophon that miscounts.

## 0.3.0

Agents get more reach: shorter tool lists and plugins, a script tool, browser capture, DESIGN.md, Mermaid, PDF and PowerPoint, a real round trip to pull requests, variations, visual compare, a pre-publish check and translation memory.

### Connecting agents

- Shorter tool lists for agents with a small context, and every tool still there: `bogen mcp --tools compact` lists each tool in one sentence (about 117 KB instead of 270 KB), `--tools grouped` lists 19 area tools that take a tool's name and arguments (about 19 KB). A `schema` tool and `bogen://reference/{tool}` give any tool's whole schema, and a tool can be called by its own name in every mode. Also `BOGEN_MCP_TOOLS`, and `?tools=` or `X-Bogen-Tools` over HTTP. `bogen install` writes the list that suits each client: full for Claude Code and Codex, which load schemas on demand, compact for OpenCode, grouped for the others; `--tools` picks another. [A shorter tool list](agents.md#a-shorter-tool-list).
- Plugins: a Claude Code plugin and marketplace (`/plugin marketplace add marselnenaj/bogen`), a Codex plugin (`codex plugin marketplace add marselnenaj/bogen`), and a Claude Desktop extension, `bogen-<version>.mcpb`, built and signed with each release. Each starts the `bogen` command the install script writes, on this computer only. [Plugins](agents.md#plugins).
- **Add to agent** in Settings, Agents: the MCP clients on this computer, whether Bogen is in each, and Connect, which does what `bogen install` does. [Add to agent](agents.md#add-to-agent-in-settings).
- Layer links: `bogen open "<file>#<layer>"` opens a file with a layer selected and in view, both by id or name, and `selection_set` and `view_focus` answer with a link an agent can give you. A link opened in a tab that has the file already moves the selection without a reload. [Layer links](agents.md#layer-links).
- A reviewer profile, `bogen mcp --profile reviewer`: the critique's scope for a client of your own, with read-only tools, comments and checks with fixes off. A write is refused with the reason.

### Capture from your browser

- A browser extension for Chromium and Firefox captures the tab you are on, a region you drag over or an element you pick, including apps you are signed in to and pages on `localhost`, and sends it to Bogen on this computer, which turns it into layers through the same capture pipeline. You pair it once in the editor by comparing a code; its token adds captures and nothing else, and you revoke it in Settings, Privacy. It asks for `activeTab`, `scripting` and `storage` only and connects only to `127.0.0.1` and `localhost`. Build it with `node --import tsx integrations/browser-extension/build.ts` and load it unpacked. [From your browser](capture-and-import.md#from-your-browser-the-extension).

### References for agents

- A reference board on this computer: captures from the extension, artboards you keep and images you add, each with tags, its main colours and the type it uses, in Settings, References. Agents search it with `reference_search` before they choose a direction and keep something for you with `reference_add`; results are marked as untrusted design data. [References](capture-and-import.md#references).

### Your agent

- `script_run`: an agent writes a short JavaScript program against the open file (find layers by name, text, kind, style or CSS selector; set styles, text and attributes; rename; create from HTML; move, remove, duplicate; bind properties to tokens; read tokens and components) for edits that would take dozens of calls, such as renaming every button, binding every button colour to a token or building a grid of cards from data. Its changes land as one atomic step that one undo takes back, `dry_run` shows the plan first, and locked layers, revisions and a brand's strict mode hold. The script runs in QuickJS compiled to WebAssembly in a worker of its own, with no network, files, timers or Node, and limits on time, memory, calls, new layers and output; on any error or limit nothing is applied. [Scripts](agents.md#scripts-many-edits-in-one-step) has the threat model.
- Propose and Directions take a range and aspects: how many copies, how far they go (**Refine**, **Explore**, **Reimagine**) and what they vary (**Layout**, **Colour**, **Type**, **Copy**), holding the rest fixed. Each copy keeps them, and `proposal_list` reports what a copy changed outside its aspects. `proposal_create` takes `count`, `range` and `vary`; races take `range`, `vary` and `split`. [Variations](agents.md#variations-a-range-and-aspects).
- A race can split the page: each lane takes sections of the selected layer instead of a copy of all of it, and accepting a lane takes its sections in. [Split the page](agents.md#split-the-page).
- In the chat, **/** lists the design playbooks and your saved skills, and **@** mentions layers, components and tokens, which reach the run with their ids. **Save these decisions as a skill** drafts a section for a skill from a refined artboard and its accepted proposals, for you to review and save. [The chat](agents.md#ask-from-the-canvas-the-chat), [Save these decisions](agents.md#save-these-decisions-as-a-skill).
- Reloading the editor while an agent works brings the chat back attached to that run, with Stop, its elapsed time and the reply still streaming, and a second message waits until the chat knows whether a run is going. When the server refuses a message, the chat shows its reason in your language ("A run is already going on this file") instead of `POST /api/runs failed with 409`.
- Every run keeps a trace for bug reports: the prompt, tool calls with their arguments and results cut short, timings and touched layers, with secrets masked and files outside Bogen left out. Download it from the chat, `bogen agents trace <run id>` or `trace_get`. [The trace of a run](agents.md#the-trace-of-a-run).

### Compare, check and translate

- A visual compare of two versions: side by side with scrolling together, an overlay that highlights the changed pixels, a swipe, and the difference alone. **Review and merge** on a branch lists the screens the merge would change, each opening the screen as it is now next to how it would be after the merge, with Previous and Next through the list. Proposals and race lanes compare with the original they would replace in the same view. Agents see it with `design_branch_compare`. [Compare](history.md#compare).
- A check before publishing, in the Publish dialog and as `publish_check`: title, meta description, language, canonical address, the social picture and its size, icon, broken links and anchors inside the site, heavy images and images without a size, and short accessibility, responsive and brand results. It runs on this computer with no network, calls only real breakage a problem, and lets you publish anyway. `web_page_set` sets the title, description, language, canonical address, social picture and icon, which published pages now carry in their head, and published images get their width and height. [Publish](export-and-code.md#publish).
- Language versions follow their original with a translation memory per file: only new and changed text goes to your agent, words you list are never translated, and each language is included, untranslated or hidden. New: `translation_status`, `translation_apply`, `translation_rules_set`. [Keeping language versions up to date](agents.md#keeping-language-versions-up-to-date).
- Renaming a token changes every `var()` reference in the file, also with a fallback and in rules, attributes, text ranges and components, as one undo step; a linked library or brand passes the rename on as an update. New: `tokens_rename`. [Tokens and theme modes](canvas.md#tokens-and-theme-modes).

### Formats in and out

- DESIGN.md, the open format of YAML tokens and prose that many coding agents read: `tokens_export` and `brand_export` write one with `format: "design-md"`, `design_md_import` reads one into the file's tokens and text styles or into the brand as suggestions, with the format's lint mapped onto `brand_check`, and a linked repository's `DESIGN.md` counts as a token source, with a token pull request writing one next to the token file. [DESIGN.md](export-and-code.md#designmd).
- `diagram_insert` draws a Mermaid flowchart, sequence, state or other diagram as native layers in the file's tokens: frames with text labels for nodes, SVG connectors with arrowheads, groups and lines, laid out by Mermaid and editable afterwards. [Mermaid diagrams](capture-and-import.md#mermaid-diagrams).
- PDF pages come in as layers: text as text layers, paths as vectors, images as pictures, and only what has no plain form (gradients, masks, Type 3 fonts, annotations) as pictures, with a report of which. Drop a PDF or an SVG on the canvas, or call `pdf_import`. [PDF and SVG](capture-and-import.md#pdf-and-svg).
- PowerPoint export: slide artboards as a `.pptx` with editable text boxes, native pictures and shapes, and a picture with a reason for everything else, from the Export tab or `export_file` with `format: "pptx"`. [PowerPoint](export-and-code.md#powerpoint).
- New dependencies, listed in THIRD_PARTY_NOTICES.md: `mermaid` 11.17.2 (MIT), `pdfjs-dist` 6.4.299 (Apache-2.0), `pptxgenjs` 4.0.1 (MIT) and `yaml` 2.9.1 (ISC).

### Code

- One branch and working folder per chat: later design changes of the chat become more commits on the same branch, pushed on top, never with force, and the chat closes when the branch is merged (seen in the repository; on GitHub through `gh` only when you turn it on). A remote that is a folder takes a push without `gh`. [One branch per chat](export-and-code.md#one-branch-per-chat).
- `repo_canvas_open` opens a repository's page as a canvas on a design branch: a capture of its running dev server and its components. [Open a repository's page](export-and-code.md#open-a-repositorys-page-as-a-canvas).
- `bogen agents check --repo` runs the round trip once with your real CLI, against a throwaway repository with a local remote. [The repository round trip](agents.md#the-repository-round-trip).
- A captured page no longer copies each text colour into `-webkit-text-fill-color`, which hid a later colour change.

### Sharing

- In the review inbox, pick several client comments and send them to one revision run in a proposal. Your click starts it, never the client's form, and each thread gets an answer when the run ends. [Several comments to one run](sharing.md#several-comments-to-one-run).

## 0.2.0

A chat beside the canvas, fonts your agent draws, more kits and frameworks, accessibility and legal checks, and design guidance that gives agents more to work with.

### Your agent

- A chat with your agent per file, docked between the canvas and the inspector, in place of the floating prompt bar. Ctrl+Alt+3 shows or hides it and the file remembers it; Ctrl+K takes the focus. Answers render as markdown (never as HTML) block by block with the steps as they happen, the list follows new words until you scroll up, and Stop shows the time. Copy, Ask again and Edit sit under the last answer. The selection goes with a message as chips you can take out, and images can be pasted, dropped or attached. The title lists the file's earlier chats, and one opens again to continue. Review modes, runner, model, races, proposals, critiques and Redo this screen work as before. In a narrow window it opens over the canvas. [The chat](agents.md#ask-from-the-canvas-the-chat).
- Speak instead of typing, in the chat and in every comment box on the desktop: your computer writes it out with its own speech model and the words land in the field to be checked. Voxtype, Omarchy's dictation, is found with a Whisper model it already has. Without a model the chat says how to get one, and a comment keeps a voice note. [Speak instead of typing](agents.md#speak-instead-of-typing).
- `bogen setup` finds the agents on this computer, says which ones have Bogen, connects the ones you
  pick and says what to do next. The install script ends with it; `BOGEN_AGENTS` answers ahead.

### Design guidance for agents

- The MCP instructions open with the design core: a direction written out before the first screen (audience and job, an idea from the subject with two references, type, colour as named hex values, a layout sentence per screen), the system as tokens, building with an ambition bar (the real product large, real content in quantity, a layout idea per section, states), and the checks. The design guide adds worked examples and a direction in full; each discipline skill opens with what strong work in its medium holds. The Claude Code skill no longer repeats the instructions. The social playbook covers ads and campaign images: one picture as a visual metaphor, a short headline that turns on it, the brand inside the scene, one colour treatment. Colour is a decision with roles (ground, ink, supporting colours, an action colour, tinted neutrals and a named contrast), and `palette_suggest` gives such palettes from a subject, a seed colour or a stored image, with the WCAG 2 contrast ratio of every text pair.
- `design_lint` and `design_review` report twenty-nine craft findings for what reads as generated or unfinished: hard for objective defects, advisory with a reason for matters of taste, such as more than two font families, decorative monospace, equally loud type, competing filled actions, glow, tilt, drawn window dots and text on a picture without a scrim. [Design playbooks and verification](design-knowledge.md#craft-checks) lists each line.
- `design_verify` takes a scored rubric of eight criteria. It does not count while an objective defect stands (overflow, unreadable text, placeholder copy); advisory findings never block or cap, and a kept choice is recorded with its reason; a score above 3 does not hold while measured findings stand against that criterion, and built-in runs do not complete without the rubric.

### Brands

- A file goes to another device with its brand: a `.bogen` file of a linked file carries the brand's
  whole document and assets unless you clear **Include its brand**, and opening it adds the brand under
  the same id, or keeps the one that is there and says when the two differ. A brand also goes on its
  own (**.bogen** on the brand page, `brand_export`, `bogen export <brand>`), and design folders carry
  it in `brand/`. New: `file_export`, `file_import`, `brand_export`, `bogen export`, `bogen import`.

### Kits, icons and code for more frameworks

- Six more kits: Mantine, Carbon (dense, with a data table), USWDS (for public services, light only), daisyUI, Web Awesome (web components) and Pico CSS (classless HTML). Their tokens are read from each library's package, a brand maps onto them through the same roles, and none ships a project's logo or a government mark. [Component kits](components.md#component-kits).
- Kits that are markup (daisyUI, USWDS, Pico CSS, Web Awesome) hand off as that markup, one class attribute per tag, with the scripts of custom elements imported; React gets it as JSX.
- `icon_search` and `icon_insert` reach Phosphor, Tabler Icons, Heroicons (outline and solid) and Material Symbols next to Lucide, with names such as `tabler:home`, and `set: "all"` searches them together. Logos of other companies are left out.
- `code_get` and `export_file` write Vue (script setup, TypeScript), Svelte 5 and SwiftUI: a file per component with typed props and its variants, instances as usages, tokens in light and dark, motion that honours reduced motion, and what the format could not say. Every Vue and Svelte file is compiled in the tests; SwiftUI is checked with `swiftc -parse`. [Vue, Svelte and SwiftUI](export-and-code.md#vue-svelte-and-swiftui).
- [Licences](licences.md) says what Bogen may ship of each candidate design system, icon set and export target, and what it must not use.
- In a set of a kit, each member's text props now come into code with that member's own text.

### Fonts of your own

- Agents draw fonts: `font_create` makes a page of glyph cells on one em grid with guides, `font_glyphs_set` writes glyphs from SVG path data, `font_kerning_set` kerns, and `font_build` makes an OTF and a WOFF2 that text in the file uses at once and exports carry. `font_specimen` sets a waterfall, a pangram, your words and spacing strings to judge it by, and `fonts_made` lists the fonts made in a file. [Fonts of your own](fonts.md) has the details.
- A font can start from a traced drawing (`image_vectorize`, then `from_layer`) or from an open font whose own licence allows changes, under a new name that keeps clear of its Reserved Font Names. A proprietary font is refused.
- On a glyph page the inspector shows the Font panel: Build font, downloads, a preview line in the current build, metrics and every glyph. Built fonts come first in the font list, marked Made here.
- `guide_get fonts` tells agents how to make a display face hold together: one stem weight, overshoot, optical corrections and spacing with control characters.

### Accessibility and legal requirements

- `compliance_check` and the editor's **Accessibility and legal check** check a page against EN 301 549 V3.2.1, WCAG 2.2 AA, WCAG 2.1 AA, the European Accessibility Act with the Austrian BaFG, or the WZG for public bodies, criterion by criterion: failed with layers and fixes, passed, not applicable, or needs a person with a short test. They run axe-core in the renderer, text and non-text contrast, reflow at 320 CSS px, the text spacing override, language of page and parts, and form labels, errors and autocomplete.
- The score never claims conformance while a criterion failed or is open; the automated pass rate is reported apart. A person marks what only a person can decide, and the marks are stored in the file with their name and the date.
- `compliance_statement` drafts the Erklärung zur Barrierefreiheit in German and English in the EU model's sections, with the FFG's complaint procedure under the WZG and the Sozialministeriumservice under the BaFG, and the fields a person fills in marked. The report exports as HTML or PDF.
- With `legal: true`, reminders with sources for what a design can show of other duties: Impressum and privacy links, consent banners, embeds and remote Google Fonts, order button wording, prices, discounts, urgency, green claims, ad and AI labels, picture licences. [Accessibility and other legal requirements](compliance-law.md) says what each law asks, as read on 13 November 2026. A technical aid, not legal advice.

## 0.1.0

The first version. Everything below is new. [The canvas](canvas.md) and the other guides say where a
feature works only in part.

### Design guidance for agents

- Every design skill, the MCP instructions and the design guide open with a quality bar and a six-step work loop: brief and point of view, tokens and scales, sections with screenshots, whole-artboard review, scored rubric, report. The instructions kept their size.
- `design_lint` and `design_review` report nineteen craft findings for the habits that make work look generated or unfinished, such as more than two font families, decorative monospace, equally loud type, competing filled actions, glow, tilt, drawn window dots and text on a picture without a scrim. [Design playbooks and verification](design-knowledge.md#craft-checks) lists each line.
- `design_verify` takes a scored rubric of eight criteria. A score above 3 does not hold while measured findings stand against that criterion, and built-in runs do not complete without the rubric.
- `design_lint` also finds hedges, test-report language and headings chopped into fragments.
- The checks read what a template shows rather than designs by its mark: counter-examples are left out, and specimens such as every button variant or the type scale are spared only the rules about composing one screen. An Omarchy theme file is read as a preview of the system, so its monospace bar, key glyphs and portrait monitors are not judged as a web page or a story. FAQ questions, file names, icon-font glyphs, `var()` fallbacks and unlike siblings no longer raise findings. [What the checks read as something other than a page](design-knowledge.md#what-the-checks-read-as-something-other-than-a-page) has each rule.

### Large files

- All cached screens remain visible in large canvas overviews. Actual WebP previews replace empty offscreen boxes after background capture; unchanged previews survive restarts.
- Automatic live rendering follows expanded layer cost and device memory instead of a fixed four-screen limit. Selecting a screen still opens its editable content.
- Preview capture runs one screen at a time, pauses under memory pressure and closes its browser context after every capture. The device-local cache has explicit size and record limits.
- Canvas maps list unassigned screens even before a page has sections. External agents receive fresh organization status in file and context responses; text headings alone do not count as assigned sections.

### Proposal decisions

- An unchanged accepted proposal is recorded as accepted, including decisions synced from another editor. Changes inside a screen preserve layer ids without confusing the result.
- Choosing one direction reports the other directions as discarded; an unrelated original edit cannot turn a discard into an acceptance.
- Small decision receipts share the same undo step as the decision; the local preference history remains separate.
- Completion checks stay inside an assigned revision/race copy when no layer ids changed. Creating an empty page does not recheck unrelated older screens; actual visual changes still require screenshot and verification.

### Updates, packaging and checks

- Large canvases show real cached previews and budget live screens by expanded layer cost. Short isolated render batches reuse one page for at most four screens; tiny thumbnails are derived from the completed raster. This also supports absolute clipped hug-height layouts. Offscreen proxies avoid retaining wallpaper/effects; geometry edits hydrate their real content before measurement. An aarch64 laptop passed the bounded 25-screen opening, focus, pan and edit fixture.

- npm updates prepare and check a separate installation, retain the previous app and support explicit offline rollback. Preparation/activation failures preserve the current app and documents.
- The packed runtime uses exact top-level versions and a shrinkwrap derived from the reviewed dependency lock, consistent with dependency notices and the SBOM.
- Normal editor settings reads no longer start model catalogs. Opening a model picker still queries the selected CLI.
- CI checks source hygiene, types, builds, documentation, core/editor contracts and signed-update recovery. Test examples use fictitious device identities.
- Canonical sixteen-chapter brandbooks, sources/open questions and human review; a branch tree/list/checkpoint overview; canvas-only arrangement no longer expands quality checks to unchanged screen content.

### The canvas

- An infinite canvas where every layer is an HTML element with CSS: frames, flex and grid, absolute
  position with constraints, fixed, hug and fill sizes.
- Tools for frames, shapes, lines and arrows, text, the pen and pencil, images, comments and shaders.
- Smart guides, snapping, measuring, gap and padding handles, reordering flex children by dragging.
- Fills with layered gradients and handles on the canvas; borders, shadows, filters, blend modes; any
  CSS property under Other styles, and Simplify styles.
- Rich text ranges, Google Fonts and local fonts with variable axes; text that merges per character
  when several people type.
- Vector editing, shape to path and boolean operations.
- Lucide icons, shader layers, video and iframe embeds.
- Images: crop with aspect presets and handles on the canvas, brightness, contrast, saturation, blur
  and grayscale as CSS filters, both kept by every export, and Vectorize, which traces an image into an
  editable SVG layer on this computer.
- Designs from data: data sources of JSON or CSV, pasted, uploaded or read from a URL, kept in the
  file; layers bound to fields for text, image, visibility, props and variant, for a list or a single
  record; refresh with live copies on the canvas; code export that maps over the records. This
  computer's own network only when you allow it on this device.
- Prototype links, hover styles and transitions, a preview with present mode, and a motion panel with
  keyframes.
- Prototypes with state: boolean, number and text variables; interactions on click, hover and submit
  that set variables, show and hide layers, switch variants and navigate; layers, variants, fields and
  text that follow variables. The preview runs it without writing to the file.
- Responsive variants: a 1440 artboard becomes 768 and 390 versions as media rules on the same
  layers or as linked artboards, then a check lists what still sticks out.
- Command palette, find on canvas, layer search, settings, minimal UI, and a shortcuts dialog.
- Comments with attachments and mentions; cursors, presence, follow and cursor chat.
- A home screen with folders, search and thumbnails.
- Measured with a file of about 10,000 layers: it opens and paints in about half a second, and an
  agent's write shows in the open editor about 30 ms after it is sent ([Limits](canvas.md#limits)).
- A welcome file on the first start, made once and never again once deleted (`bogen welcome` and
  Help open it), and four examples to start from, each with a small brand of its own.

### Design systems

- Tokens as CSS variables, theme modes with one value per mode, and text styles.
- Components with instances, overrides, props, variants and slots.
- Component kits: shadcn/ui, Radix Themes, Bootstrap 5, and Material 3 and Ionic in iOS mode as phone
  kits, each with variants, props and slots, tokens in the kit's own names with light and dark modes, a
  showcase page, and code that imports from the kit's library. A brand maps onto a kit's tokens, and a
  kit can be made from a linked repository's components. Kits under Assets, `kit_list` and `kit_use`.
- Shared libraries between files, with updates you accept.
- Code components: React components from your own project, rendered by its own code, and its
  Storybook stories as variant sets that stay in step.

### Brands

- Brands as documents of their own, synced, with logos, palette, type, layout, voice and rules.
- Extraction from files, live pages, CSS and Tailwind configs, as suggestions you confirm.
- The brand check with a score that explains itself, waivers by a person, and strict mode.
- Versions, impact on linked files, and applying a change as one undo step per file.
- Templates that lay out a brand system, a landing page or social images from a brand.
- Memory from decisions: what you accepted and discarded, measured, turns into rule suggestions in
  the Brand panel that you add or dismiss, and a short summary for agents in `brand_get`.
- Like this site, in a brand: a captured page redrawn in a brand's colours, fonts and scales, with
  placeholders for its text and images, then checked against the brand (`site_restyle`).
- A setting an agent proposes for a brand, such as strict mode or no gradients, binds nobody until you
  confirm it, like any other suggestion, and publishing a version confirms nothing. `brand_update`
  refuses a value that is not one of a setting's choices instead of reading it as the default, and
  writes nothing of a call that fails.
- A brand read from CSS keeps the stylesheet's own variable names as tokens and takes family roles from
  names such as `--font-display`. Looking at a live page and then applying it captures the page once.
- A file whose brand was deleted says so with the way out, in the Brand tab and in every brand tool. The
  brand page says why an export, an upload or an edit did not go through.
- Brand languages: a brand speaks a primary language and any others, as tags such as `de-AT` or
  `pt-BR`. Words, examples and text rules belong to one of them. `brand_check`, `design_lint` and
  `voice_check` judge copy in the language it is written in, and agents are told which languages the
  brand speaks and which one to write in. Brandbook chapters keep the language they are written in and
  are marked with it; they are not translated. A brand with one language works as before.
- The Brand panel shows the value of a setting that binds, with an agent's proposal beside it to
  confirm or dismiss. The Strict box no longer looks set while strict mode is only proposed.
- A duplicated brand is a new brand: it starts at version 0 with no versions of the original, and says
  which brand and version it came from.
- `PATCH /api/brands/:id/book` is gone. Nothing used it: the editor writes chapters into the brand
  document, and agents use `brand_book_update`.

### Your agent

- One relevant effective design skill supplied before every built-in canvas run, with the delivered discipline and revision recorded in run details. External clients receive explicit setup guidance.
- Personal SKILL.md editing in Settings: direct Edit, copy/download, immutable original, restore with backup, persistent tab drafts and concurrent-edit protection. Sixteen playbooks, 128 decisions, 32 composition briefs and 28 contextual anti-slop preferences.
- Redo this screen from its right-click menu or the Design inspector, with optional feedback and the existing revision/branch safeguards. Opening the prompt starts no run.
- A quiet Reload notification when an open desktop window has an older editor than its server. No automatic reload during editing.

- An MCP server with tools, resources with subscriptions, four prompts and guides, over stdio and
  HTTP, working with no editor open.
- `bogen install` for Claude Code, Codex, Cursor, VS Code, OpenCode, Gemini CLI and Zed, with a Bogen
  skill for Claude Code and Codex.
- Ctrl+K runs your own `claude` or `codex` with only Bogen's tools; `@claude` and `@codex` in a
  comment start a run that answers in the thread.
- Comment threads are conversations: a reply without a mention goes to the thread's agent with its
  model and effort, the composer shows where it goes (**To Claude · Opus**) with **Comment only** and a
  choice per message, a bare `@claude` answers what you wrote before it, and threads are compact headers
  that open and close, with drafts kept per thread, on the desktop and the phone
  ([Conversations](agents.md#conversations-replies-go-to-the-same-agent)).
- Images come from your agent: inline SVG or CSS, or its own image tool, such as Codex's built-in
  image generation, stored with `asset_upload`, which reads the file by path. Bogen has no image
  generator and calls no AI provider. An image with no source is a placeholder of its size.
- Model and effort per runner, run history, proposals to accept or discard, events to wait for,
  agents that point at things, and undo per agent and per step.
- A race of agents: **3 directions** runs several CLIs or models at once, each in its own copy with
  its own cursor and colour, with a concurrency limit per runner; you compare, accept one, and drop
  the rest or keep them in a branch inside the file.
- Critique: a run that only reads and comments leaves notes pinned to layers, each with a suggestion
  that **Fix it** hands to a fix run.
- Rebuild as layers: an image layer, or an image pasted into Ctrl+K, goes to the run attached, which
  rebuilds it next to it in the brand and compares with `visual_diff`.
- Live site mode: pick an element on your running dev server and have your agent edit the source.
- Custom design checks: create, extend, disable and run saved checks in the Design checks dialog or with `check_list`, `check_set`, `check_delete` and `check_run`. Rules cover rendered CSS, geometry, attributes and element counts, alongside lint and responsive checks. Definitions sync, undo and export with the file.
- `responsive_check` can compare the same mobile width at several browser heights (`viewport_heights`), reporting changes to content height, layer positions, visibility and sticky positioning. Results are measurements to review while preserving the intended scroll effect.
- `design_lint` checks spacing rhythm and type hierarchy as well as contrast, tokens and sizes, and
  applies its safe fixes as one undo step.
- `html_write` keeps the white space of `<pre>` and `white-space: pre`, and says which CSS it dropped
  because a browser would ignore it; `layer_move` takes layers to another page; `layer_find` compares
  style values as CSS.
- A design language per file and per request, apart from Bogen's own language: write new copy in it,
  translate screens in place, or add a language version as a branch inside the same file. Every run
  and `file_open`/`context_get` get it, with `lang` and `dir` on the artboards an agent translates.
  [Screens in another language](agents.md#screens-in-another-language).

### Getting things in and out

- Capture copies a live page, or a whole site, onto the canvas as editable layers, keeps self-hosted
  fonts, and fills in a second colour scheme as theme mode values.
- Drift compares an artboard with its live site, by pixels with an overlay and by structure: spacing,
  sizes, colours and fonts (in the brand or not), changed words, and missing or extra elements, with
  the CSS values of both sides. In the Drift tab and as `drift_check`.
- Import from Figma through the REST API with your own token.
- Export to PNG, JPG, WebP, AVIF, SVG with real vectors, PDF, HTML, MP4 and WebM, with size presets
  to a zip, and a clickable prototype as one HTML file with one small script that asks no network.
- Code as HTML, React or React with Tailwind, with components as typed React components.
- Experimental: a layer as a minimal [Exact](https://github.com/expo/exact) app in its Contract
  language, in the Code tab, `code_get` and `export_file`, written against Exact `57c86055b5c4`, with
  what Contract cannot say left out and listed ([An Exact app](export-and-code.md#an-exact-app-experimental)).
- Motion as code: keyframes, animations and transitions as CSS that honours
  `prefers-reduced-motion`, or as Framer Motion in the React export.
- Tokens out as CSS or a Tailwind theme, and in from your repo's CSS.
- App screens from Tomacco come in as editable artboards, with an optional device frame, and Design
  versus app compares a design with the real screen: pixels and matched elements
  ([Tomacco](tomacco.md)). From the Export tab or the toolbar, the screen lands beside the selected
  artboard and opens the comparison on the same capture. When Tomacco is missing or no device runs,
  the editor and `tomacco_status` show the next step from `tomaccoctl doctor` with its command; Bogen
  never runs it.
- The linked repository's tokens next to the file's, from CSS, Tailwind or DTCG, pulled in or pushed
  as a pull request.
- A pull request from a design change: your agent implements it in a working folder of its own, with
  before and after pictures and a link back, and nothing is pushed until you confirm the preview.
- Publish an artboard or a page as a static website, in versions with rollback and unpublish: on
  Bogen's own site on your tailnet, in a folder, or on GitHub Pages through your own `gh`. The files
  carry no script, layer ids or anything else internal, and only you publish, in the editor; agents
  prepare and ask.
- Review links for clients: one frozen version under an unguessable link that expires, can be revoked
  and can have a view limit, with an optional plain comment form whose comments wait in your inbox
  and never start an agent.
- Tailscale Funnel for the site and review links, off by default, on its own port, after a warning.

### History

- Every change on a timeline, revertable on its own or as a whole agent run.
- Commits, compare with a visual difference, restore, and branches: versions of the whole design inside
  the file (tokens, records, components, layers), that sync and go with a `.bogen` file; you review and
  merge them with a choice per conflict, discard, restore or undo a merge, and an agent can only start
  and work in one ([Branches](history.md#branches)). Older copy-branches are listed under Older copies.
- Design folders that diff well, and a Git mirror that never pushes.
- Replay plays back how a page was built, every step with each person's and agent's cursor, and films
  it as MP4, WebM or GIF, also with `bogen replay` and `replay_export` ([Replay](history.md#replay)).

### Devices and desktop

- The first public release targets Omarchy desktop. Five collection presets have recomposed landscape/portrait vector artwork; five multicolour active borders are replaced by single accents, and muted text in every preset meets 4.5:1 against its base background. Existing personal theme projects retain their saved artwork.

- The interface in Omarchy's 50 languages, chosen per device under Settings, or Automatic from Omarchy's language
  on this computer and the browser's elsewhere; right to left for Arabic, Persian, Hebrew and Urdu with the canvas
  kept left to right. Machine translated, not yet reviewed by native speakers
  ([Settings](canvas.md#the-window)).

- Sync between your own machines over Tailscale, with conflict notes and version checks.
- Voice comments on the phone: the microphone records a note that a speech model on your computer
  writes out, or that stays attached when there is none; nothing goes to a speech service
  ([Voice comments](devices.md#voice-comments)).
- Text that both devices edited while apart keeps one side's whole text, with a note on both that has
  both texts and offers Use the other, Keep both as a branch and Dismiss. Edits in different words
  still merge.
- `bogen doctor` checks the whole setup and prints the fix for each problem.
- `bogen peer deploy` updates another Omarchy machine over ssh.
- Omarchy integration: theme following, bar widget, notifications, launcher, keys, a user service and
  screenshots to the canvas.
- Design an Omarchy theme: a file whose tokens are the keys of `colors.toml`, with previews of the
  bar, terminals, windows, launcher, notification, lock and boot screens drawn from them, and
  backgrounds at the sizes of your screens. Start from nothing or from an installed theme, export a
  theme folder, a Git repository or a .tar.gz, install it, and apply it with Undo
  ([Design a theme](omarchy.md#design-a-theme)).
- Portrait desktop monitors in Omarchy themes: previews of the desktop, launcher, lock and boot
  screens laid out for a monitor turned on its side (detected from `hyprctl`, or 1080 × 1920), a
  wallpaper composition of its own shape instead of the landscape one cropped, a Displays section and
  `omarchy_theme_displays` to add displays to a theme that exists and to give a composition artwork of
  its ratio, and the portrait previews and compositions under `displays/` in the export
  ([Portrait monitors](omarchy.md#portrait-monitors)).
- Portrait monitors show a theme's own portrait composition with the portrait background plugin
  (`bogen omarchy portrait install`, then `enable`), a clone of Omarchy's background derived from the
  one on the machine; every other screen keeps the theme background. Only designed compositions are
  shown or exported: new and imported themes start with a quiet placeholder instead of palette arcs,
  a landscape picture shown whole in a portrait layout counts as composed and exports as a render,
  and `bogen omarchy portrait audit` says for every installed theme what a portrait screen shows
  ([The portrait background plugin](omarchy.md#the-portrait-background-plugin)).
- **Add 9:16 layout** in the theme dialog asks an agent to compose a desktop theme's 9:16 composition.
  It is one real run, with the agent and model chosen for the prompt. It starts after a checkpoint in
  the History, adds the 9:16 shape only if it is missing, and works on the existing board in the same
  file. It shows in the prompt and the queue under that name, with Stop. When it ends, the dialog
  shows the composition's real state. It uses agents on this computer only, never swaps in another
  agent, and never installs or applies the theme
  ([Portrait monitors](omarchy.md#portrait-monitors)).
- One project per theme: starting from the same installed theme again, with or without a name, opens
  its project; several possible ones are listed for you to choose, never another copy. **Themes** on
  the home screen shows your projects with drafts, Draft, Installed and In use, and their branches.
  Older copies of one theme come together as branches of the project you pick; the copies stay as
  kept files under it ([Copies of one theme](omarchy.md#copies-of-one-theme)). A theme Bogen made keeps
  its designed portrait compositions.
- An npm package, `bogen-design`, and an Arch `PKGBUILD`.

### Releases and support

- Signed releases: each file has a SHA-256 and an Ed25519 signature, with a CycloneDX SBOM and a
  provenance statement. `bogen verify` checks them against the key built into Bogen.
- `bogen update check` and `bogen update apply` for an npm install; `apply` installs only a package
  whose signature verifies. The editor and the bar widget say quietly when a new version is out, and
  the daily check can be turned off. See [privacy](privacy.md#update-checks).
- `bogen report` writes a bug-report bundle on your computer, with tokens, keys, cookies and Tailscale
  logins masked. It sends nothing.
