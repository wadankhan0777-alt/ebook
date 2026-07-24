/* ============================================================
 * music.js — mood music, generated live with WebAudio. No audio
 * files: soft synth pads follow the emotional temperature of the
 * text being narrated — tense scenes get a dark, pulsing minor
 * drone; joyful passages a bright major shimmer; grief a slow
 * lament; everything else a barely-there calm bed. Mood changes
 * use hysteresis so the score never flickers between feelings.
 * ============================================================ */

const MoodMusic = (() => {
  const LEX = {
    tense: "blood dead death dark darkness fear afraid terror terrible horror scream screamed shriek danger knife sword gun storm thunder shadow ghost monster demon murder chase fled flee panic battle war enemy attack strike struck cold grim dread evil curse cursed beast growl snarl trap trapped desperate frantic run running hide hiding".split(" "),
    happy: "laugh laughed laughing smile smiled smiling joy joyful happy happiness delight delighted bright sunshine sun dance danced dancing kiss kissed love loved merry cheer cheerful spring garden flowers wonderful beautiful splendid glad sweet warm play played singing sang celebrate feast friend friends".split(" "),
    sad: "tears wept weep weeping grief sorrow sorrowful mourn mourning died dying funeral grave lonely alone farewell goodbye lost miss missed pale sick illness winter sigh sighed cried crying broken heartbroken misery miserable despair gloom melancholy widow orphan".split(" "),
  };

  // Chord voicings (Hz) per mood — low, warm registers.
  const MOODS = {
    tense: { chords: [[55, 110, 130.8, 164.8], [51.9, 103.8, 123.5, 155.6], [58.3, 116.5, 138.6, 174.6]],
             wave: "sawtooth", cutoff: 320, level: 1.0, pulse: true,  hold: 6 },
    sad:   { chords: [[65.4, 130.8, 155.6, 196], [61.7, 123.5, 146.8, 185], [55, 110, 130.8, 164.8]],
             wave: "triangle", cutoff: 600, level: 0.9, pulse: false, hold: 10 },
    happy: { chords: [[98, 196, 246.9, 293.7], [110, 220, 277.2, 329.6], [87.3, 174.6, 220, 261.6]],
             wave: "triangle", cutoff: 1100, level: 0.8, pulse: false, hold: 7 },
    calm:  { chords: [[65.4, 130.8, 196, 261.6], [73.4, 146.8, 220, 293.7]],
             wave: "sine", cutoff: 750, level: 0.7, pulse: false, hold: 12 },
  };

  let ctx = null, master = null, layer = null, pulseNodes = null;
  let enabled = true, volume = 0.12, running = false;
  let mood = "calm", pendingMood = null, pendingCount = 0, chordIdx = 0, chordTimer = null;
  const recent = []; // rolling sentence scores

  /* ---------- mood analysis ---------- */

  function scoreText(text) {
    const words = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/);
    const s = { tense: 0, happy: 0, sad: 0 };
    for (const w of words) {
      if (LEX.tense.includes(w)) s.tense++;
      if (LEX.happy.includes(w)) s.happy++;
      if (LEX.sad.includes(w)) s.sad++;
    }
    return s;
  }

  /** Feed each narrated sentence; the score drifts, never jumps. */
  function update(text) {
    recent.push(scoreText(text));
    if (recent.length > 4) recent.shift();
    const sum = { tense: 0, happy: 0, sad: 0 };
    for (const r of recent) { sum.tense += r.tense; sum.happy += r.happy; sum.sad += r.sad; }
    let target = "calm";
    const best = Math.max(sum.tense, sum.happy, sum.sad);
    if (best >= 2) target = sum.tense === best ? "tense" : sum.happy === best ? "happy" : "sad";
    if (target === mood) { pendingMood = null; pendingCount = 0; return; }
    if (target === pendingMood) pendingCount++;
    else { pendingMood = target; pendingCount = 1; }
    if (pendingCount >= 2 || (target === "tense" && sum.tense >= 3)) {
      mood = target;
      pendingMood = null;
      pendingCount = 0;
      if (running) crossfadeTo(mood);
    }
  }

  /* ---------- synthesis ---------- */

  function makeLayer(cfg, chord) {
    const g = ctx.createGain();
    g.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cfg.cutoff;
    filter.Q.value = 0.4;
    filter.connect(g);
    g.connect(master);

    const oscs = [];
    for (const f of chord) {
      for (const det of [-4, 3]) { // gentle chorus
        const o = ctx.createOscillator();
        o.type = cfg.wave;
        o.frequency.value = f;
        o.detune.value = det;
        const og = ctx.createGain();
        og.gain.value = 0.55 / chord.length;
        o.connect(og);
        og.connect(filter);
        o.start();
        oscs.push(o);
      }
    }
    // slow shimmer
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = cfg.cutoff * 0.25;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();
    oscs.push(lfo);
    return { gain: g, oscs, level: cfg.level };
  }

  function killLayer(l, after = 3) {
    if (!l) return;
    const t = ctx.currentTime;
    l.gain.gain.cancelScheduledValues(t);
    l.gain.gain.setValueAtTime(l.gain.gain.value, t);
    l.gain.gain.linearRampToValueAtTime(0, t + after);
    setTimeout(() => l.oscs.forEach((o) => { try { o.stop(); } catch { /* stopped */ } }), after * 1000 + 200);
  }

  function startPulse() {
    stopPulse();
    // anxious heartbeat under tense scenes
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 49;
    const g = ctx.createGain();
    g.gain.value = 0;
    const trem = ctx.createOscillator();
    trem.frequency.value = 1.6;
    const tremGain = ctx.createGain();
    tremGain.gain.value = 0.5;
    trem.connect(tremGain);
    tremGain.connect(g.gain);
    o.connect(g);
    g.connect(master);
    o.start();
    trem.start();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 2.5);
    pulseNodes = { stopAll: () => { try { o.stop(); trem.stop(); } catch { /* stopped */ } }, gain: g };
  }

  function stopPulse() {
    if (!pulseNodes) return;
    const p = pulseNodes;
    pulseNodes = null;
    const t = ctx.currentTime;
    p.gain.gain.cancelScheduledValues(t);
    p.gain.gain.linearRampToValueAtTime(0, t + 1.5);
    setTimeout(() => p.stopAll(), 1700);
  }

  function crossfadeTo(m) {
    const cfg = MOODS[m];
    chordIdx = 0;
    const old = layer;
    layer = makeLayer(cfg, cfg.chords[0]);
    const t = ctx.currentTime;
    layer.gain.gain.setValueAtTime(0, t);
    layer.gain.gain.linearRampToValueAtTime(cfg.level, t + 3.2);
    killLayer(old, 3.2);
    if (cfg.pulse) startPulse();
    else stopPulse();
    clearInterval(chordTimer);
    chordTimer = setInterval(() => {
      if (!running) return;
      chordIdx = (chordIdx + 1) % cfg.chords.length;
      const next = makeLayer(cfg, cfg.chords[chordIdx]);
      const tt = ctx.currentTime;
      next.gain.gain.setValueAtTime(0, tt);
      next.gain.gain.linearRampToValueAtTime(cfg.level, tt + 4);
      killLayer(layer, 4);
      layer = next;
    }, cfg.hold * 1000);
  }

  /* ---------- public ---------- */

  function start() {
    if (!enabled || running) return;
    ctx = AudioHub.ctx();
    if (!master) {
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    master.gain.value = 0;
    master.gain.linearRampToValueAtTime(volume, ctx.currentTime + 2);
    running = true;
    crossfadeTo(mood);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(chordTimer);
    if (master) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + 1.2);
    }
    killLayer(layer, 1.2);
    layer = null;
    stopPulse();
  }

  function setVolume(v) {
    volume = v;
    if (running && master) master.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.3);
  }

  function setEnabled(on) {
    enabled = on;
    if (!on) stop();
  }

  return { start, stop, update, setVolume, setEnabled,
           get enabled() { return enabled; }, get volume() { return volume; }, get mood() { return mood; } };
})();
