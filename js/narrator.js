/* ============================================================
 * narrator.js — realistic AI narration built on the Web Speech
 * API. Picks the most natural voice available on the device,
 * gives dialogue its own character voices (stable per speaker,
 * with distinct pitch/rate), fires word-level callbacks for
 * highlighting, and falls back to timing estimation when a
 * voice engine does not emit word boundaries.
 * ============================================================ */

class Narrator {
  constructor() {
    this.synth = window.speechSynthesis;
    this.voices = [];            // ranked English voices, best first
    this.narratorVoice = null;   // user-selectable
    this.characterVoices = true;
    this.rate = 0.95;

    this.book = null;            // parsed book from FolioAPI.parseBook
    this.sentenceIdx = 0;
    this.playing = false;
    this._utter = null;          // keep a ref (Chrome GC workaround)
    this._estimator = null;
    this._speakerMap = new Map();// speaker name -> {voice,pitch,rate}
    this._session = 0;           // invalidates stale async callbacks

    // callbacks
    this.onWord = null;          // (globalWordIndex)
    this.onSentence = null;      // (sentenceIdx)
    this.onEnd = null;           // whole book finished
    this.onState = null;         // (isPlaying)

    if (this.synth) {
      this._loadVoices();
      this.synth.addEventListener?.("voiceschanged", () => this._loadVoices());
    }
  }

  get supported() { return !!this.synth; }

  /* ---------- voice discovery & ranking ---------- */

  _loadVoices() {
    const all = this.synth.getVoices() || [];
    const en = all.filter((v) => /^en[-_]/i.test(v.lang) || v.lang === "en");
    const score = (v) => {
      const n = v.name.toLowerCase();
      let s = 0;
      if (n.includes("natural")) s += 60;          // Edge neural voices
      if (n.includes("neural")) s += 55;
      if (n.includes("online")) s += 40;
      if (n.includes("premium") || n.includes("enhanced")) s += 35;
      if (n.includes("google")) s += 30;           // Chrome remote voices
      if (n.includes("siri")) s += 25;
      if (/^en[-_](us|gb)/i.test(v.lang)) s += 10;
      if (v.localService === false) s += 8;        // cloud voices sound better
      if (n.includes("compact")) s -= 20;
      return s;
    };
    en.sort((a, b) => score(b) - score(a));
    this.voices = en;
    if (!this.narratorVoice || !en.includes(this.narratorVoice)) {
      this.narratorVoice = en[0] || all[0] || null;
    }
    this.onVoicesReady && this.onVoicesReady(this.voices);
  }

  setNarratorVoice(voice) {
    this.narratorVoice = voice;
    this._speakerMap.clear();
    if (this.playing) this._restartCurrent();
  }

  setRate(rate) {
    this.rate = rate;
    if (this.playing) this._restartCurrent();
  }

  /** Stable, distinct voice+pitch per character name. */
  _voiceForSpeaker(name) {
    const key = (name || "character").toLowerCase();
    if (this._speakerMap.has(key)) return this._speakerMap.get(key);

    const pool = this.voices.filter((v) => v !== this.narratorVoice).slice(0, 6);
    const variants = [
      { pitch: 1.25, rate: 1.02 },
      { pitch: 0.8,  rate: 0.95 },
      { pitch: 1.4,  rate: 1.05 },
      { pitch: 0.65, rate: 0.9  },
      { pitch: 1.1,  rate: 1.0  },
      { pitch: 0.9,  rate: 1.06 },
    ];
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const idx = this._speakerMap.size % variants.length;
    const v = {
      voice: pool.length ? pool[h % pool.length] : this.narratorVoice,
      ...variants[(h + idx) % variants.length],
    };
    this._speakerMap.set(key, v);
    return v;
  }

  /* ---------- playback ---------- */

  load(parsedBook, startSentence = 0) {
    this.stop();
    this.book = parsedBook;
    this.sentenceIdx = startSentence;
    this._speakerMap.clear();
  }

  play() {
    if (!this.supported || !this.book) return;
    if (this.playing) return;
    this.playing = true;
    this.onState && this.onState(true);
    this._speakSentence(this.sentenceIdx);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._session++;
    this._clearEstimator();
    this.synth.cancel();
    this.onState && this.onState(false);
  }

  stop() {
    this.playing = false;
    this._session++;
    this._clearEstimator();
    this.synth && this.synth.cancel();
    this.onState && this.onState(false);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seekSentence(idx, keepPlaying) {
    const wasPlaying = keepPlaying ?? this.playing;
    this.pause();
    this.sentenceIdx = Math.max(0, Math.min(idx, this.book.sentences.length - 1));
    if (wasPlaying) this.play();
    else this.onSentence && this.onSentence(this.sentenceIdx);
  }

  next() { this.seekSentence(this.sentenceIdx + 1); }
  prev() { this.seekSentence(this.sentenceIdx - 1); }

  _restartCurrent() {
    const idx = this.sentenceIdx;
    this.pause();
    this.sentenceIdx = idx;
    this.play();
  }

  /* ---------- internals ---------- */

  _speakSentence(idx) {
    if (!this.playing) return;
    const sentences = this.book.sentences;
    if (idx >= sentences.length) {
      this.playing = false;
      this.onState && this.onState(false);
      this.onEnd && this.onEnd();
      return;
    }
    this.sentenceIdx = idx;
    this.onSentence && this.onSentence(idx);

    const session = ++this._session;
    const segments = sentences[idx].segments.slice();
    const speakNextSegment = () => {
      if (session !== this._session || !this.playing) return;
      const seg = segments.shift();
      if (!seg) {
        // brief natural pause between sentences at paragraph ends
        this._speakSentence(idx + 1);
        return;
      }
      this._speakSegment(seg, session, speakNextSegment);
    };
    speakNextSegment();
  }

  _speakSegment(seg, session, done) {
    const words = this.book.words;
    // Build the spoken string, remembering each word's char offset so
    // boundary events can be mapped back to a global word index.
    let text = "";
    const offsets = []; // [charStart, globalWordIndex]
    for (let g = seg.start; g <= seg.end; g++) {
      let w = words[g].replace(/[“”"«»_]/g, "");
      if (!w) w = " ";
      if (text) text += " ";
      offsets.push([text.length, g]);
      text += w;
    }
    if (!text.trim()) { done(); return; }

    const u = new SpeechSynthesisUtterance(text);
    const isDialogue = seg.type === "dialogue" && this.characterVoices;
    if (isDialogue) {
      const cv = this._voiceForSpeaker(seg.speaker);
      if (cv.voice) u.voice = cv.voice;
      u.pitch = cv.pitch;
      u.rate = this.rate * cv.rate;
    } else {
      if (this.narratorVoice) u.voice = this.narratorVoice;
      u.pitch = 1;
      u.rate = this.rate;
    }

    let sawBoundary = false;
    u.onboundary = (e) => {
      if (session !== this._session) return;
      if (e.name && e.name !== "word") return;
      sawBoundary = true;
      this._clearEstimator();
      const g = this._wordAtChar(offsets, e.charIndex);
      if (g != null && this.onWord) this.onWord(g);
    };
    u.onstart = () => {
      if (session !== this._session) return;
      if (this.onWord) this.onWord(seg.start);
      // Fallback highlighting for engines without boundary events.
      const startedAt = performance.now();
      const charsPerSec = 15 * u.rate;
      const durationMs = (text.length / charsPerSec) * 1000;
      this._clearEstimator();
      this._estimator = setInterval(() => {
        if (sawBoundary || session !== this._session) { this._clearEstimator(); return; }
        const frac = Math.min(1, (performance.now() - startedAt) / durationMs);
        const char = Math.floor(frac * text.length);
        const g = this._wordAtChar(offsets, char);
        if (g != null && this.onWord) this.onWord(g);
      }, 220);
    };
    u.onend = () => {
      if (session !== this._session) return;
      this._clearEstimator();
      done();
    };
    u.onerror = (e) => {
      if (session !== this._session) return;
      this._clearEstimator();
      if (e.error === "interrupted" || e.error === "canceled") return;
      done(); // skip past problem segments rather than stalling
    };

    this._utter = u;
    this.synth.speak(u);
  }

  _wordAtChar(offsets, charIndex) {
    let g = null;
    for (const [start, global] of offsets) {
      if (start <= charIndex) g = global;
      else break;
    }
    return g;
  }

  _clearEstimator() {
    if (this._estimator) { clearInterval(this._estimator); this._estimator = null; }
  }
}
