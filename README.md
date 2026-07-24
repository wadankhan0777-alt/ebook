# 📖 Folio — free books, narrated like an audiobook

**Folio** is a free, open-source web library that streams **75,000+ public-domain books and novels** — and reads them to you with realistic AI narration, right in your browser.

No accounts. No servers. No cost. Just books.

## ✨ Features

- **Netflix-style browsing** — a featured hero book, horizontally scrolling shelves for every genre (mystery, sci-fi, romance, horror, poetry…), hover cards, and a search bar covering the entire 75,000+ book catalog.
- **Personal recommendations** — "Continue reading" and "Because you read…" shelves built from your local reading history (stored only on your device).
- **A real book, not a PDF** — text flows left-to-right into a two-page spread with page numbers and a spine. Turn pages by clicking, swiping, or **dragging the corner like paper**, with a 3D page-flip animation. Single-page mode on phones.
- **Realistic AI narration** — the most natural voice on your device narrates the book sentence by sentence. On Chrome and Edge this uses neural "Natural/Online" voices that sound remarkably human.
- **Character voices** — dialogue is detected automatically, speakers are identified from the prose ("…," said Alice), and each character gets their own consistent voice, pitch, and pace, distinct from the narrator.
- **Word-by-word highlighting** — every word lights up as it's spoken, and pages turn automatically as narration advances.
- **Reads only the book** — Project Gutenberg headers, licenses, transcriber notes, and illustration tags are stripped so narration starts at the story.
- **Remembers your place** — progress is saved per book; reopening resumes exactly where you stopped.
- **Works offline, installs like an app** — it's a PWA: add it to your phone's home screen, and every book you open or download is stored on-device (IndexedDB) for instant, internet-free reading and listening. A "My downloads" shelf collects them.
- **Bring your own books** — import any `.epub` or `.txt` you own with the ＋ Import button; imported books get the same page-flip reader, narration, and highlighting.
- **Fast on big books** — a novel of 190,000+ words opens in under a second: the first page shows immediately while the rest is laid out in the background, and the finished layout is cached per screen size.

## 🚀 Run it

It's a fully static site — no build step, no dependencies.

```bash
# any static server works:
python3 -m http.server 8000
# then open http://localhost:8000
```

### Deploy free on GitHub Pages

1. Repo **Settings → Pages**
2. Source: *Deploy from a branch* → your branch → `/ (root)`
3. Your library is live at `https://<user>.github.io/<repo>/`

## 🧠 How it works

| Piece | How |
|---|---|
| Catalog & search | [Gutendex](https://gutendex.com) — an open JSON API over the Project Gutenberg catalog |
| Book text | Fetched as plain text from [Project Gutenberg](https://www.gutenberg.org) (with CORS-proxy fallbacks), then cleaned to keep only reading content |
| Pagination | Text is measured against the real page geometry and split into true pages; chapters always start on a fresh page |
| Page turns | A 3D CSS "leaf" with front/back faces, driven by pointer drag or animation |
| Narration | Web Speech API (`speechSynthesis`) — sentence-chained utterances, quote-aware dialogue segmentation, speaker attribution, per-character voice/pitch, word-boundary events for highlighting (with timing estimation as a fallback) |
| Your data | `localStorage` only — nothing leaves your device |

## 📁 Project layout

```
index.html          app shell: browse view, modal, reader, panels
css/style.css       Netflix-style browse UI + paper book styling
js/api.js           catalog access, text download/cleanup, book parsing
js/narrator.js      narration engine (voices, characters, word events)
js/reader.js        progressive pagination, page-flip, highlighting, progress
js/app.js           home rows, hero, search, modal, settings, install
js/store.js         on-device book storage (IndexedDB) for offline use
js/import.js        .epub / .txt import (EPUB unzipped with fflate)
js/vendor/fflate.js vendored MIT-licensed unzip library
sw.js               service worker: offline app shell + cover cache
manifest.webmanifest / icon.svg   PWA install metadata
```

## 📚 About modern / copyrighted novels

Folio's built-in catalog is public-domain only — that's what keeps it legal and free. Recent commercial novels and webnovels (e.g. titles on Webnovel or Royal Road) are under copyright and can't be bundled. If you own a copy of a modern book as `.epub` or `.txt`, use **＋ Import** — it becomes a fully narrated, page-flipping, offline book on your device, and never leaves it.

## 🎧 Voice quality notes

Narration uses the voices installed on your device/browser:

- **Microsoft Edge** — best quality: free neural "Natural" voices.
- **Chrome** — very good: Google cloud voices.
- **Safari / iOS** — good: Siri voices (enable Enhanced voices in Settings → Accessibility → Spoken Content).
- Voice, speed, character voices, and auto page-turn are configurable from the 🎙️ panel in the reader.

## 📜 License

Code: [MIT](LICENSE). Books: public domain, courtesy of [Project Gutenberg](https://www.gutenberg.org) volunteers.
