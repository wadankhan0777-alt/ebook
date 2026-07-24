/* ============================================================
 * app.js — Netflix-style browsing: hero banner, genre rows
 * with lazy loading, live search, book detail modal, continue
 * reading + personalized "because you read" recommendations.
 * ============================================================ */

(() => {
  const narrator = new Narrator();
  const reader = new Reader(narrator);
  const bookCache = new Map(); // id -> catalog record

  const $ = (id) => document.getElementById(id);
  const homeView = $("home-view");

  /* ================= rows config ================= */

  const GENRE_ROWS = [
    { title: "Trending now", sub: "most read this week", query: {} },
    { title: "Mystery & Detective", query: { topic: "detective" } },
    { title: "Science Fiction", query: { topic: "science fiction" } },
    { title: "Romance", query: { topic: "romance" } },
    { title: "Adventure", query: { topic: "adventure" } },
    { title: "Horror & Gothic", query: { topic: "horror" } },
    { title: "Fantasy & Myth", query: { topic: "fantasy" } },
    { title: "Children's Classics", query: { topic: "children" } },
    { title: "Humor", query: { topic: "humor" } },
    { title: "History & Biography", query: { topic: "history" } },
    { title: "Philosophy & Ideas", query: { topic: "philosophy" } },
    { title: "Poetry", query: { topic: "poetry" } },
  ];

  /* ================= cards ================= */

  function cardEl(book, progressPct) {
    const cover = FolioAPI.coverUrl(book);
    const author = FolioAPI.authorName(book);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-cover">
        ${cover ? `<img loading="lazy" src="${escapeHTML(cover)}" alt="">` : ""}
        <div class="card-hover">
          <div class="ch-play">▶</div>
          <div class="ch-title">${escapeHTML(book.title)}</div>
          <div class="ch-downloads">⬇ ${Number(book.download_count || 0).toLocaleString()} readers</div>
        </div>
        ${progressPct ? `<div class="card-progress"><div style="width:${progressPct}%"></div></div>` : ""}
      </div>`;
    const img = card.querySelector("img");
    if (img) {
      img.addEventListener("error", () => {
        img.remove();
        card.querySelector(".card-cover").insertAdjacentHTML(
          "afterbegin",
          `<div class="cover-fallback"><div class="cf-title">${escapeHTML(book.title)}</div><div class="cf-author">${escapeHTML(author)}</div></div>`
        );
      });
    } else {
      card.querySelector(".card-cover").insertAdjacentHTML(
        "afterbegin",
        `<div class="cover-fallback"><div class="cf-title">${escapeHTML(book.title)}</div><div class="cf-author">${escapeHTML(author)}</div></div>`
      );
    }
    card.addEventListener("click", () => openModal(book));
    return card;
  }

  /* ================= rows ================= */

  function rowShell(title, sub) {
    const row = document.createElement("section");
    row.className = "row";
    row.innerHTML = `
      <h2 class="row-title">${escapeHTML(title)}${sub ? `<span class="row-sub">${escapeHTML(sub)}</span>` : ""}</h2>
      <div class="row-skeleton">${'<div class="skel"></div>'.repeat(8)}</div>
      <div class="row-scroller hidden"></div>`;
    return row;
  }

  async function fillRow(row, query) {
    try {
      const data = await FolioAPI.books(query);
      const scroller = row.querySelector(".row-scroller");
      const books = data.results.slice(0, 24);
      if (!books.length) { row.remove(); return; }
      for (const b of books) {
        bookCache.set(b.id, b);
        scroller.appendChild(cardEl(b));
      }
      row.querySelector(".row-skeleton").remove();
      scroller.classList.remove("hidden");
    } catch {
      row.querySelector(".row-skeleton").innerHTML =
        '<p class="muted" style="padding:10px 0">Couldn\'t load this shelf — check your connection and refresh.</p>';
    }
  }

  function lazyRow(title, sub, query) {
    const row = rowShell(title, sub);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fillRow(row, query);
      }
    }, { rootMargin: "600px" });
    io.observe(row);
    return row;
  }

  function buildRows() {
    const rows = $("rows");
    rows.innerHTML = "";

    // Continue reading
    const history = Progress.all().filter((h) => h.pct > 0 && h.pct < 99);
    if (history.length) {
      const row = rowShell("Continue reading", "pick up where you left off");
      const scroller = row.querySelector(".row-scroller");
      row.querySelector(".row-skeleton").remove();
      scroller.classList.remove("hidden");
      rows.appendChild(row);
      for (const h of history.slice(0, 20)) {
        const fake = {
          id: h.id, title: h.title, download_count: 0,
          authors: [{ name: h.author }], subjects: h.subjects || [],
          formats: h.cover ? { "image/jpeg": h.cover } : {},
        };
        const card = cardEl(fake, h.pct);
        card.addEventListener("click", () => openBookById(h.id), { capture: true });
        scroller.appendChild(card);
      }
    }

    // Personalized: because you read X
    const seed = Progress.all().find((h) => h.subjects && h.subjects.length);
    if (seed) {
      const topic = seed.subjects[0].split(" -- ")[0];
      const short = seed.title.length > 34 ? seed.title.slice(0, 34) + "…" : seed.title;
      rows.appendChild(lazyRow(`Because you read “${short}”`, "more " + topic.toLowerCase(), { topic }));
    }

    for (const g of GENRE_ROWS) {
      rows.appendChild(lazyRow(g.title, g.sub, g.query));
    }
  }

  /* ================= hero ================= */

  async function buildHero() {
    try {
      const data = await FolioAPI.books({});
      const withCovers = data.results.filter((b) => FolioAPI.coverUrl(b));
      if (!withCovers.length) return;
      const pick = withCovers[new Date().getDate() % Math.min(withCovers.length, 10)];
      bookCache.set(pick.id, pick);
      const cover = FolioAPI.coverUrl(pick);
      $("hero-backdrop").style.backgroundImage = `url("${cover}")`;
      $("hero-cover").src = cover;
      $("hero-title").textContent = pick.title;
      $("hero-author").textContent = "by " + FolioAPI.authorName(pick);
      $("hero-desc").textContent =
        (pick.summaries && pick.summaries[0]) ||
        (pick.subjects || []).slice(0, 3).map((s) => s.split(" -- ")[0]).join(" · ");
      $("hero-read").onclick = () => openReader(pick);
      $("hero-info").onclick = () => openModal(pick);
      $("hero").classList.remove("hidden");
    } catch { /* hero is optional */ }
  }

  /* ================= search ================= */

  let searchTimer = null;
  let searchState = { q: "", page: 1, done: false, loading: false };

  $("search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => runSearch(q), 380);
  });

  async function runSearch(q) {
    const results = $("search-results");
    const grid = $("search-results-grid");
    const moreBtn = $("search-more");
    if (!q) {
      results.classList.add("hidden");
      $("rows").classList.remove("hidden");
      $("hero").classList.toggle("hidden", !$("hero-title").textContent);
      return;
    }
    searchState = { q, page: 1, done: false, loading: false };
    $("rows").classList.add("hidden");
    $("hero").classList.add("hidden");
    results.classList.remove("hidden");
    $("search-results-title").textContent = `Searching “${q}”…`;
    grid.innerHTML = '<div class="skel"></div>'.repeat(6);
    moreBtn.classList.add("hidden");
    try {
      const data = await FolioAPI.books({ search: q });
      if (searchState.q !== q) return;
      grid.innerHTML = "";
      $("search-results-title").textContent =
        data.count ? `${data.count.toLocaleString()} results for “${q}”` : `No results for “${q}” — try an author or title`;
      for (const b of data.results) {
        bookCache.set(b.id, b);
        grid.appendChild(cardEl(b));
      }
      searchState.done = !data.next;
      moreBtn.classList.toggle("hidden", searchState.done);
    } catch {
      $("search-results-title").textContent = "Search failed — check your connection and try again.";
      grid.innerHTML = "";
    }
  }

  $("search-more").addEventListener("click", async () => {
    if (searchState.loading || searchState.done) return;
    searchState.loading = true;
    $("search-more").textContent = "Loading…";
    try {
      const data = await FolioAPI.books({ search: searchState.q, page: ++searchState.page });
      for (const b of data.results) {
        bookCache.set(b.id, b);
        $("search-results-grid").appendChild(cardEl(b));
      }
      searchState.done = !data.next;
      $("search-more").classList.toggle("hidden", searchState.done);
    } catch { /* keep button for retry */ }
    searchState.loading = false;
    $("search-more").textContent = "Load more";
  });

  /* ================= modal ================= */

  function openModal(book) {
    const cover = FolioAPI.coverUrl(book);
    $("modal-banner").style.backgroundImage = cover ? `url("${cover}")` : "";
    $("modal-cover").src = cover || "";
    $("modal-cover").style.display = cover ? "" : "none";
    $("modal-title").textContent = book.title;
    $("modal-author").textContent = "by " + FolioAPI.authorName(book);
    const stats = [];
    if (book.download_count) stats.push("⬇ " + book.download_count.toLocaleString() + " readers");
    if (book.authors && book.authors[0] && book.authors[0].birth_year) {
      stats.push(book.authors[0].birth_year + "–" + (book.authors[0].death_year || ""));
    }
    stats.push("Public domain · free forever");
    $("modal-stats").textContent = stats.join("  ·  ");

    const saved = Progress.get(book.id);
    const resume = $("modal-resume");
    if (saved && saved.pct > 0) {
      resume.textContent = `▸ You're ${saved.pct}% through — Read & Listen resumes your spot.`;
      resume.classList.remove("hidden");
    } else resume.classList.add("hidden");

    const subj = $("modal-subjects");
    subj.innerHTML = "";
    for (const s of (book.subjects || []).slice(0, 6)) {
      const chip = document.createElement("button");
      chip.className = "subject-chip";
      chip.textContent = s.split(" -- ")[0];
      chip.addEventListener("click", () => {
        closeModal();
        $("search-input").value = chip.textContent;
        runSearch(chip.textContent);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      subj.appendChild(chip);
    }

    $("modal-read").onclick = () => { closeModal(); openReader(book); };
    $("modal-backdrop").classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    $("modal-backdrop").classList.add("hidden");
    document.body.style.overflow = "";
  }
  $("modal-close").addEventListener("click", closeModal);
  $("modal-backdrop").addEventListener("click", (e) => {
    if (e.target === $("modal-backdrop")) closeModal();
  });

  async function openBookById(id) {
    if (bookCache.has(id)) { openModal(bookCache.get(id)); return; }
    toast("Fetching book details…");
    try {
      const data = await FolioAPI.books({ ids: [id] });
      if (data.results[0]) {
        bookCache.set(id, data.results[0]);
        openModal(data.results[0]);
      }
    } catch { toast("Couldn't load that book right now."); }
  }

  /* ================= reader hookup ================= */

  function openReader(book) {
    homeView.classList.add("hidden");
    reader.open(book, () => {
      homeView.classList.remove("hidden");
      buildRows(); // refresh continue-reading + recommendations
    });
  }

  /* ================= reader settings panels ================= */

  const voicePanel = $("voice-panel");
  const fontPanel = $("font-panel");
  $("btn-voices").addEventListener("click", (e) => {
    e.stopPropagation();
    voicePanel.classList.toggle("hidden");
    fontPanel.classList.add("hidden");
  });
  $("btn-fontsize").addEventListener("click", (e) => {
    e.stopPropagation();
    fontPanel.classList.toggle("hidden");
    voicePanel.classList.add("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!voicePanel.contains(e.target) && e.target.id !== "btn-voices") voicePanel.classList.add("hidden");
    if (!fontPanel.contains(e.target) && e.target.id !== "btn-fontsize") fontPanel.classList.add("hidden");
  });

  function fillVoiceSelect(voices) {
    const sel = $("sel-voice");
    sel.innerHTML = "";
    if (!voices.length) {
      sel.innerHTML = "<option>No voices found — narration unavailable</option>";
      return;
    }
    voices.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = v.name + " (" + v.lang + ")" + (i === 0 ? "  ★ best" : "");
      sel.appendChild(opt);
    });
    sel.value = String(voices.indexOf(narrator.narratorVoice));
  }
  narrator.onVoicesReady = fillVoiceSelect;
  if (narrator.voices.length) fillVoiceSelect(narrator.voices);

  $("sel-voice").addEventListener("change", (e) => {
    const v = narrator.voices[+e.target.value];
    if (v) narrator.setNarratorVoice(v);
  });
  $("chk-characters").addEventListener("change", (e) => {
    narrator.characterVoices = e.target.checked;
  });
  $("chk-autoflip").addEventListener("change", (e) => {
    reader.autoFlip = e.target.checked;
  });
  $("rng-rate").addEventListener("input", (e) => {
    const r = +e.target.value;
    $("rate-label").textContent = r.toFixed(2).replace(/0$/, "") + "×";
    clearTimeout(window._rateTimer);
    window._rateTimer = setTimeout(() => narrator.setRate(r), 250);
  });

  document.querySelectorAll("#font-panel .font-btns button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#font-panel .font-btns button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      reader.setFontSize(+btn.dataset.size);
    });
  });

  /* ================= boot ================= */

  $("brand-home").addEventListener("click", () => {
    $("search-input").value = "";
    runSearch("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  buildHero();
  buildRows();

  // small debug/testing surface
  window.Folio = { narrator, reader, openReader, openModal, runSearch };
})();
