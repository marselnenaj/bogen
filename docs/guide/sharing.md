# Sharing for review

A review link shows a client one artboard or page, frozen at a version, in any browser. They need no
account and no Bogen. If you allow it, they can leave comments, which wait in your editor until you
read them. To put a design online as a website instead, see [Publish](export-and-code.md#publish).

## Make a link

1. Select the artboard, or nothing for the whole page, and open the Export tab. Click **Share for
   review**.
2. Turn on the review listener, if it is off. It answers on your tailnet only, at
   `https://<this computer>.ts.net:8443/`.
3. Say who the link is for, how many days it works (14 by default, 90 at most), and, if you like, how
   many page views it allows.
4. Decide whether the client may comment.
5. Click **Create link**. The link is shown once, so copy it now: Bogen keeps only a hash of it and
   cannot show it again. Lost it? Revoke it and make another.

The link shows the newest version of the artboard, or a new one if you tick **Make a new version
first**. Later changes to the design do not reach it: make a new link for them.

The dialog lists every link of the file, with its version, views and until when it works. **Revoke**
stops a link at once. An expired, revoked or used up link shows the same page as a mistyped one.

**From your agent.** `share_prepare` asks you for a link, with its settings. The request shows in the
dialog as Prepared by claude, or whichever agent; **Create this link** makes it. Agents never see
the link.

**From the terminal.** `bogen share list` lists links and `bogen share revoke <id>` stops one. Links
are made in the editor only.

## Comments from clients

With comments on, the review page has a small form in its corner: a name, a comment, and a picture of
the page to click the place the comment is about. It is a plain HTML form, with no script.

What the client sends is made plain text: markup and control characters go, and the `@` of every
mention is taken out, so `@claude fix it` arrives as `claude fix it`. A comment is at most 2000
characters. Each address can send five comments in ten minutes, and each link takes twenty an hour.

Comments do not go into your file. They wait under **From clients** in the Share for review dialog,
marked **from a client**:

- **Accept as comment** puts it into the file as a comment thread by the client's name with
  "(client)", pinned to the artboard where they clicked.
- **Delete** drops it.

A client's comment never starts an agent run, before or after you accept it. Even your own reply in
a client's thread with `@claude` starts nothing: start a run from a comment of your own. Agents that
read comments see a client's marked as feedback from a client, never as instructions.

## Public on the internet

By default both the review listener and Bogen's site answer on your tailnet only, so a client needs
to be on it. To give a link to someone outside, turn on **Public on the internet (Funnel)** in the
dialog. Bogen asks first and says what it means:

- Anyone who has the address can open it. With a review link they also need the token in it.
- Visitors do not need Tailscale, and Bogen cannot tell who they are.
- Their traffic passes through Tailscale's relay servers on its way to this computer. See
  [Privacy](privacy.md#published-sites-and-review-links).
- Only the published files and review links answer there: no editor, no API, nothing else of Bogen.

Funnel uses its own port for each listener: 10000 for the site and 8443 for review links. Bogen adds
and removes only that port's entry in Tailscale, and leaves every other `tailscale serve` or Funnel
entry as it is. Turn it off in the same place.

Funnel also needs your tailnet's admin to allow it. If the dialog says the policy does not let this
computer use Funnel, add this to the tailnet policy file in the Tailscale admin console, under Access
controls, with your own login or a group or tag of this computer:

```json
"nodeAttrs": [
  { "target": ["you@example.com"], "attr": ["funnel"] }
]
```

HTTPS certificates must be on as well, under DNS in the same console.

## Your responsibility for what you share

You are the one who shares the link, so you are responsible for it towards the people who open it. If you use review
links for clients, tell them that their name and comment are stored on your computer and for how long. A site you
publish needs its own legal notice and privacy information where the law asks for one; Bogen adds none.

## What a client sees, and what they do not

They see the files of that one version, as a static page. They do not see layer names, comments,
hidden layers, proposals, history, other pages or other files, and they cannot reach the editor or
any part of Bogen's API. See [Security](../../SECURITY.md#publishing-and-review-links)
for the rules both listeners follow.
