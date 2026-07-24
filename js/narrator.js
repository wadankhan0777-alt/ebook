/* ============================================================
 * narrator.js — the voice of Folio, with two engines:
 *
 *  ✨ NEURAL — Kokoro-82M (open-source, Apache-2.0), a frontier
 *     on-device TTS run 100% in the browser via transformers.js.
 *     Deeply realistic: natural intonation, breaths and phrasing.
 *     Different neural voices are cast per character in dialogue.
 *
 *  ⚡ SYSTEM — the Web Speech API voices built into the device,
 *     instant and lightweight; used as automatic fallback.
 *
 * Both engines narrate sentence by sentence with word-level
 * callbacks for highlighting, breathing pauses at sentence and
 * paragraph boundaries, and stable character voice casting.
 * ============================================================ */

/** One shared AudioContext for narration + mood music. */
const AudioHub = {
  _ctx: null,
  ctx() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this._ctx.state === "suspended") this._ctx.resume().catch(() => {});
    return this._ctx;
  },
};

// The AI voice engine ships with the site (js/vendor/kokoro.web.js +
// ONNX runtime): no third-party CDN in the critical path. The CDN is
// kept only as a last-resort fallback. Voice model weights (~90 MB)
// stream once from the Hugging Face hub and are cached by the browser.
const KOKORO_LOCAL = () => new URL("js/vendor/kokoro.web.js", document.baseURI).href;
const KOKORO_WASM_DIR = () => new URL("js/vendor/", document.baseURI).href;
const KOKORO_CDN = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

const NEURAL_VOICES = [
  { id: "af_heart",    label: "Heart — warm US female ★" },
  { id: "af_bella",    label: "Bella — expressive US female" },
  { id: "am_michael",  label: "Michael — deep US male" },
  { id: "bf_emma",     label: "Emma — gentle British female" },
  { id: "bm_george",   label: "George — classic British male" },
  { id: "af_nicole",   label: "Nicole — soft-spoken US female" },
  { id: "am_fenrir",   label: "Fenrir — intense US male" },
  { id: "bf_isabella", label: "Isabella — bright British female" },
  { id: "bm_lewis",    label: "Lewis — steady British male" },
  { id: "am_puck",     label: "Puck — playful US male" },
];

class Narrator {
  constructor() {
    this.synth = window.speechSynthesis;
    this.voices = [];              // ranked system voices
    this.narratorVoice = null;     // system narrator voice
    this.characterVoices = true;
    this.rate = 0.95;

    // engine: 'neural' (Kokoro) or 'system' (Web Speech)
    this.engine = "neural";
    this.neuralVoice = "af_heart";
    this.neural = { status: "idle", progress: 0, tts: null, error: null };
    this._ncache = new Map();      // generated audio cache
    this._genChain = Promise.resolve(); // serialize generations
    this._source = null;           // playing AudioBufferSourceNode

    this.book = null;
    this.sentenceIdx = 0;
    this.playing = false;
    this._utter = null;
    this._estimator = null;
    this._speakerMap = new Map();
    this._session = 0;

    // callbacks
    this.onWord = null;
    this.onSentence = null;
    this.onEnd = null;
    this.onState = null;
    this.onEngineStatus = null;    // ({engine, status, progress, error})

    if (this.synth) {
      this._loadVoices();
      this.synth.addEventListener?.("voiceschanged", () => this._loadVoices());
    }
  }

  get supported() { return !!(this.synth || window.WebAssembly); }

  /* ================= engines & voices ================= */

  _loadVoices() {
    const all = this.synth.getVoices() || [];
    const en = all.filter((v) => /^en[-_]/i.test(v.lang) || v.lang === "en");
    const score = (v) => {
      const n = v.name.toLowerCase();
      let s = 0;
      if (n.includes("natural")) s += 60;
      if (n.includes("neural")) s += 55;
      if (n.includes("online")) s += 40;
      if (n.includes("premium") || n.includes("enhanced")) s += 35;
      if (n.includes("google")) s += 30;
      if (n.includes("siri")) s += 25;
      if (/^en[-_](us|gb)/i.test(v.lang)) s += 10;
      if (v.localService === false) s += 8;
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

  setEngine(engine) {
    if (engine === this.engine) return;
    this.engine = engine;
    this._speakerMap.clear();
    this._ncache.clear();
    if (this.playing) this._restartCurrent();
    this._emitEngine();
  }

  setNarratorVoice(voice) {
    this.narratorVoice = voice;
    this._speakerMap.clear();
    if (this.playing && this.engine === "system") this._restartCurrent();
  }

  setNeuralVoice(id) {
    this.neuralVoice = id;
    this._speakerMap.clear();
    this._ncache.clear();
    if (this.playing && this.engine === "neural") this._restartCurrent();
  }

  setRate(rate) {
    this.rate = rate;
    this._ncache.clear();
    if (this.playing) this._restartCurrent();
  }

  _emitEngine() {
    this.onEngineStatus &&
      this.onEngineStatus({ engine: this.engine, ...this.neural });
  }

  /** Load Kokoro once; resolves true when ready, false on failure. */
  async ensureNeural() {
    if (this.neural.status === "ready") return true;
    if (this.neural.status === "error") return false;
    if (this._neuralLoading) return this._neuralLoading;
    this.neural.status = "loading";
    this.neural.progress = 0;
    this._emitEngine();
    this._neuralLoading = (async () => {
      try {
        let mod;
        try {
          mod = await import(KOKORO_LOCAL());
        } catch {
          mod = await import(KOKORO_CDN);
        }
        // Point the ONNX runtime at our own copies of its wasm files.
        // The web bundle exposes a simplified env ({wasmPaths}); the full
        // transformers env nests it under backends.onnx.wasm.
        if (mod.env) {
          if ("wasmPaths" in mod.env) {
            mod.env.wasmPaths = KOKORO_WASM_DIR();
          } else if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) {
            mod.env.backends.onnx.wasm.wasmPaths = KOKORO_WASM_DIR();
          }
        }

        const seen = {};
        const progress_callback = (e) => {
          if (e.status === "progress" && e.total) {
            seen[e.file] = [e.loaded, e.total];
            let l = 0, t = 0;
            for (const [a, b] of Object.values(seen)) { l += a; t += b; }
            this.neural.progress = Math.round((l / t) * 100);
            this.neural.mb = { done: l / 1048576, total: t / 1048576 };
            this._emitEngine();
          }
        };

        const withTimeout = (promise, ms, label) =>
          Promise.race([
            promise,
            new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timed out")), ms)),
          ]);

        // Always q8 (~86 MB). fp32 is ~326 MB — unusable on a phone.
        // Try the GPU first, then plain WASM, and verify each attempt can
        // actually speak, so a device whose GPU loads but cannot generate
        // still falls through to the working path.
        const attempts = navigator.gpu
          ? [{ device: "webgpu", dtype: "q8" }, { device: "wasm", dtype: "q8" }]
          : [{ device: "wasm", dtype: "q8" }];
        let lastErr = null;
        for (const { device, dtype } of attempts) {
          try {
            const tts = await withTimeout(
              mod.KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype, device, progress_callback }),
              8 * 60 * 1000, "Voice download"
            );
            const check = await withTimeout(
              tts.generate("Ready.", { voice: this.neuralVoice, speed: 1 }),
              90 * 1000, "Voice startup"
            );
            if (!check || !check.audio || !check.audio.length) throw new Error("Engine produced no audio");
            this.neural.tts = tts;
            this.neural.device = device;
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            this.neural.tts = null;
          }
        }
        if (!this.neural.tts) throw lastErr || new Error("Model failed to load");

        this.neural.status = "ready";
        this._emitEngine();
        return true;
      } catch (e) {
        this.neural.status = "error";
        this.neural.error = (e && e.message) || "unknown error";
        // Fall back for real: switch the setting so the user gets working
        // audio immediately and the panel reflects what is actually used.
        this.engine = "system";
        this._emitEngine();
        return false;
      }
    })();
    return this._neuralLoading;
  }

  /** Speak one sample line through the current engine (for the settings panel). */
  async speakSample() {
    const text = "Chapter one. The night was quiet, and the story was about to begin.";
    this.stop();
    const session = ++this._session;
    if (this.engine === "neural") {
      const ok = await this.ensureNeural();
      if (session !== this._session) return;
      if (ok) {
        try {
          const clip = await this._generate(text, this.neuralVoice);
          if (session !== this._session) return;
          const ctx = AudioHub.ctx();
          const buffer = ctx.createBuffer(1, clip.samples.length, clip.rate);
          buffer.getChannelData(0).set(clip.samples);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          this._source = source;
          source.start();
          return;
        } catch { /* fall through to system sample */ }
      }
    }
    if (this.synth) {
      const u = new SpeechSynthesisUtterance(text);
      if (this.narratorVoice) u.voice = this.narratorVoice;
      u.rate = this.rate;
      this._utter = u;
      this.synth.cancel();
      this.synth.speak(u);
    }
  }

  /** Stable, distinct voice per character name. */
  _voiceForSpeaker(name) {
    const key = (name || "character").toLowerCase();
    if (this._speakerMap.has(key)) return this._speakerMap.get(key);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;

    let v;
    if (this.engine === "neural") {
      const pool = NEURAL_VOICES.map((x) => x.id).filter((id) => id !== this.neuralVoice);
      v = { neural: pool[h % pool.length] };
    } else {
      const pool = this.voices.filter((x) => x !== this.narratorVoice).slice(0, 6);
      const variants = [
        { pitch: 1.25, rate: 1.02 }, { pitch: 0.8, rate: 0.95 },
        { pitch: 1.4, rate: 1.05 },  { pitch: 0.65, rate: 0.9 },
        { pitch: 1.1, rate: 1.0 },   { pitch: 0.9, rate: 1.06 },
      ];
      v = {
        voice: pool.length ? pool[h % pool.length] : this.narratorVoice,
        ...variants[(h + this._speakerMap.size) % variants.length],
      };
    }
    this._speakerMap.set(key, v);
    return v;
  }

  /* ================= playback ================= */

  load(parsedBook, startSentence = 0) {
    this.stop();
    this.book = parsedBook;
    this.sentenceIdx = startSentence;
    this._speakerMap.clear();
    this._ncache.clear();
  }

  play() {
    if (!this.supported || !this.book) return;
    if (this.playing) return;
    // Both audio paths must be unlocked synchronously inside the tap:
    // iOS refuses speech that starts after an await (e.g. AI model load).
    AudioHub.ctx();
    this._unlockSpeech();
    this.playing = true;
    this.onState && this.onState(true);
    this._speakSentence(this.sentenceIdx);
  }

  /** Prime speechSynthesis within a user gesture (iOS/Safari requirement). */
  _unlockSpeech() {
    if (this._speechUnlocked || !this.synth) return;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      this.synth.speak(u);
      this._speechUnlocked = true;
    } catch { /* not fatal */ }
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._session++;
    this._clearEstimator();
    this._stopSource();
    this.synth && this.synth.cancel();
    this.onState && this.onState(false);
  }

  stop() {
    this.playing = false;
    this._session++;
    this._clearEstimator();
    this._stopSource();
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

  _stopSource() {
    if (this._source) {
      try { this._source.stop(); } catch { /* already stopped */ }
      this._source = null;
    }
  }

  /* ================= sentence loop ================= */

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
    const sentence = sentences[idx];
    const segments = sentence.segments.slice();
    const alive = () => session === this._session && this.playing;

    const finishSentence = () => {
      if (!alive()) return;
      // A breath: longer at paragraph ends and after trailing punctuation.
      const nxt = sentences[idx + 1];
      const lastWord = this.book.words[sentence.end] || "";
      let pause = 260;
      if (nxt && nxt.para !== sentence.para) pause = 620;
      else if (/[!?…]["'”’]*$/.test(lastWord)) pause = 380;
      setTimeout(() => { if (alive()) this._speakSentence(idx + 1); }, pause / this.rate);
    };

    const speakNextSegment = () => {
      if (!alive()) return;
      const seg = segments.shift();
      if (!seg) { finishSentence(); return; }
      const step = () => setTimeout(speakNextSegment, 90);
      if (this.engine === "neural") this._neuralSpeak(seg, session, step);
      else this._systemSpeak(seg, session, step);
    };
    speakNextSegment();
  }

  /** Spoken words for a range, with quote/markup characters removed. */
  _spokenWords(seg) {
    const out = [];
    for (let g = seg.start; g <= seg.end; g++) {
      let w = this.book.words[g].replace(/[“”"«»_*]/g, "");
      out.push({ g, w });
    }
    return out;
  }

  /* ================= neural engine (Kokoro) ================= */

  async _neuralSpeak(seg, session, done) {
    const ok = await this.ensureNeural();
    if (session !== this._session || !this.playing) return;
    if (!ok) { this._systemSpeak(seg, session, done); return; } // graceful fallback

    const words = this._spokenWords(seg);
    const text = words.map((x) => x.w).filter(Boolean).join(" ");
    if (!text.trim()) { done(); return; }

    const isDialogue = seg.type === "dialogue" && this.characterVoices;
    const voice = isDialogue ? this._voiceForSpeaker(seg.speaker).neural : this.neuralVoice;

    let clip;
    const genStart = performance.now();
    try {
      clip = await this._generate(text, voice);
    } catch {
      if (session !== this._session || !this.playing) return;
      done(); // skip a problem segment rather than stalling the book
      return;
    }
    if (session !== this._session || !this.playing) return;
    // An empty clip would make createBuffer throw and silently kill the
    // whole narration chain — skip the segment instead.
    if (!clip || !clip.samples || !clip.samples.length) { done(); return; }
    if (performance.now() - genStart > 45000 && !this._warnedSlow) {
      this._warnedSlow = true;
      if (typeof toast === "function") {
        toast("This device is slow at AI narration — switch to ⚡ Device voices in 🎙️ settings for smooth listening.", 6000);
      }
    }

    // Warm the cache for what comes next while this clip plays.
    this._prefetch(seg);

    // Any failure here must not end the book: fall back to the device
    // voice for this segment rather than stopping silently.
    try {
      const ctx = AudioHub.ctx();
      const buffer = ctx.createBuffer(1, clip.samples.length, clip.rate);
      buffer.getChannelData(0).set(clip.samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = 1;
      source.connect(ctx.destination);
      this._source = source;

      // Word highlighting: distribute duration across words by weight.
      const weights = words.map((x) => x.w.length + 1.4 + (/[,;:.!?…]$/.test(x.w) ? 2.2 : 0));
      const totalW = weights.reduce((a, b) => a + b, 0) || 1;
      const duration = buffer.duration;
      const t0 = ctx.currentTime;
      if (this.onWord) this.onWord(seg.start);
      this._clearEstimator();
      this._estimator = setInterval(() => {
        if (session !== this._session) { this._clearEstimator(); return; }
        const frac = Math.min(1, (ctx.currentTime - t0) / duration);
        let acc = 0, wi = 0;
        for (; wi < weights.length - 1; wi++) {
          acc += weights[wi];
          if (acc / totalW > frac) break;
        }
        if (this.onWord) this.onWord(words[wi].g);
      }, 90);

      source.onended = () => {
        if (session !== this._session) return;
        this._clearEstimator();
        this._source = null;
        done();
      };
      source.start();
    } catch {
      this._clearEstimator();
      if (session !== this._session || !this.playing) return;
      this._systemSpeak(seg, session, done);
    }
  }

  /** Serialize + cache Kokoro generations. */
  _generate(text, voice) {
    const key = voice + "|" + this.rate.toFixed(2) + "|" + text;
    if (this._ncache.has(key)) return this._ncache.get(key);
    const p = (this._genChain = this._genChain.catch(() => {}).then(async () => {
      const audio = await this.neural.tts.generate(text, {
        voice,
        speed: Math.max(0.5, Math.min(2, this.rate)),
      });
      return { samples: audio.audio, rate: audio.sampling_rate };
    }));
    this._ncache.set(key, p);
    p.catch(() => this._ncache.delete(key));
    if (this._ncache.size > 14) {
      const first = this._ncache.keys().next().value;
      this._ncache.delete(first);
    }
    return p;
  }

  /** Pre-generate the next couple of segments so playback never gaps. */
  _prefetch(afterSeg) {
    const sentences = this.book.sentences;
    let queued = 0;
    outer:
    for (let si = this.sentenceIdx; si < sentences.length && queued < 3; si++) {
      for (const s of sentences[si].segments) {
        if (s.start <= afterSeg.start) continue;
        const words = this._spokenWords(s);
        const text = words.map((x) => x.w).filter(Boolean).join(" ");
        if (!text.trim()) continue;
        const isDialogue = s.type === "dialogue" && this.characterVoices;
        const voice = isDialogue ? this._voiceForSpeaker(s.speaker).neural : this.neuralVoice;
        this._generate(text, voice).catch(() => {});
        if (++queued >= 3) break outer;
      }
    }
  }

  /* ================= system engine (Web Speech) ================= */

  _systemSpeak(seg, session, done) {
    if (!this.synth) { done(); return; }
    const words = this._spokenWords(seg);
    let text = "";
    const offsets = [];
    for (const x of words) {
      const w = x.w || " ";
      if (text) text += " ";
      offsets.push([text.length, x.g]);
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
      const startedAt = performance.now();
      const durationMs = (text.length / (15 * u.rate)) * 1000;
      this._clearEstimator();
      this._estimator = setInterval(() => {
        if (sawBoundary || session !== this._session) { this._clearEstimator(); return; }
        const frac = Math.min(1, (performance.now() - startedAt) / durationMs);
        const g = this._wordAtChar(offsets, Math.floor(frac * text.length));
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
      done();
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
