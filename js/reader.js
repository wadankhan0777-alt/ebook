/* ============================================================
 * reader.js — the book experience. Splits the text into real
 * pages sized to the screen, lays them out as a left-to-right
 * two-page spread (single page on phones), animates 3D page
 * turns you can click, swipe or drag like paper, highlights
 * each word as it is narrated, and remembers your place.
 * ============================================================ */

class Reader {
  constructor(narrator) {
    this.narrator = narrator;
    this.book = null;      // catalog record
    this.parsed = null;    // {words, paragraphs, sentences}
    this.pages = [];       // [{start, end}] inclusive word ranges
    this.spread = 0;
    this.fontSize = 18;
    this.autoFlip = true;
    this.single = false;
    this._session = 0;
    this._animating = false;
    this._highlighted = null;

    this.el = {
      view: document.getElementById("reader-view"),
      title: document.getElementById("reader-book-title"),
      loading: document.getElementById("reader-loading"),
      loadingText: document.getElementById("reader-loading-text"),
      loadingFill: document.getElementById("reader-loading-fill"),
      book: document.getElementById("book"),
      stage: document.getElementById("book-stage"),
      left: document.getElementById("page-left"),
      right: document.getElementById("page-right"),
      prev: document.getElementById("nav-prev"),
      next: document.getElementById("nav-next"),
      play: document.getElementById("btn-play"),
      rewind: document.getElementById("btn-rewind"),
      forward: document.getElementById("btn-forward"),
      nowSpeaking: document.getElementById("now-speaking"),
      pageIndicator: document.getElementById("page-indicator"),
      progressTrack: document.getElementById("progress-track"),
      progressFill: document.getElementById("progress-fill"),
      measurer: document.getElementById("measurer"),
      measurerContent: document.getElementById("measurer-content"),
      back: document.getElementById("reader-back"),
    };
    this._bind();
  }

  /* ================= lifecycle ================= */

  async open(book, onClose) {
    this.book = book;
    this.onClose = onClose;
    const session = ++this._session;
    this.el.view.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    this.el.title.textContent = book.title;
    this._showLoading("Downloading book text…", 0);

    try {
      // Offline first: books you've opened before load instantly from device storage.
      const stored = await BookStore.get(book.id).catch(() => null);
      if (session !== this._session) return;
      let text;
      if (stored && stored.text) {
        text = stored.text;
      } else {
        text = await FolioAPI.downloadText(book, (s) => this._showLoading(s, 5));
        if (session !== this._session) return;
        BookStore.save(BookStore.metaFrom(book), text).catch(() => {});
      }

      this._showLoading("Preparing chapters…", 8);
      await new Promise((r) => requestAnimationFrame(r));
      if (session !== this._session) return;
      this.parsed = FolioAPI.parseBook(text);
      if (!this.parsed.words.length) throw new Error("This book has no readable text.");
      this._escaped = this.parsed.words.map(escapeHTML);
      // prefix sums of character counts → smart page-size guesses
      const n = this.parsed.words.length;
      this._cum = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) this._cum[i + 1] = this._cum[i] + this.parsed.words[i].length + 1;

      this.narrator.load(this.parsed);
      const saved = Progress.get(book.id);
      const resumeWord = saved ? Math.min(saved.word || 0, n - 1) : 0;
      this._lastWord = resumeWord;
      this._highlighted = null;

      await this._startPagination(session, resumeWord, stored && stored.pag);
      if (session !== this._session) return;
      this.narrator.seekSentence(this._sentenceOfWord(resumeWord), false);
      if (saved && resumeWord > 0) toast("Resumed where you left off ✓");
    } catch (e) {
      if (session !== this._session) return;
      this._hideLoading();
      toast("Sorry — couldn't open this book. " + (e.message || ""));
      this.close();
    }
  }

  close() {
    this._session++;
    this._saveProgress();
    this.narrator.stop();
    this._clearLeaf();
    this.el.view.classList.add("hidden");
    document.body.style.overflow = "";
    this.onClose && this.onClose();
  }

  _showLoading(text, pct) {
    this.el.loading.classList.remove("hidden");
    this.el.loadingText.textContent = text;
    this.el.loadingFill.style.width = pct + "%";
  }
  _hideLoading() { this.el.loading.classList.add("hidden"); }

  /* ================= pagination =================
   * Progressive: the book appears as soon as the page holding the
   * resume position is laid out; the rest is measured in background
   * chunks. Finished layouts are cached per screen geometry, so
   * reopening a book is instant. */

  async _startPagination(session, showAtWord, cachedPag) {
    this._pagGen = (this._pagGen || 0) + 1;
    const gen = this._pagGen;
    const alive = () => session === this._session && gen === this._pagGen;

    this.single = window.innerWidth < 820;
    document.body.classList.toggle("single-page", this.single);
    this._applyFontSize();
    const rect = this.el.right.querySelector(".page-content").getBoundingClientRect();
    const geoKey = `${Math.round(rect.width)}x${Math.round(rect.height)}x${this.fontSize}x${this.single ? 1 : 2}`;

    if (cachedPag && cachedPag.key === geoKey && cachedPag.pages && cachedPag.pages.length) {
      this.pages = cachedPag.pages;
      this._pagDone = true;
      this._hideLoading();
      this._renderSpread(this._spreadOfPage(this._pageOfWord(showAtWord)));
      return;
    }

    const m = this.el.measurerContent;
    m.style.width = rect.width + "px";
    m.style.height = rect.height + "px";
    m.style.fontSize = this.fontSize + "px";

    const total = this.parsed.words.length;
    const headingStarts = this.parsed.paragraphs
      .filter((p) => p.type === "heading")
      .map((p) => p.startWord);

    this.pages = [];
    this._pagDone = false;
    const state = { charHint: 1300, hIdx: 0 };
    let w = 0;
    let shown = false;
    while (w < total) {
      const end = this._findPageEnd(w, total, headingStarts, state);
      this.pages.push({ start: w, end });
      w = end + 1;
      if (!shown && end >= showAtWord) {
        shown = true;
        this._hideLoading();
        this._renderSpread(this._spreadOfPage(this._pageOfWord(showAtWord)));
      }
      if (this.pages.length % 6 === 0) {
        if (!shown) {
          this._showLoading(`Laying out pages… ${this.pages.length}`, 8 + (w / total) * 90);
        }
        await new Promise((r) => setTimeout(r, 0));
        if (!alive()) return;
      }
    }
    m.innerHTML = "";
    this._pagDone = true;
    if (!shown) {
      this._hideLoading();
      this._renderSpread(this._spreadOfPage(this._pageOfWord(Math.min(showAtWord, total - 1))));
    } else {
      this._renderSpread(this.spread); // refresh page count & nav state
    }
    BookStore.savePagination(this.book.id, { key: geoKey, pages: this.pages }).catch(() => {});
  }

  async _restartPagination(keepWord) {
    if (!this.parsed) return;
    const session = this._session;
    this._showLoading("Reflowing pages…", 5);
    await this._startPagination(session, keepWord, null);
  }

  _findPageEnd(start, total, headingStarts, state) {
    // Never run past the next chapter heading — chapters start on a fresh page.
    while (state.hIdx < headingStarts.length && headingStarts[state.hIdx] <= start) state.hIdx++;
    const cap = state.hIdx < headingStarts.length ? headingStarts[state.hIdx] - 1 : total - 1;

    const mc = this.el.measurerContent;
    const fits = (end) => {
      mc.innerHTML = this._buildRangeHTML(start, end);
      return mc.scrollHeight <= mc.clientHeight + 2;
    };

    // First guess from character capacity of previous pages (usually 1-2 words off).
    const cum = this._cum;
    let lo = start, hi = cap;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid + 1] - cum[start] <= state.charHint) lo = mid;
      else hi = mid - 1;
    }
    let probe = Math.max(start, Math.min(lo, cap));

    let good, bad;
    if (fits(probe)) {
      good = probe;
      if (probe >= cap) { this._learn(state, start, cap); return cap; }
      let step = Math.max(8, Math.round((probe - start + 1) * 0.06));
      bad = null;
      while (good < cap) {
        const nxt = Math.min(good + step, cap);
        if (fits(nxt)) { good = nxt; step *= 2; }
        else { bad = nxt; break; }
      }
      if (bad == null) { this._learn(state, start, good); return good; }
    } else {
      good = start;
      bad = probe;
    }
    while (good + 1 < bad) {
      const mid = (good + bad) >> 1;
      if (fits(mid)) good = mid;
      else bad = mid;
    }
    this._learn(state, start, good);
    return Math.max(good, start); // always progress at least one word
  }

  _learn(state, start, end) {
    const chars = this._cum[end + 1] - this._cum[start];
    if (chars > 200) state.charHint = 0.6 * state.charHint + 0.4 * chars;
  }

  _paraOfWord(w) {
    const ps = this.parsed.paragraphs;
    let lo = 0, hi = ps.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ps[mid].startWord <= w) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  _buildRangeHTML(start, end) {
    const { paragraphs } = this.parsed;
    const esc = this._escaped;
    let html = "";
    for (let pi = this._paraOfWord(start); pi < paragraphs.length; pi++) {
      const p = paragraphs[pi];
      if (p.startWord > end) break;
      if (p.endWord < start) continue;
      const from = Math.max(p.startWord, start);
      const to = Math.min(p.endWord, end);
      let inner = "";
      for (let i = from; i <= to; i++) {
        if (inner) inner += " ";
        inner += `<span class="w" data-w="${i}">${esc[i]}</span>`;
      }
      if (p.type === "heading") {
        html += `<h2 class="chapter">${inner}</h2>`;
      } else {
        const cont = from > p.startWord ? ' class="no-indent"' : "";
        html += `<p${cont}>${inner}</p>`;
      }
    }
    return html;
  }

  /* ================= spreads & rendering ================= */

  get spreadCount() {
    return this.single ? this.pages.length : Math.ceil(this.pages.length / 2);
  }
  _pageOfSpread(s) { return this.single ? s : s * 2; }
  _spreadOfPage(p) { return this.single ? p : Math.floor(p / 2); }

  _pageOfWord(w) {
    let lo = 0, hi = this.pages.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.pages[mid].start <= w) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  _sentenceOfWord(w) {
    const s = this.parsed.sentences;
    let lo = 0, hi = s.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].start <= w) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  _renderPageInto(pageEl, pageIdx) {
    const content = pageEl.querySelector(".page-content");
    const num = pageEl.querySelector(".page-num");
    if (pageIdx == null || pageIdx < 0 || pageIdx >= this.pages.length) {
      content.innerHTML = "";
      num.textContent = "";
      return;
    }
    const pg = this.pages[pageIdx];
    content.innerHTML = this._buildRangeHTML(pg.start, pg.end);
    num.textContent = pageIdx + 1;
  }

  _renderSpread(s) {
    this.spread = Math.max(0, Math.min(s, this.spreadCount - 1));
    if (this.single) {
      this._renderPageInto(this.el.right, this.spread);
    } else {
      this._renderPageInto(this.el.left, this.spread * 2);
      this._renderPageInto(this.el.right, this.spread * 2 + 1);
    }
    this.el.prev.disabled = this.spread === 0;
    this.el.next.disabled = this._pagDone && this.spread >= this.spreadCount - 1;
    this.el.pageIndicator.textContent =
      `p. ${this._pageOfSpread(this.spread) + 1} / ${this.pages.length}${this._pagDone ? "" : "+"}`;
    const first = this.pages[this._pageOfSpread(this.spread)];
    if (first) {
      this.el.progressFill.style.width = ((first.start / this.parsed.words.length) * 100) + "%";
    }
    this._rehighlight();
    this._saveProgress();
  }

  goToWord(w, animate = true) {
    const target = this._spreadOfPage(this._pageOfWord(w));
    if (target === this.spread) { this._rehighlight(); return; }
    if (animate) this._flip(target > this.spread ? 1 : -1, target);
    else this._renderSpread(target);
  }

  nextSpread() { if (this.spread < this.spreadCount - 1) this._flip(1); }
  prevSpread() { if (this.spread > 0) this._flip(-1); }

  /** Words currently visible on this spread: [first, last]. */
  _visibleRange() {
    const a = this.pages[this._pageOfSpread(this.spread)];
    const b = this.single ? a : this.pages[this._pageOfSpread(this.spread) + 1] || a;
    return a ? [a.start, b.end] : [0, -1];
  }

  /* ================= the page-turn ================= */

  _flip(dir, targetSpread = null, fromDrag = null) {
    if (this._animating) return;
    const to = targetSpread != null ? targetSpread : this.spread + dir;
    if (to < 0 || to > this.spreadCount - 1 || to === this.spread) return;
    this._animating = true;

    const leaf = this._makeLeaf(dir, to);
    const duration = 520;
    const t0 = performance.now();
    const from = fromDrag != null ? fromDrag : 0;
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const p = from + (1 - from) * ease(t);
      this._setLeafProgress(leaf, dir, p);
      if (t < 1) requestAnimationFrame(step);
      else {
        this._clearLeaf();
        this._renderSpread(to);
        this._animating = false;
      }
    };
    requestAnimationFrame(step);
  }

  _makeLeaf(dir, to) {
    this._clearLeaf();
    const leaf = document.createElement("div");
    leaf.className = "leaf " + (dir > 0 || this.single ? "forward" : "backward");
    const front = document.createElement("div");
    front.className = "leaf-face leaf-front";
    front.innerHTML = '<div class="page-content"></div><div class="page-num"></div>';
    const back = document.createElement("div");
    back.className = "leaf-face leaf-back";
    back.innerHTML = '<div class="page-content"></div><div class="page-num"></div>';
    const shadow = document.createElement("div");
    shadow.className = "leaf-shadow";
    leaf.append(front, back, shadow);

    if (this.single) {
      const cur = this.spread, nxt = to;
      if (dir > 0) {
        this._renderPageInto(front, cur);
        this._renderPageInto(this.el.right, nxt);
        leaf.dataset.start = "0";
      } else {
        this._renderPageInto(front, nxt);      // previous page swings back in
        leaf.dataset.start = "1";              // starts folded away
      }
    } else if (dir > 0) {
      // forward: leaf covers the right half
      this._renderPageInto(front, this.spread * 2 + 1); // current right
      this._renderPageInto(back, to * 2);               // next left
      this._renderPageInto(this.el.right, to * 2 + 1);  // revealed underneath
    } else {
      // backward: leaf covers the left half
      this._renderPageInto(front, this.spread * 2);     // current left
      this._renderPageInto(back, to * 2 + 1);           // previous right
      this._renderPageInto(this.el.left, to * 2);       // revealed underneath
    }
    this._applyFontSizeTo(leaf);
    this.el.book.appendChild(leaf);
    this._leaf = leaf;
    this._setLeafProgress(leaf, dir, leaf.dataset.start === "1" ? 0 : 0);
    return leaf;
  }

  /** p: 0 → 1 flip progress. */
  _setLeafProgress(leaf, dir, p) {
    let angle;
    if (this.single) {
      angle = dir > 0 ? -180 * p : -180 * (1 - p);
    } else {
      angle = dir > 0 ? -180 * p : 180 * p;
    }
    leaf.style.transform = `rotateY(${angle}deg)`;
    const shade = Math.sin(Math.min(1, p) * Math.PI) * 0.28;
    const shadow = leaf.querySelector(".leaf-shadow");
    if (shadow) shadow.style.background = `rgba(0,0,0,${shade.toFixed(3)})`;
  }

  _clearLeaf() {
    if (this._leaf) { this._leaf.remove(); this._leaf = null; }
  }

  /* ================= drag / swipe to turn ================= */

  _bindDrag() {
    const book = this.el.book;
    let startX = 0, startY = 0, dragging = false, dir = 0, leaf = null, to = 0, lastX = 0, lastT = 0, vx = 0;

    const pageW = () => this.el.right.getBoundingClientRect().width || 1;

    book.addEventListener("pointerdown", (e) => {
      if (this._animating || !this.pages.length) return;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastT = performance.now();
      dragging = false;
      dir = 0;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragging) {
          if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy)) return;
          dir = dx < 0 ? 1 : -1; // drag left = go forward
          to = this.spread + dir;
          if (to < 0 || to > this.spreadCount - 1) { dir = 0; return; }
          dragging = true;
          this._animating = true;
          leaf = this._makeLeaf(dir, to);
          book.setPointerCapture?.(e.pointerId);
        }
        const now = performance.now();
        vx = (ev.clientX - lastX) / Math.max(1, now - lastT);
        lastX = ev.clientX;
        lastT = now;
        const p = Math.max(0, Math.min(1, (dir > 0 ? -dx : dx) / pageW()));
        this._setLeafProgress(leaf, dir, p);
      };
      const onUp = (ev) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (!dragging || !dir) return;
        const dx = ev.clientX - startX;
        const p = Math.max(0, Math.min(1, (dir > 0 ? -dx : dx) / pageW()));
        const flung = dir > 0 ? vx < -0.3 : vx > 0.3;
        this._animating = false;
        if (p > 0.28 || flung) {
          this._flip(dir, to, p);
        } else {
          // snap back
          const t0 = performance.now();
          const fall = (now) => {
            const t = Math.min(1, (now - t0) / 240);
            this._setLeafProgress(leaf, dir, p * (1 - t));
            if (t < 1) requestAnimationFrame(fall);
            else { this._clearLeaf(); this._renderSpread(this.spread); }
          };
          requestAnimationFrame(fall);
        }
        dragging = false;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }

  /* ================= highlighting & narration sync ================= */

  highlightWord(g) {
    const [first, last] = this._visibleRange();
    if (g < first || g > last) {
      this._lastWord = g;
      if (this.autoFlip && !this._animating) this.goToWord(g, true);
      return;
    }
    if (this._highlighted) this._highlighted.classList.remove("speaking");
    const span = this.el.book.querySelector(`.w[data-w="${g}"]`);
    if (span) {
      span.classList.add("speaking");
      this._highlighted = span;
    }
    this._lastWord = g;
  }

  _rehighlight() {
    this._highlighted = null;
    if (this._lastWord != null) {
      const span = this.el.book.querySelector(`.w[data-w="${this._lastWord}"]`);
      if (span) { span.classList.add("speaking"); this._highlighted = span; }
    }
  }

  /* ================= progress ================= */

  _saveProgress() {
    if (!this.book || !this.parsed || !this.pages.length) return;
    const pg = this.pages[this._pageOfSpread(this.spread)];
    if (!pg) return;
    const word = this._lastWord != null && this._lastWord >= pg.start ? this._lastWord : pg.start;
    Progress.set(this.book, word / this.parsed.words.length, word);
  }

  /* ================= wiring ================= */

  _applyFontSize() {
    this.el.view.querySelectorAll("#book .page-content").forEach((c) => {
      c.style.fontSize = this.fontSize + "px";
    });
  }
  _applyFontSizeTo(rootEl) {
    rootEl.querySelectorAll(".page-content").forEach((c) => {
      c.style.fontSize = this.fontSize + "px";
    });
  }

  async setFontSize(px) {
    this.fontSize = px;
    if (!this.parsed) return;
    const keep = this._lastWord ?? (this.pages[this._pageOfSpread(this.spread)] || {}).start ?? 0;
    await this._restartPagination(keep);
  }

  _bind() {
    this.el.back.addEventListener("click", () => this.close());
    this.el.next.addEventListener("click", () => this.nextSpread());
    this.el.prev.addEventListener("click", () => this.prevSpread());
    this.el.play.addEventListener("click", () => {
      if (!this.narrator.supported) {
        toast("Narration isn't supported in this browser.");
        return;
      }
      this.narrator.toggle();
    });
    this.el.rewind.addEventListener("click", () => this.narrator.prev());
    this.el.forward.addEventListener("click", () => this.narrator.next());

    // click a word to start narration from that exact sentence
    this.el.book.addEventListener("click", (e) => {
      const w = e.target.closest(".w");
      if (w) {
        const g = +w.dataset.w;
        this.narrator.seekSentence(this._sentenceOfWord(g), this.narrator.playing);
        this._lastWord = g;
        this._rehighlight();
      }
    });

    this._bindDrag();

    this.el.progressTrack.addEventListener("click", (e) => {
      if (!this.parsed) return;
      const r = this.el.progressTrack.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const w = Math.floor(frac * (this.parsed.words.length - 1));
      this.narrator.seekSentence(this._sentenceOfWord(w), this.narrator.playing);
      this.goToWord(w, false);
    });

    document.addEventListener("keydown", (e) => {
      if (this.el.view.classList.contains("hidden")) return;
      if (e.key === "ArrowRight") this.nextSpread();
      else if (e.key === "ArrowLeft") this.prevSpread();
      else if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        this.narrator.toggle();
      } else if (e.key === "Escape") this.close();
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (this.el.view.classList.contains("hidden") || !this.parsed) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const keep = this._lastWord ?? (this.pages[this._pageOfSpread(this.spread)] || {}).start ?? 0;
        this._restartPagination(keep);
      }, 350);
    });

    // narrator → reader sync
    this.narrator.onWord = (g) => this.highlightWord(g);
    this.narrator.onSentence = (idx) => {
      const s = this.parsed && this.parsed.sentences[idx];
      if (!s) return;
      const preview = this.parsed.words.slice(s.start, Math.min(s.end + 1, s.start + 12)).join(" ");
      this.el.nowSpeaking.textContent = "“" + preview + (s.end - s.start > 11 ? "…" : "") + "”";
      this._saveProgress();
    };
    this.narrator.onState = (playing) => {
      this.el.play.textContent = playing ? "⏸" : "▶";
      this.el.play.title = playing ? "Pause narration" : "Play narration";
    };
    this.narrator.onEnd = () => toast("📖 The End — narration finished.");
  }
}

/* ---------------- shared helpers ---------------- */

const Progress = {
  key: (id) => "folio:progress:" + id,
  get(id) {
    try { return JSON.parse(localStorage.getItem(this.key(id))); } catch { return null; }
  },
  set(book, pct, word) {
    try {
      localStorage.setItem(this.key(book.id), JSON.stringify({
        id: book.id,
        title: book.title,
        author: FolioAPI.authorName(book),
        cover: FolioAPI.coverUrl(book),
        subjects: (book.subjects || []).slice(0, 4),
        pct: Math.round(pct * 100),
        word,
        ts: Date.now(),
      }));
    } catch { /* storage full/blocked — reading still works */ }
  },
  all() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("folio:progress:")) {
        try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ }
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  },
};

function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toast(msg, ms = 3200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), ms);
}
