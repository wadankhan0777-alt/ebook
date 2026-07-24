/* ============================================================
 * api.js — open catalog (Gutendex / Project Gutenberg) access,
 * text download, cleanup and parsing into a narratable book.
 * ============================================================ */

const FolioAPI = (() => {
  const CATALOG = "https://gutendex.com/books";

  // CORS fallbacks: try direct first, then public CORS proxies.
  const PROXIES = [
    (u) => u,
    (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
  ];

  async function fetchOnce(url, asJson, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return asJson ? await res.json() : await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Try every URL candidate directly, then through each proxy —
   *  with a per-attempt timeout so nothing hangs forever. */
  async function fetchWithFallback(urlOrUrls, asJson, timeoutMs = 15000) {
    const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
    let lastErr;
    for (const wrap of PROXIES) {
      for (const u of urls) {
        try {
          return await fetchOnce(wrap(u), asJson, timeoutMs);
        } catch (e) {
          lastErr = e;
        }
      }
    }
    throw lastErr || new Error("Network error");
  }

  /** Query the catalog. opts: {search, topic, page, ids, sort} */
  async function books(opts = {}) {
    const p = new URLSearchParams();
    if (opts.search) p.set("search", opts.search);
    if (opts.topic) p.set("topic", opts.topic);
    if (opts.page) p.set("page", opts.page);
    if (opts.ids) p.set("ids", opts.ids.join(","));
    p.set("languages", opts.languages || "en");
    if (opts.sort) p.set("sort", opts.sort);
    const data = await fetchWithFallback(CATALOG + "/?" + p.toString(), true);
    data.results = (data.results || []).filter((b) => plainTextUrl(b));
    return data;
  }

  function coverUrl(book) {
    return (book.formats && book.formats["image/jpeg"]) || null;
  }

  function plainTextUrl(book) {
    const f = book.formats || {};
    for (const key of Object.keys(f)) {
      if (key.startsWith("text/plain") && !f[key].endsWith(".zip")) return f[key];
    }
    return null;
  }

  function authorName(book) {
    if (!book.authors || !book.authors.length) return "Unknown author";
    return book.authors
      .map((a) => a.name.split(", ").reverse().join(" "))
      .join(", ");
  }

  /* ---------------- text download & cleanup ---------------- */

  async function downloadText(book, onStatus) {
    const urls = [];
    const fmt = plainTextUrl(book);
    if (fmt) urls.push(fmt);
    if (typeof book.id === "number") {
      // well-known Gutenberg layouts, in case the catalog URL stalls
      urls.push(`https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.txt`);
      urls.push(`https://www.gutenberg.org/files/${book.id}/${book.id}-0.txt`);
    }
    const unique = [...new Set(urls)];
    if (!unique.length) throw new Error("No readable text available for this book.");
    onStatus && onStatus("Downloading book text…");
    const raw = await fetchWithFallback(unique, false, 20000);
    return cleanGutenbergText(raw);
  }

  /**
   * Keep only the reading content: strip the Project Gutenberg
   * header/license, footers, transcriber notes and illustration tags.
   */
  function cleanGutenbergText(raw) {
    let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const startMatch = text.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
    if (startMatch) text = text.slice(startMatch.index + startMatch[0].length);
    const endMatch = text.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
    if (endMatch) text = text.slice(0, endMatch.index);

    // Illustration / decoration tags, credit lines, page markers.
    text = text
      .replace(/\[Illustration[^\]]*\]/gi, "")
      .replace(/^\s*(produced by|e-?text prepared by|transcribed from|this etext was)[^\n]*\n(?:[^\n]+\n)*?\n/im, "\n")
      .replace(/\{[0-9ivxlc]+\}/gi, "")     // {page} markers
      .replace(/\[pg?\.?\s*\d+\]/gi, "");   // [pg 12]

    // Emphasis markup used in plain-text Gutenberg files.
    text = text.replace(/_([^_\n]{1,80})_/g, "$1");

    return text.trim();
  }

  /* ---------------- parse into paragraphs / words / sentences ---------------- */

  const HEADING_RE = /^(chapter|book|part|volume|canto|act|scene|stave|letter|epilogue|prologue|preface|introduction)\b[\s.:\dIVXLC-]*/i;
  const ABBREV = new Set(["mr.", "mrs.", "ms.", "dr.", "st.", "no.", "vol.", "etc.", "jr.", "sr.", "prof.", "rev.", "hon.", "capt.", "col.", "gen.", "lieut.", "esq.", "i.e.", "e.g.", "vs.", "viz."]);

  /**
   * Returns:
   * {
   *   words:      [string]                      — every visible word token
   *   paragraphs: [{type, startWord, endWord}]  — type: 'heading' | 'para'
   *   sentences:  [{start, end, para, segments:[{start,end,type,speaker}]}]
   * }
   * All indices are inclusive global word indices.
   */
  function parseBook(text) {
    const rawParas = text.split(/\n\s*\n+/);
    const words = [];
    const paragraphs = [];
    const sentences = [];

    for (const rp of rawParas) {
      const collapsed = rp.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      if (!collapsed) continue;
      const toks = collapsed.split(" ").filter(Boolean);
      if (!toks.length) continue;

      const startWord = words.length;
      for (const t of toks) words.push(t);
      const endWord = words.length - 1;

      const isHeading =
        toks.length <= 12 &&
        (HEADING_RE.test(collapsed) ||
          (collapsed === collapsed.toUpperCase() && /[A-Z]/.test(collapsed) && toks.length <= 8));

      paragraphs.push({ type: isHeading ? "heading" : "para", startWord, endWord });

      // Sentence boundaries inside this paragraph.
      let sStart = startWord;
      for (let i = startWord; i <= endWord; i++) {
        const w = words[i];
        const isLast = i === endWord;
        const endsSentence =
          /[.!?…]["'”’)\]]*$/.test(w) && !ABBREV.has(w.toLowerCase().replace(/["'”’)\]]+$/, ""));
        if (isLast || endsSentence) {
          sentences.push(makeSentence(words, sStart, i, paragraphs.length - 1));
          sStart = i + 1;
        }
      }
    }
    return { words, paragraphs, sentences };
  }

  const OPEN_Q = /[“"«]/;
  const CLOSE_Q = /[”"»]/;
  const SAID_VERBS = "said|says|replied|asked|answered|cried|exclaimed|whispered|shouted|muttered|observed|returned|continued|added|inquired|remarked|repeated|interrupted|murmured|demanded|declared|suggested|called|began|thought|protested|admitted|agreed|laughed|sighed|groaned|snapped|urged|pleaded|insisted|retorted|ventured|stammered|gasped";
  const AFTER_RE = new RegExp("^(?:" + SAID_VERBS + ")$", "i");
  const NAME_RE = /^(?:Mr\.|Mrs\.|Miss|Ms\.|Dr\.|Lady|Lord|Sir|Aunt|Uncle|Captain|Professor|Madame|Monsieur)?$|^[A-Z][a-zA-Z'’-]+[,.;:!?]*$/;

  function makeSentence(words, start, end, para) {
    // Split into narration vs dialogue segments by tracking quote characters.
    const segments = [];
    let segStart = start;
    let inQuote = false;
    for (let i = start; i <= end; i++) {
      const w = words[i];
      const opens = OPEN_Q.test(w) && !inQuote;
      const closes = CLOSE_Q.test(w) && (inQuote || OPEN_Q.test(w));
      if (opens) {
        if (i > segStart) {
          segments.push({ start: segStart, end: i - 1, type: inQuote ? "dialogue" : "narration" });
        }
        segStart = i;
        inQuote = true;
      }
      if (closes && inQuote) {
        segments.push({ start: segStart, end: i, type: "dialogue" });
        segStart = i + 1;
        inQuote = false;
      }
    }
    if (segStart <= end) {
      segments.push({ start: segStart, end, type: inQuote ? "dialogue" : "narration" });
    }

    // Attribute a speaker to dialogue: look for “…," said NAME’ patterns
    // in the narration right after (or before) the quote.
    let speaker = null;
    for (let s = 0; s < segments.length; s++) {
      if (segments[s].type !== "dialogue") continue;
      const next = segments[s + 1];
      if (next && next.type === "narration") {
        speaker = findSpeaker(words, next.start, Math.min(next.end, next.start + 5)) || speaker;
      }
      if (!speaker) {
        const prev = segments[s - 1];
        if (prev && prev.type === "narration") {
          speaker = findSpeaker(words, prev.start, prev.end) || speaker;
        }
      }
      segments[s].speaker = speaker || "character";
    }
    return { start, end, para, segments };
  }

  function findSpeaker(words, from, to) {
    for (let i = from; i <= to; i++) {
      const w = words[i].replace(/[^a-zA-Z]/g, "").toLowerCase();
      if (AFTER_RE.test(w)) {
        // verb + Name  ("said Alice")
        for (let j = i + 1; j <= Math.min(to, i + 3); j++) {
          const cand = words[j];
          if (/^(?:the|a|an|his|her|their|my|our|old|young|little)$/i.test(cand)) continue;
          if (/^[A-Z]/.test(cand)) return cand.replace(/[^A-Za-z'’-]/g, "");
          break;
        }
        // Name + verb  ("Alice said")
        for (let j = i - 1; j >= Math.max(from, i - 2); j--) {
          const cand = words[j];
          if (/^[A-Z]/.test(cand) && !OPEN_Q.test(cand)) return cand.replace(/[^A-Za-z'’-]/g, "");
        }
      }
    }
    return null;
  }

  return { books, coverUrl, plainTextUrl, authorName, downloadText, parseBook, cleanText: cleanGutenbergText };
})();
