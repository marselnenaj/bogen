"""Golden phonemes for the TypeScript port of dizione (packages/server/src/speech/dizione).

Runs the reference Python dizione over a corpus of varied English sentences and writes, for each one, the token ids
and stress the tiny-voca model is fed. test/dizione-golden.test.ts compares the port against this file.

    DIZIONE_DATA=<tiny-voca>/phonemizer <venv>/bin/python packages/server/scripts/dizione-golden.py \
        apps/editor/src/i18n/source.json packages/server/test/fixtures/dizione-golden.json.gz

The corpus is the English interface strings of Bogen (real design vocabulary), sentences built from templates that
exercise numbers, money, dates, times, units, codes, addresses, abbreviations, chat forms and homographs, and single
words taken from the dictionary and made up, so the unknown-word model is covered too.
"""

import gzip
import json
import random
import re
import sys

import dizione

rng = random.Random(20261116)
source, out_path = sys.argv[1], sys.argv[2]

ui = []
for text in json.load(open(source, encoding="utf-8")):
    text = re.sub(r"\{[a-zA-Z]+\}", lambda m: rng.choice(["Headline", "3", "Brand assets test", "12", "Loam", "the poster"]), text)
    if re.search(r"[A-Za-z]{2}", text):
        ui.append(text)
ui = rng.sample(ui, min(1600, len(ui)))

names = ["Lena Hofer", "Markus", "Anna Petrović", "Northwind", "Okafor", "Kayleigh", "Zoë", "Jürgen", "Siobhan", "Nguyen"]
things = ["headline", "artboard", "poster", "button", "layer", "the hero image", "token", "logo", "billboard", "tote bag",
          "gradient", "drop shadow", "grid", "kerning", "typeface", "wordmark", "mockup", "palette", "frame", "component"]
templates = [
    "Make the {t} bigger and bolder.", "Move the {t} 24px to the left.", "Set the {t} to #FF6B35 at 80% opacity.",
    "The {t} costs ${m} per month, or €{m} a year.", "Meet {n} on {d} at {h}.", "Call {n} at (555) 123-4567 or +1 800 555 0199.",
    "Version {v} shipped on {d}; see https://bogen.dev/docs/{w} for details.", "Send the PDF to {e} before 5 p.m.",
    "We grew {p}% in Q3, from 1,250 to 3.4k users.", "It's 3/4 done, about 2 1/2 hours left, ETA ~45 min.",
    "Dr. {n} lives on Baker St. near the U.S. embassy, e.g. in Apt. 4B.", "I read the brief yesterday; can you read it too?",
    "The lead designer will lead the review of the lead-free poster.", "Record a new record of the live session; they live here.",
    "Order #A7-4419 arrives Mon.-Fri. between 9.30 and 11.30.", "lol ok thx, brb in 5 mins!! :) gr8 work",
    "if a > b then x = a + b, else 67 > 66 and p<.05", "Export design_v2_final.png to ~/Desktop/exports/ now.",
    "The 1990s poster, the 2020s logo and World War II, Chapter IX.", "RTX 4070 Ti renders 4K at 120 fps in 1080p mode.",
    "It weighs 2.5 kg, measures 30 × 40 cm and covers 120 m².", "{n}'s team re-designed the co-working space's sign-in flow.",
    "Wait… what? \"Bring the hard question,\" she said — then left.", "THE HEADLINE IS TOO LOUD AND THE BODY IS TOO QUIET.",
    "The iPhone, YouTube and JavaScript logos sit next to macOS and eSIM.", "Soooo goooood, honestly the bestest one yet.",
    "Temperature: -5°C to 23°C, wind 15 mph, rain 0.3 in.", "Invoice INV-2026-0042 for £1,299.50 is due 14/03/2027.",
    "The ratio is 16:9 and the score was 3:1 at 21:45.", "Use {{HH AH0 L OW1}} or hello{{h ə l ˈoʊ}} inline.",
    "A, B and C; then (a), (b), plan A and vitamin D.", "Sh! Ss! Tsk, the ss in mm:ss is a variable named ss.",
]
def fill(t):
    return t.format(
        t=rng.choice(things), m=rng.choice(["3", "12.99", "1,200", "0.50", "49", "2.5k", "1 million"]), n=rng.choice(names),
        d=rng.choice(["2026-11-20", "Nov 20th", "20 November 2026", "Friday, March 3", "12/10", "3-17 November", "Jan. 5, 2027"]),
        h=rng.choice(["9:30 am", "14:00", "7.30 pm", "noon", "3pm EST", "0:45"]), v=rng.choice(["3.2.1", "v0.3.1", "2.10", "18.04"]),
        w=rng.choice(["teams", "voice", "brand-site"]), e=rng.choice(["lena@example.com", "hello@bogen.dev"]),
        p=rng.choice(["12", "3.5", "100", "0.1"]))
built = [fill(rng.choice(templates)) for _ in range(700)]
numbers = []
for _ in range(300):
    n = rng.choice([rng.randint(0, 99), rng.randint(100, 9999), rng.randint(10000, 10**9), rng.randint(1900, 2099)])
    form = rng.choice(["{n}", "{n} layers", "#{n}", "{n}th", "${n}", "{n}%", "{n} px", "-{n}", "{n}.{d}", "page {n} of {m}",
                       "in {n}", "ID {n}", "call {n}", "{n} 000", "{n}/{m}", "{n}-{m}", "{n}:{d}"])
    numbers.append(form.format(n=n, m=rng.randint(1, 99), d=rng.randint(0, 59)) + rng.choice([".", "", "?", "!"]))

lexicon = [line.split("\t", 1)[0] for line in open(dizione.get().directory / "lexicon.tsv", encoding="utf-8") if line.strip()]
words = [w for w in rng.sample(lexicon, 500) if re.fullmatch(r"[a-z']+", w)]
made_up, letters = [], "aeioubcdfghklmnprstvwz"
for _ in range(400):
    w = "".join(rng.choice(letters) for _ in range(rng.randint(4, 11)))
    made_up.append(w + rng.choice(["", "", "ing", "ed", "s", "ly", "'s", "ness", "leigh", "virus"]))
singles = [w.capitalize() + "." for w in words + made_up]

# Random mixtures of every kind of piece the rules know, to reach the corners the templates miss.
pieces = ["the", "Headline", "a", "A", "I", "k", "u", "r", "ok", "LOL", "gr8", "b4", "2day", "iOS", "macOS", "eSIM", "NASA", "IT",
          "U.S.", "e.g.", "Dr.", "St.", "No.", "vs.", "Mon.", "Jan.", "3", "07", "42", "1,234", "3.14", "-5", "1/2", "3/4", "12/10",
          "24/7", "2026-11-20", "9:30", "14:00:05", "7.30pm", "5 p.m.", "$5", "€12,50", "£3.99", "20 €", "50%", "~10", "#4", "#tag",
          "x>5", "a=b", "b > a", "f(a)", "(a)", "x^2", "3 × 4 m", "10 kg", "5km", "120 m²", "½", "1½", "v2.3.1", "Python 3.12",
          "RTX 4070", "ISO 9001", "1080p", "AB-1234-Z", "SAVE-20", "B12", "PS5", "+1 555 123 4567", "call 0800 123 456",
          "https://bogen.dev/a_b", "file_name.pdf", "README.md", "~/Desktop/x.png", "lena@example.com", "😀", ":)", ";-)", "<3",
          "<b>bold</b>", "Vec<u64>", "café", "naïve", "résumé", "Zoë", "Ångström", "soooo", "goooood", "Sss", "Ss!", "hmm",
          "'em", "rock 'n' roll", "don't", "o'clock", "co-op", "re-do", "read", "lead", "live", "record", "present", "wind",
          "WW II", "Chapter IX", "Plan A", "vitamin D", "1990s", "'80s", "21st", "3rd", "50-50", "10-15", "2019-2021",
          "—", "…", "!", "?", ",", ";", ":", "\"", "(", ")", "{HH AH0 L OW1}", "hi{h ˈaɪ}", "N/A", "w/o", "->", "→", "Ti"]
noise = []
for _ in range(900):
    words = [rng.choice(pieces) for _ in range(rng.randint(2, 9))]
    noise.append(" ".join(words) + rng.choice(["", ".", "?", "!", " ..."]))

corpus, seen = [], set()
for text in ui + built + numbers + singles + noise:
    text = text.strip()
    if text and text not in seen:
        seen.add(text)
        corpus.append(text)

rows, failed = [], 0
for text in corpus:
    try:
        p = dizione.phonemize(text)
        rows.append({"text": text, "ids": list(p.ids), "stress": list(p.stress)})
    except ValueError as error:
        failed += 1
        rows.append({"text": text, "error": str(error)})
with gzip.open(out_path, "wt", encoding="utf-8") as f:
    json.dump({"dizione": dizione.__version__, "fingerprint": dizione.identity()["fingerprint"], "rows": rows}, f, ensure_ascii=False)
print(f"{len(rows)} sentences, {failed} without anything to say, written to {out_path}")
