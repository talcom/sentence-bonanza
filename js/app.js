/* Sentence Bonanza — game logic, storage, and parent view. No build step, no dependencies. */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  const START_STARS = 100;
  const WIN_STARS = 250;
  const POINTS = [10, 5, 1]; // reward for success on try 1, 2, 3
  const PENALTY = 10; // lost for every wrong card
  const MAX_TRIES = 3;
  const BLANK_RE = /_{2,}/;

  const SLOT_MAPS = {
    4: ["s1", "s3", "s4", "s6"],
    6: ["s0", "s2", "s3", "s4", "s5", "s7"],
    8: ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"],
  };

  const KEYS = {
    stats: "sb.stats.v1",
    games: "sb.games.v1",
    custom: "sb.customLevels.v1",
    settings: "sb.settings.v1",
  };

  // ------------------------------------------------------------------
  // Storage helpers (localStorage can throw in private modes)
  // ------------------------------------------------------------------
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable — game still works for this session */
    }
  }

  let settings = load(KEYS.settings, { muted: false });
  let stats = load(KEYS.stats, {}); // sentenceKey -> {seen, t1, t2, t3, missed, hist: [1|2|3|0]}
  let games = load(KEYS.games, []); // newest first
  let customLevels = load(KEYS.custom, []);

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sentenceKey = (levelId, text) => levelId + "|" + text;

  function normalizeSentence(s) {
    // Built-ins are arrays; custom are objects.
    if (Array.isArray(s)) return { text: s[0], answer: s[1], distractors: s[2] };
    return s;
  }

  function allLevels() {
    const builtins = window.BUILTIN_LEVELS.map((l) => ({
      ...l,
      custom: false,
      sentences: l.sentences.map(normalizeSentence),
    }));
    const customs = customLevels.map((l) => ({ ...l, custom: true }));
    return builtins.concat(customs);
  }
  const findLevel = (id) => allLevels().find((l) => l.id === id);

  // Split a sentence into word tokens, with the blank filled by `spokenFill`.
  // Returns the exact string that will be spoken plus each word's character range,
  // so speech "boundary" events can be mapped back to on-screen words.
  function tokenize(text, spokenFill) {
    const m = text.match(BLANK_RE);
    const idx = m ? m.index : text.length;
    const before = text.slice(0, idx);
    const after = m ? text.slice(idx + m[0].length) : "";
    const spoken = before + spokenFill + after;
    const aStart = before.length;
    const aEnd = aStart + spokenFill.length;
    const tokens = [];
    const re = /\S+/g;
    let t;
    while ((t = re.exec(spoken))) {
      const start = t.index;
      const end = start + t[0].length;
      tokens.push({ start, end, text: t[0], isAns: !!m && start < aEnd && end > aStart });
    }
    return { spoken, tokens, aStart, aEnd };
  }

  // Render the sentence as word spans. `fill` = word shown in the blank (null = empty blank).
  function renderSentence(text, fill, cls) {
    const view = tokenize(text, fill || "blank");
    const html = view.tokens
      .map((tk, i) => {
        if (!tk.isAns) return `<span class="w" data-i="${i}" style="--i:${i}">${esc(tk.text)}</span>`;
        const pre = view.spoken.slice(tk.start, Math.max(tk.start, view.aStart));
        const post = view.spoken.slice(Math.min(tk.end, view.aEnd), tk.end);
        const inner = fill ? esc(fill) : "&nbsp;";
        return `<span class="w w-ans" data-i="${i}" style="--i:${i}">${esc(pre)}<span class="blank ${fill ? "filled" : ""} ${cls || ""}">${inner}</span>${esc(post)}</span>`;
      })
      .join(" ");
    const el = $("#sentence");
    el.innerHTML = html;
    if (game && game.cur) game.cur.view = view;
    return view;
  }

  // ------------------------------------------------------------------
  // Sound (tiny WebAudio synth, no files)
  // ------------------------------------------------------------------
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        audioCtx = null;
      }
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function tone(freq, start, dur, type = "sine", vol = 0.18) {
    const c = ctx();
    if (!c || settings.muted) return;
    const t0 = c.currentTime + start;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  const sfx = {
    flip() { tone(520, 0, 0.08, "triangle", 0.08); tone(780, 0.04, 0.07, "triangle", 0.05); },
    go() { [392, 523, 659].forEach((f, i) => tone(f, i * 0.07, 0.18, "triangle", 0.12)); },
    win(big) {
      const notes = big ? [523, 659, 784, 1047, 1319] : [523, 659, 784];
      notes.forEach((f, i) => tone(f, i * 0.09, 0.3, "triangle", 0.16));
      if (big) tone(1568, notes.length * 0.09, 0.6, "sine", 0.12);
    },
    tick(i) { tone(900 + (i % 10) * 60, 0, 0.06, "sine", 0.06); },
    wrong() { tone(220, 0, 0.22, "sawtooth", 0.07); tone(180, 0.12, 0.3, "sawtooth", 0.07); },
    reveal() { tone(440, 0, 0.25, "triangle", 0.1); tone(554, 0.15, 0.35, "triangle", 0.1); },
    fanfare() { [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.35, "square", 0.07)); },
    whoosh() { const c = ctx(); if (!c || settings.muted) return; [300, 500, 800, 1200].forEach((f, i) => tone(f, i * 0.06, 0.12, "sine", 0.05)); },
    thud(missed) { tone(missed ? 330 : 523, 0, 0.18, "triangle", 0.18); tone(missed ? 440 : 1047, 0.06, 0.4, "sine", 0.12); },
    sad() { [392, 349, 311, 262].forEach((f, i) => tone(f, i * 0.22, 0.4, "triangle", 0.1)); },
  };

  const HAS_SPEECH = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const SPEECH_RATE = 0.85;
  let voice = null;
  // Prefer an on-device English voice: those report word boundaries, which
  // drive the word-by-word highlighting. Network voices fall back to timing.
  function pickVoice() {
    if (!HAS_SPEECH) return;
    const vs = window.speechSynthesis.getVoices() || [];
    const en = vs.filter((v) => /^en[-_]/i.test(v.lang) || v.lang === "en");
    voice =
      en.find((v) => v.localService && /^en[-_]US/i.test(v.lang) && v.default) ||
      en.find((v) => v.localService && /^en[-_]US/i.test(v.lang)) ||
      en.find((v) => v.localService) ||
      en[0] ||
      null;
  }
  function makeUtterance(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = SPEECH_RATE;
    u.pitch = 1.05;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    return u;
  }

  function speak(text) {
    stopReading();
    if (settings.muted || !HAS_SPEECH) return;
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(makeUtterance(text));
    } catch (e) { /* ignore */ }
  }

  // ---------- read-along: speak the sentence, emphasizing each word in time ----------
  let readId = 0;
  let currentUtterance = null; // held so the browser doesn't garbage-collect it mid-sentence
  let readTimers = [];
  function stopReading() {
    readId += 1;
    readTimers.forEach(clearTimeout);
    readTimers = [];
    $$("#sentence .w").forEach((w) => w.classList.remove("speaking", "spoken"));
    $("#sentence").classList.remove("reading");
    if (HAS_SPEECH) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
  }

  function syllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!w) return 1;
    const groups = w.replace(/e$/, "").match(/[aeiouy]+/g);
    return Math.max(1, groups ? groups.length : 1);
  }
  // Estimated time to say a word at SPEECH_RATE (used when the voice gives no boundary events).
  function wordMs(text) {
    let ms = (130 + syllables(text) * 175) / SPEECH_RATE;
    if (/[,;:]$/.test(text)) ms += 220;
    return ms;
  }

  function readAlong() {
    stopReading();
    const id = readId;
    const view = game && game.cur && game.cur.view;
    const els = $$("#sentence .w");
    if (!view || !els.length) return Promise.resolve();
    $("#sentence").classList.add("reading");

    return new Promise((resolve) => {
      let speaking = false;
      let gotBoundary = false;
      let timedMode = false;
      let current = -1;
      const later = (fn, ms) => readTimers.push(setTimeout(() => { if (id === readId) fn(); }, ms));

      const highlight = (i) => {
        if (i === current) return;
        current = i;
        els.forEach((e, j) => {
          e.classList.toggle("speaking", j === i);
          e.classList.toggle("spoken", j < i);
        });
      };
      const finish = () => {
        if (id !== readId) return resolve();
        readTimers.forEach(clearTimeout);
        readTimers = [];
        els.forEach((e) => { e.classList.remove("speaking"); e.classList.add("spoken"); });
        setTimeout(() => {
          if (id === readId) {
            els.forEach((e) => e.classList.remove("spoken"));
            $("#sentence").classList.remove("reading");
          }
          resolve();
        }, 450);
      };
      // Timed highlighting: used when muted, when speech is unavailable,
      // or when the voice doesn't report word boundaries.
      const runTimed = (headStart) => {
        if (timedMode || gotBoundary) return;
        timedMode = true;
        let t = 0;
        view.tokens.forEach((tk, i) => {
          later(() => highlight(i), Math.max(0, t - headStart));
          t += wordMs(tk.text);
        });
        later(() => { if (!speaking) finish(); }, Math.max(0, t - headStart) + 150);
      };

      if (settings.muted || !HAS_SPEECH) return runTimed(0);

      const u = makeUtterance(view.spoken);
      currentUtterance = u;
      // Safety net: some voices never fire "end". Stop the highlight once the
      // sentence has certainly finished, so nothing waits on it forever.
      const expected = view.tokens.reduce((t, tk) => t + wordMs(tk.text), 0);
      later(() => { speaking = false; finish(); }, expected * 1.8 + 2500);
      u.onstart = () => {
        if (id !== readId) return;
        speaking = true;
        highlight(0);
        later(() => runTimed(350), 350); // no boundary events within 350ms → use timing
      };
      u.onboundary = (e) => {
        if (id !== readId || timedMode) return;
        if (e.name && e.name !== "word") return;
        gotBoundary = true;
        const i = view.tokens.findIndex((tk) => e.charIndex >= tk.start && e.charIndex < tk.end);
        if (i >= 0) highlight(i);
      };
      u.onend = () => { speaking = false; if (id === readId) finish(); else resolve(); };
      u.onerror = () => { speaking = false; if (id === readId) { if (!timedMode && !gotBoundary) runTimed(0); else finish(); } else resolve(); };
      // If speech never starts (no voices installed, autoplay blocked), still animate.
      later(() => { if (!speaking && !timedMode && !gotBoundary) runTimed(0); }, 1200);
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch (e) {
        runTimed(0);
      }
    });
  }

  function updateMuteButtons() {
    $("#btn-mute").textContent = settings.muted ? "🔇" : "🔊";
    $("#btn-mute-home").textContent = settings.muted ? "🔇 Sound off" : "🔊 Sound on";
  }
  function toggleMute() {
    settings.muted = !settings.muted;
    save(KEYS.settings, settings);
    updateMuteButtons();
    if (settings.muted && HAS_SPEECH) window.speechSynthesis.cancel();
  }

  // ------------------------------------------------------------------
  // Screens
  // ------------------------------------------------------------------
  function show(id) {
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + id));
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------
  // HOME
  // ------------------------------------------------------------------
  function levelRecord(levelId) {
    const gs = games.filter((g) => g.levelId === levelId);
    return {
      played: gs.length,
      wins: gs.filter((g) => g.result === "win").length,
      best: gs.reduce((m, g) => Math.max(m, g.peak || g.finalStars || 0), 0),
    };
  }

  function renderHome() {
    const list = $("#level-list");
    list.innerHTML = "";
    allLevels().forEach((lv) => {
      const rec = levelRecord(lv.id);
      const btn = document.createElement("button");
      btn.className = "level-card" + (lv.custom ? " custom" : "");
      btn.dataset.level = lv.id;
      const n = lv.sentences.length;
      if (!n) btn.disabled = true;
      btn.innerHTML = `
        ${lv.custom ? '<span class="lv-tag">Custom</span>' : ""}
        <span class="lv-emoji">${esc(lv.emoji || "⭐")}</span>
        <span class="lv-name">${esc(lv.name)}</span>
        <span class="lv-blurb">${esc(lv.blurb || "")}</span>
        <span class="lv-meta">
          <span class="lv-pill">${lv.cards} cards</span>
          <span class="lv-pill">${n} sentence${n === 1 ? "" : "s"}</span>
          ${lv.grade ? `<span class="lv-pill">${esc(lv.grade)}</span>` : ""}
          ${rec.wins ? `<span class="lv-pill lv-best">🏆 ${rec.wins} win${rec.wins === 1 ? "" : "s"}</span>` : rec.best ? `<span class="lv-pill lv-best">Best ★${rec.best}</span>` : ""}
        </span>`;
      btn.addEventListener("click", () => startGame(lv.id));
      list.appendChild(btn);
    });
  }

  // ------------------------------------------------------------------
  // GAME
  // ------------------------------------------------------------------
  let game = null;
  let busy = false; // blocks input during animations

  function startGame(levelId) {
    const lv = findLevel(levelId);
    if (!lv || !lv.sentences.length) return;
    ctx(); // unlock audio on user gesture
    game = {
      id: uid(),
      levelId: lv.id,
      level: lv,
      stars: START_STARS,
      peak: START_STARS,
      queue: [],
      last: null,
      round: 0,
      rounds: [], // {text, answer, attempts, solved}
      startedAt: Date.now(),
      over: false,
    };
    $("#game-level").textContent = `${lv.emoji || "⭐"} ${lv.name}`;
    setStars(START_STARS, false);
    show("game");
    nextRound();
  }

  function pickSentence() {
    if (!game.queue.length) {
      let q = shuffle(game.level.sentences);
      if (q.length > 1 && game.last && q[0].text === game.last.text) q.push(q.shift());
      game.queue = q;
    }
    const s = game.queue.shift();
    game.last = s;
    return s;
  }

  function nextRound() {
    if (game.over) return;
    stopReading();
    busy = true;
    const s = pickSentence();
    const lv = game.level;
    const want = Math.max(1, (lv.cards || 6) - 1);
    const distractors = shuffle(s.distractors.filter((d) => d && d.toLowerCase() !== s.answer.toLowerCase())).slice(0, want);
    const words = shuffle([s.answer].concat(distractors));
    const mapKey = words.length <= 4 ? 4 : words.length <= 6 ? 6 : 8;
    const slots = SLOT_MAPS[mapKey];

    game.round += 1;
    game.cur = { sentence: s, words, attempts: 0, done: false };

    $("#round-num").textContent = `Sentence ${game.round}`;
    renderTries();

    const board = $("#board");
    $$(".card", board).forEach((c) => c.remove());
    board.dataset.phase = "deal";
    $("#sentence").className = "sentence";
    $("#sentence").innerHTML = `<span class="prompt">Look at the words…<br>Remember where they are!</span>`;

    words.forEach((w, i) => {
      const card = document.createElement("button");
      card.className = "card dealing";
      if (w.length > 11) card.classList.add("xlong");
      else if (w.length > 8) card.classList.add("long");
      card.style.gridArea = slots[i];
      card.style.animationDelay = i * 60 + "ms";
      card.dataset.word = w;
      card.setAttribute("aria-label", "Face-down card");
      card.innerHTML = `<span class="card-inner"><span class="face back">★</span><span class="face front">${esc(w)}</span></span>`;
      card.addEventListener("click", () => onCardClick(card));
      board.appendChild(card);
    });

    // Flip them all face-up so the player can memorize.
    const cards = $$(".card", board);
    setTimeout(() => {
      cards.forEach((c, i) =>
        setTimeout(() => {
          c.classList.remove("dealing");
          c.classList.add("up");
          c.setAttribute("aria-label", c.dataset.word);
          sfx.flip();
        }, i * 110)
      );
      setTimeout(() => {
        board.dataset.phase = "memorize";
        busy = false;
        $("#btn-go").focus({ preventScroll: true });
      }, cards.length * 110 + 350);
    }, 550);
  }

  function onGo() {
    if (busy || $("#board").dataset.phase !== "memorize") return;
    busy = true;
    sfx.go();
    const board = $("#board");
    $$(".card", board).forEach((c, i) =>
      setTimeout(() => {
        c.classList.remove("up");
        c.setAttribute("aria-label", "Face-down card");
      }, i * 50)
    );
    setTimeout(() => {
      const el = $("#sentence");
      renderSentence(game.cur.sentence.text, null);
      el.classList.add("reveal");
      board.dataset.phase = "guess";
      busy = false;
    }, 500);
  }

  function renderTries() {
    const used = game.cur ? game.cur.attempts : 0;
    $("#tries").innerHTML = Array.from({ length: MAX_TRIES }, (_, i) => `<span class="try-dot ${i < used ? "used" : ""}"></span>`).join("");
  }

  async function onCardClick(card) {
    const board = $("#board");
    if (board.dataset.phase === "memorize" && card.classList.contains("up")) {
      speak(card.dataset.word); // tap a word to hear it while memorizing
      return;
    }
    if (busy || board.dataset.phase !== "guess" || card.classList.contains("up") || game.cur.done) return;
    busy = true;
    const cur = game.cur;
    cur.attempts += 1;
    renderTries();
    card.classList.add("up");
    card.setAttribute("aria-label", card.dataset.word);
    sfx.flip();
    await wait(380);

    const correct = card.dataset.word === cur.sentence.answer;
    if (correct) {
      const pts = POINTS[cur.attempts - 1];
      card.classList.add("right");
      cur.done = true;
      board.dataset.phase = "resolved";
      recordRound(cur.attempts, true);
      const { reading } = await celebrate(card, pts, cur.attempts);
      if (game.stars >= WIN_STARS) {
        await Promise.race([reading, wait(6000)]);
        return endGame("win");
      }
      busy = false;
      $("#btn-next").focus({ preventScroll: true });
      return;
    }

    // Wrong
    card.classList.add("wrong");
    sfx.wrong();
    await loseStars(PENALTY);
    if (game.stars <= 0) {
      cur.done = true;
      recordRound(cur.attempts, false);
      const { reading } = await revealAnswer();
      await Promise.race([reading, wait(6000)]);
      return endGame("lose");
    }
    if (cur.attempts >= MAX_TRIES) {
      cur.done = true;
      recordRound(cur.attempts, false);
      await revealAnswer();
      board.dataset.phase = "resolved";
      busy = false;
      $("#btn-next").focus({ preventScroll: true });
      return;
    }
    busy = false;
  }

  // The answer word flies off its card, swoops into the blank and lands with a
  // burst; then the whole sentence does a wave. Resolves when the wave finishes.
  async function landWord(card, missed) {
    const el = $("#sentence");
    const answer = game.cur.sentence.answer;
    el.classList.remove("reveal", "wave");
    renderSentence(game.cur.sentence.text, answer, missed ? "missed" : "");
    const blank = $(".blank", el);
    blank.classList.add("pending");

    if (card) {
      const from = card.getBoundingClientRect();
      const to = blank.getBoundingClientRect();
      const fly = document.createElement("div");
      fly.className = "fly-word" + (missed ? " missed" : "");
      fly.textContent = answer;
      document.body.appendChild(fly);
      const fw = fly.offsetWidth;
      const fh = fly.offsetHeight;
      const sx = from.left + from.width / 2 - fw / 2;
      const sy = from.top + from.height / 2 - fh / 2;
      const ex = to.left + to.width / 2 - fw / 2;
      const ey = to.top + to.height / 2 - fh / 2;
      const mx = (sx + ex) / 2;
      const my = Math.min(sy, ey) - 120;
      const anim = fly.animate(
        [
          { transform: `translate(${sx}px, ${sy}px) scale(1) rotate(0deg)`, opacity: 1 },
          { transform: `translate(${mx}px, ${my}px) scale(1.9) rotate(${sx < ex ? 10 : -10}deg)`, opacity: 1, offset: 0.5 },
          { transform: `translate(${ex}px, ${ey}px) scale(1) rotate(0deg)`, opacity: 1 },
        ],
        { duration: 750, easing: "cubic-bezier(.5,0,.3,1)", fill: "both" }
      );
      sfx.whoosh();
      await anim.finished.catch(() => {});
      fly.remove();
    }

    blank.classList.remove("pending");
    blank.classList.add("landing");
    sfx.thud(missed);
    sparkleBurst(centerOf(blank), missed ? 10 : 16, missed);
    el.classList.add("wave");
    const n = $$(".w", el).length;
    await wait(500 + n * 45);
    el.classList.remove("wave");
  }

  function sparkleBurst(at, n, muted) {
    for (let i = 0; i < n; i++) {
      const s = document.createElement("div");
      s.className = "fly-star spark";
      s.textContent = i % 3 ? "✦" : "★";
      if (muted) s.style.color = "#ffb44a";
      document.body.appendChild(s);
      const ang = (Math.PI * 2 * i) / n;
      const r = 70 + Math.random() * 60;
      const a = s.animate(
        [
          { transform: `translate(${at.x - 10}px, ${at.y - 14}px) scale(0.3)`, opacity: 1 },
          { transform: `translate(${at.x - 10 + Math.cos(ang) * r}px, ${at.y - 14 + Math.sin(ang) * r * 0.7}px) scale(1.1) rotate(160deg)`, opacity: 0 },
        ],
        { duration: 750, easing: "cubic-bezier(.1,.7,.3,1)", fill: "both" }
      );
      a.onfinish = () => s.remove();
    }
  }

  // Returns a promise for the read-along (so callers can wait for it if they need to).
  async function revealAnswer() {
    const card = $$(".card").find((c) => c.dataset.word === game.cur.sentence.answer);
    await wait(350);
    if (card) {
      card.classList.add("up", "revealed");
      card.setAttribute("aria-label", card.dataset.word);
    }
    sfx.reveal();
    await wait(450);
    banner("The answer is “" + game.cur.sentence.answer + "”", true);
    await landWord(card, true);
    const reading = readAlong();
    await wait(600);
    return { reading };
  }

  function recordRound(attempts, solved) {
    const s = game.cur.sentence;
    game.rounds.push({ text: s.text, answer: s.answer, attempts, solved });
    const key = sentenceKey(game.levelId, s.text);
    const st = stats[key] || { seen: 0, t1: 0, t2: 0, t3: 0, missed: 0, hist: [] };
    st.seen += 1;
    if (solved) st["t" + attempts] += 1;
    else st.missed += 1;
    st.hist.push(solved ? attempts : 0);
    if (st.hist.length > 20) st.hist = st.hist.slice(-20);
    st.last = Date.now();
    stats[key] = st;
    save(KEYS.stats, stats);
  }

  // ---------- star counter ----------
  function setStars(n, animate = true) {
    if (game) {
      game.stars = Math.max(0, n);
      game.peak = Math.max(game.peak || 0, game.stars);
    }
    $("#star-num").textContent = Math.max(0, n);
    $("#meter-fill").style.width = Math.min(100, (Math.max(0, n) / WIN_STARS) * 100) + "%";
    if (animate) {
      const sc = $("#star-count");
      sc.classList.remove("pulse");
      void sc.offsetWidth;
      sc.classList.add("pulse");
    }
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function banner(text, sad) {
    const b = $("#banner");
    b.textContent = text;
    b.className = "banner" + (sad ? " sad" : "");
    void b.offsetWidth;
    b.classList.add("show");
  }

  const PRAISE = [
    ["AMAZING!", "SUPER!", "WOW!", "BRILLIANT!", "STAR READER!", "FANTASTIC!"],
    ["Nice work!", "You got it!", "Great job!"],
    ["Got it!", "Good thinking!", "Phew!"],
  ];

  async function celebrate(card, pts, attempts) {
    const big = attempts === 1;
    sfx.win(big);
    const words = PRAISE[attempts - 1];
    banner(words[Math.floor(Math.random() * words.length)] + (big ? " +10" : " +" + pts));
    if (big) {
      const f = document.createElement("div");
      f.className = "flash";
      document.body.appendChild(f);
      setTimeout(() => f.remove(), 800);
      confetti(centerOf(card), 60);
    } else if (attempts === 2) {
      confetti(centerOf(card), 22);
    }
    const stars = flyStars(card, pts, big);
    await landWord(card, false);
    const reading = readAlong();
    await stars;
    return { reading };
  }

  function flyStars(fromEl, count, big) {
    return new Promise((resolve) => {
      const from = centerOf(fromEl);
      const to = centerOf($("#star-count .star-icon"));
      let arrived = 0;
      const startStars = game.stars;
      if (!count) return resolve();
      for (let i = 0; i < count; i++) {
        const s = document.createElement("div");
        s.className = "fly-star";
        s.textContent = "★";
        document.body.appendChild(s);
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
        const radius = big ? 110 + Math.random() * 90 : 60 + Math.random() * 40;
        const bx = from.x + Math.cos(angle) * radius;
        const by = from.y + Math.sin(angle) * radius;
        const scale = big ? 1.4 + Math.random() * 0.8 : 1;
        const delay = i * (big ? 70 : 90);
        const anim = s.animate(
          [
            { transform: `translate(${from.x - 16}px, ${from.y - 16}px) scale(0.2) rotate(0deg)`, opacity: 0 },
            { transform: `translate(${bx - 16}px, ${by - 16}px) scale(${scale}) rotate(180deg)`, opacity: 1, offset: 0.35 },
            { transform: `translate(${bx - 16}px, ${by - 26}px) scale(${scale}) rotate(220deg)`, opacity: 1, offset: 0.5 },
            { transform: `translate(${to.x - 16}px, ${to.y - 16}px) scale(0.5) rotate(540deg)`, opacity: 0.9 },
          ],
          { duration: big ? 1300 : 1000, delay, easing: "cubic-bezier(.45,0,.3,1)", fill: "both" }
        );
        anim.onfinish = () => {
          s.remove();
          arrived += 1;
          sfx.tick(arrived);
          setStars(startStars + arrived);
          if (arrived === count) {
            floatText("+" + count, to, "plus");
            setTimeout(resolve, 350);
          }
        };
      }
    });
  }

  function loseStars(n) {
    return new Promise((resolve) => {
      const sc = $("#star-count");
      const at = centerOf(sc);
      floatText("−" + n, at, "minus");
      sc.classList.remove("shake");
      void sc.offsetWidth;
      sc.classList.add("shake");
      // a few stars tumble away from the counter
      for (let i = 0; i < 6; i++) {
        const s = document.createElement("div");
        s.className = "fly-star";
        s.textContent = "★";
        s.style.filter = "grayscale(0.6)";
        document.body.appendChild(s);
        const dx = (Math.random() - 0.5) * 160;
        const anim = s.animate(
          [
            { transform: `translate(${at.x - 16}px, ${at.y - 16}px) scale(0.9) rotate(0)`, opacity: 1 },
            { transform: `translate(${at.x - 16 + dx}px, ${at.y + 160 + Math.random() * 120}px) scale(0.4) rotate(${dx * 3}deg)`, opacity: 0 },
          ],
          { duration: 900, delay: i * 40, easing: "cubic-bezier(.5,0,.9,.6)", fill: "both" }
        );
        anim.onfinish = () => s.remove();
      }
      setStars(game.stars - n, false);
      setTimeout(() => {
        sc.classList.remove("shake");
        resolve();
      }, 600);
    });
  }

  function floatText(text, at, cls) {
    const t = document.createElement("div");
    t.className = "float-text " + cls;
    t.textContent = text;
    document.body.appendChild(t);
    const a = t.animate(
      [
        { transform: `translate(${at.x - 20}px, ${at.y + 10}px) scale(0.6)`, opacity: 0 },
        { transform: `translate(${at.x - 20}px, ${at.y + 26}px) scale(1.2)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${at.x - 20}px, ${at.y + 60}px) scale(1)`, opacity: 0 },
      ],
      { duration: 1100, easing: "ease-out", fill: "both" }
    );
    a.onfinish = () => t.remove();
  }

  function confetti(at, n) {
    const colors = ["#ffc93c", "#ff6b6b", "#2ec4b6", "#5ab0ff", "#b088ff", "#ffffff"];
    for (let i = 0; i < n; i++) {
      const c = document.createElement("div");
      c.className = "confetti";
      c.style.background = colors[i % colors.length];
      document.body.appendChild(c);
      const ang = Math.random() * Math.PI * 2;
      const v = 120 + Math.random() * 260;
      const dx = Math.cos(ang) * v;
      const dy = Math.sin(ang) * v - 120;
      const a = c.animate(
        [
          { transform: `translate(${at.x}px, ${at.y}px) rotate(0)`, opacity: 1 },
          { transform: `translate(${at.x + dx}px, ${at.y + dy}px) rotate(${Math.random() * 720}deg)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${at.x + dx * 1.2}px, ${at.y + dy + 320}px) rotate(${Math.random() * 1080}deg)`, opacity: 0 },
        ],
        { duration: 1500 + Math.random() * 700, easing: "cubic-bezier(.2,.7,.4,1)", fill: "both" }
      );
      a.onfinish = () => c.remove();
    }
  }

  function onNext() {
    if (busy || $("#board").dataset.phase !== "resolved") return;
    nextRound();
  }

  function recordGame(result) {
    const rec = {
      id: game.id,
      levelId: game.levelId,
      levelName: game.level.name,
      result,
      finalStars: game.stars,
      peak: game.peak,
      startedAt: game.startedAt,
      endedAt: Date.now(),
      rounds: game.rounds,
    };
    games.unshift(rec);
    if (games.length > 200) games = games.slice(0, 200);
    save(KEYS.games, games);
    return rec;
  }

  async function endGame(result) {
    game.over = true;
    busy = true;
    recordGame(result);
    if (result === "win") {
      sfx.fanfare();
      banner("SUPERSTAR!");
      confetti({ x: window.innerWidth / 2, y: window.innerHeight / 3 }, 120);
      await wait(1800);
    } else {
      sfx.sad();
      await wait(900);
    }
    renderEnd(result);
    show("end");
    if (result === "win") confetti({ x: window.innerWidth / 2, y: 120 }, 90);
    busy = false;
  }

  function quitGame() {
    if (game && !game.over && game.rounds.length) recordGame("quit");
    if (game) game.over = true;
    busy = false;
    stopReading();
    renderHome();
    show("home");
  }

  function badgeFor(r) {
    if (!r.solved) return `<span class="badge tx">Missed</span>`;
    return `<span class="badge t${r.attempts}">${r.attempts === 1 ? "1st try!" : r.attempts === 2 ? "2nd try" : "3rd try"}</span>`;
  }

  function renderEnd(result) {
    const win = result === "win";
    $("#end-emoji").textContent = win ? "🏆" : "🌙";
    const t = $("#end-title");
    t.textContent = win ? "Superstar!" : "Out of stars!";
    t.classList.toggle("lose", !win);
    $("#end-sub").textContent = win
      ? `You reached ${WIN_STARS} stars on ${game.level.name}!`
      : "Great try! Every game makes you a stronger reader.";
    const r = game.rounds;
    const first = r.filter((x) => x.solved && x.attempts === 1).length;
    const solved = r.filter((x) => x.solved).length;
    $("#end-stats").innerHTML = `
      <div class="stat-chip"><b>${r.length}</b><span>sentences</span></div>
      <div class="stat-chip"><b>${first}</b><span>on 1st try</span></div>
      <div class="stat-chip"><b>${solved}</b><span>solved</span></div>
      <div class="stat-chip"><b>★${game.peak}</b><span>most stars</span></div>`;
    $("#end-list").innerHTML = r
      .map((x) => `<div class="end-row"><span class="sent">${esc(x.text).replace(BLANK_RE, `<b>${esc(x.answer)}</b>`)}</span>${badgeFor(x)}</div>`)
      .join("") || `<p class="muted">No sentences played.</p>`;
  }

  // ------------------------------------------------------------------
  // PARENT VIEW
  // ------------------------------------------------------------------
  let gateAnswer = 0;
  let parentUnlocked = false;
  let parentLevelId = null;
  let editing = null; // {levelId, index} when editing a custom sentence

  function openParent() {
    show("parent");
    if (parentUnlocked) return renderParent();
    const a = 6 + Math.floor(Math.random() * 4);
    const b = 6 + Math.floor(Math.random() * 4);
    gateAnswer = a * b;
    $("#gate-q").textContent = `${a} × ${b} = ?`;
    $("#gate-input").value = "";
    $("#gate-err").textContent = "";
    $("#gate").hidden = false;
    $("#parent-body").hidden = true;
    setTimeout(() => $("#gate-input").focus(), 50);
  }

  function onGate(e) {
    e.preventDefault();
    if (parseInt($("#gate-input").value, 10) === gateAnswer) {
      parentUnlocked = true;
      $("#gate").hidden = true;
      $("#parent-body").hidden = false;
      renderParent();
    } else {
      $("#gate-err").textContent = "Not quite — try again.";
    }
  }

  function setTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    if (name === "progress") renderProgress();
    if (name === "sentences") renderParentLevels();
  }

  function renderParent() {
    $("#gate").hidden = true;
    $("#parent-body").hidden = false;
    renderParentLevels();
    renderProgress();
  }

  function renderParentLevels() {
    const levels = allLevels();
    if (!parentLevelId || !levels.find((l) => l.id === parentLevelId)) parentLevelId = levels[0].id;
    $("#parent-level-picker").innerHTML = levels
      .map((l) => `<button class="chip-btn ${l.custom ? "custom" : ""} ${l.id === parentLevelId ? "active" : ""}" data-id="${esc(l.id)}">${esc(l.emoji || "⭐")} ${esc(l.name)}</button>`)
      .join("");
    $$("#parent-level-picker .chip-btn").forEach((b) =>
      b.addEventListener("click", () => {
        parentLevelId = b.dataset.id;
        editing = null;
        renderParentLevels();
      })
    );
    renderLevelDetail(findLevel(parentLevelId));
  }

  function histDots(st) {
    if (!st || !st.hist.length) return `<span class="muted">Not played yet</span>`;
    return `<div class="hist">${st.hist.map((h) => `<span class="hdot h${h}" title="${h ? "Try " + h : "Missed"}"></span>`).join("")}</div>`;
  }

  function statSummary(st) {
    if (!st || !st.seen) return "";
    const solved = st.t1 + st.t2 + st.t3;
    const avg = solved ? ((st.t1 + st.t2 * 2 + st.t3 * 3) / solved).toFixed(1) : "–";
    return `<div class="muted" style="font-size:.85rem">Played ${st.seen}× · 1st try ${st.t1} · 2nd ${st.t2} · 3rd ${st.t3} · missed ${st.missed}<br>Avg tries when solved: ${avg}</div>`;
  }

  function renderLevelDetail(lv) {
    const box = $("#parent-level-detail");
    const rows = lv.sentences
      .map((s, i) => {
        const st = stats[sentenceKey(lv.id, s.text)];
        const sent = esc(s.text).replace(BLANK_RE, `<span class="ans">${esc(s.answer)}</span>`);
        const words = s.distractors.map((d) => `<span class="word">${esc(d)}</span>`).join("");
        return `<tr>
          <td class="sent">${sent}<div class="words">${words}</div></td>
          <td>${histDots(st)}${statSummary(st)}</td>
          ${lv.custom ? `<td><div class="row-actions"><button class="icon-btn" data-edit="${i}">Edit</button><button class="icon-btn danger" data-del="${i}">Delete</button></div></td>` : ""}
        </tr>`;
      })
      .join("");

    box.innerHTML = `
      <div class="level-head">
        <h3>${esc(lv.emoji || "⭐")} ${esc(lv.name)}</h3>
        <span class="meta">${lv.cards} cards per sentence · ${lv.sentences.length} sentences${lv.grade ? " · " + esc(lv.grade) : ""}${lv.custom ? " · custom level" : " · built-in"}</span>
        <span class="spacer"></span>
        ${lv.custom ? `<button class="btn btn-small btn-danger" id="btn-del-level">Delete level</button>` : ""}
      </div>
      <div class="legend">
        <span>Recent results:</span>
        <span><i class="hdot h1"></i>1st try</span>
        <span><i class="hdot h2"></i>2nd try</span>
        <span><i class="hdot h3"></i>3rd try</span>
        <span><i class="hdot h0"></i>missed</span>
        <span>· grey words are the wrong-answer cards</span>
      </div>
      ${lv.custom ? sentenceFormHTML(lv) : ""}
      ${lv.sentences.length ? `<table class="s-table"><thead><tr><th>Sentence (answer highlighted)</th><th>How it's going</th>${lv.custom ? "<th></th>" : ""}</tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">No sentences yet — add the first one above.</div>`}
    `;

    if (lv.custom) wireSentenceForm(lv);
    $$("[data-edit]", box).forEach((b) =>
      b.addEventListener("click", () => {
        editing = { levelId: lv.id, index: +b.dataset.edit };
        renderLevelDetail(findLevel(lv.id));
        $("#sentence-form").scrollIntoView({ behavior: "smooth", block: "center" });
      })
    );
    $$("[data-del]", box).forEach((b) => confirmButton(b, "Sure?", () => {
      const cl = customLevels.find((l) => l.id === lv.id);
      cl.sentences.splice(+b.dataset.del, 1);
      saveCustom();
      editing = null;
      renderLevelDetail(findLevel(lv.id));
    }));
    const delLevel = $("#btn-del-level", box);
    if (delLevel) confirmButton(delLevel, "Tap again to delete", () => {
      customLevels = customLevels.filter((l) => l.id !== lv.id);
      saveCustom();
      parentLevelId = null;
      renderParentLevels();
    });
  }

  // Two-tap confirm instead of window.confirm (friendlier on tablets).
  function confirmButton(btn, confirmText, action) {
    const orig = btn.textContent;
    let armed = false;
    let timer;
    btn.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        btn.textContent = confirmText;
        timer = setTimeout(() => { armed = false; btn.textContent = orig; }, 3000);
        return;
      }
      clearTimeout(timer);
      action();
    });
  }

  function sentenceFormHTML(lv) {
    const need = lv.cards - 1;
    const e = editing && editing.levelId === lv.id ? lv.sentences[editing.index] : null;
    return `
      <form id="sentence-form" class="form">
        <h4>${e ? "Edit sentence" : "Add a sentence"}</h4>
        <label>Sentence — type three underscores ___ where the missing word goes
          <input name="text" required placeholder="The cat sat on the ___." value="${e ? esc(e.text) : ""}">
        </label>
        <label>Correct word
          <input name="answer" required placeholder="mat" value="${e ? esc(e.answer) : ""}">
        </label>
        <label>Wrong-answer words (at least ${need}, separated by commas)
          <input name="distractors" required placeholder="${["sky", "jump", "purple", "spoon", "loud", "rain", "fork"].slice(0, need).join(", ")}" value="${e ? esc(e.distractors.join(", ")) : ""}">
          <span class="hint">Pick words that clearly do <b>not</b> make sense in the sentence, so there is only one right answer.</span>
        </label>
        <div>
          <span class="hint">Check: read each choice in the sentence. Only the green one should make sense.</span>
          <ul class="check-list" id="check-list"><li>Type a sentence to preview.</li></ul>
        </div>
        <p class="form-err" id="form-err"></p>
        <div class="form-row">
          <button class="btn btn-go btn-small" type="submit">${e ? "Save changes" : "Add sentence"}</button>
          ${e ? `<button class="btn btn-ghost btn-small" type="button" id="btn-cancel-edit">Cancel</button>` : ""}
        </div>
      </form>`;
  }

  function parseWords(str) {
    return str.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
  }

  function validateSentence(lv, data) {
    const need = lv.cards - 1;
    if (!BLANK_RE.test(data.text)) return "Add ___ (three underscores) where the missing word goes.";
    if ((data.text.match(/_{2,}/g) || []).length > 1) return "Use only one blank per sentence.";
    if (!data.answer) return "Type the correct word.";
    const lower = data.distractors.map((d) => d.toLowerCase());
    if (lower.includes(data.answer.toLowerCase())) return "The correct word can't also be a wrong-answer word.";
    if (new Set(lower).size !== lower.length) return "Each wrong-answer word should be different.";
    if (data.distractors.length < need) return `Add at least ${need} wrong-answer words (you have ${data.distractors.length}).`;
    return "";
  }

  function wireSentenceForm(lv) {
    const form = $("#sentence-form");
    const preview = () => {
      const text = form.text.value.trim();
      const ans = form.answer.value.trim();
      const ds = parseWords(form.distractors.value);
      if (!BLANK_RE.test(text)) {
        $("#check-list").innerHTML = `<li>Type a sentence with ___ to preview.</li>`;
        return;
      }
      const items = (ans ? [`<li class="ok">✓ ${esc(text.replace(BLANK_RE, ans))}</li>`] : []).concat(
        ds.map((d) => `<li>✗ ${esc(text.replace(BLANK_RE, d))}</li>`)
      );
      $("#check-list").innerHTML = items.join("") || `<li>Add words to preview.</li>`;
    };
    form.addEventListener("input", preview);
    preview();
    const cancel = $("#btn-cancel-edit");
    if (cancel) cancel.addEventListener("click", () => { editing = null; renderLevelDetail(findLevel(lv.id)); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = {
        text: form.text.value.trim().replace(/_{2,}/, "___"),
        answer: form.answer.value.trim(),
        distractors: parseWords(form.distractors.value),
      };
      const err = validateSentence(lv, data);
      if (err) return ($("#form-err").textContent = err);
      const cl = customLevels.find((l) => l.id === lv.id);
      const dupIdx = cl.sentences.findIndex((s) => s.text === data.text);
      const editingIdx = editing && editing.levelId === lv.id ? editing.index : -1;
      if (dupIdx !== -1 && dupIdx !== editingIdx) return ($("#form-err").textContent = "That sentence is already in this level.");
      if (editingIdx >= 0) {
        const old = cl.sentences[editingIdx];
        // carry stats across if the text changed
        if (old.text !== data.text) {
          const oldKey = sentenceKey(lv.id, old.text);
          if (stats[oldKey]) {
            stats[sentenceKey(lv.id, data.text)] = stats[oldKey];
            delete stats[oldKey];
            save(KEYS.stats, stats);
          }
        }
        cl.sentences[editingIdx] = data;
      } else {
        cl.sentences.push(data);
      }
      editing = null;
      saveCustom();
      renderLevelDetail(findLevel(lv.id));
      setTimeout(() => { const f = $("#sentence-form"); if (f) f.text.focus(); }, 30);
    });
  }

  function saveCustom() {
    save(KEYS.custom, customLevels);
  }

  function onNewLevel(e) {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    if (!name) return;
    const lv = {
      id: "custom-" + uid(),
      name,
      emoji: f.emoji.value.trim() || "⭐",
      blurb: f.blurb.value.trim(),
      cards: parseInt(f.cards.value, 10) || 6,
      sentences: [],
      createdAt: Date.now(),
    };
    customLevels.push(lv);
    saveCustom();
    f.reset();
    f.emoji.value = "🦄";
    parentLevelId = lv.id;
    setTab("sentences");
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function renderProgress() {
    const levels = allLevels();
    const summary = levels
      .map((lv) => {
        const gs = games.filter((g) => g.levelId === lv.id);
        const rounds = gs.flatMap((g) => g.rounds);
        if (!rounds.length && !gs.length) return "";
        const first = rounds.filter((r) => r.solved && r.attempts === 1).length;
        const pct = rounds.length ? Math.round((first / rounds.length) * 100) : 0;
        const wins = gs.filter((g) => g.result === "win").length;
        return `<div class="sum-card"><h4>${esc(lv.emoji || "⭐")} ${esc(lv.name)}</h4>
          <div class="big">${pct}%</div><div class="muted">first-try correct (${first}/${rounds.length})</div>
          <div class="muted">${gs.length} game${gs.length === 1 ? "" : "s"} · ${wins} win${wins === 1 ? "" : "s"}</div></div>`;
      })
      .join("");
    $("#progress-summary").innerHTML = summary ? `<div class="summary-grid">${summary}</div>` : `<div class="empty">No games played yet.</div>`;

    $("#game-history").innerHTML = games.length
      ? `<div class="games">${games
          .slice(0, 40)
          .map((g) => {
            const r = g.rounds;
            const first = r.filter((x) => x.solved && x.attempts === 1).length;
            const missed = r.filter((x) => !x.solved).length;
            const label = g.result === "win" ? "🏆 Won" : g.result === "lose" ? "Out of stars" : "Stopped early";
            return `<div class="game-row"><span class="res ${g.result}">${label}</span>
              <span>${esc(g.levelName)}</span>
              <span class="muted">${fmtDate(g.endedAt)}</span>
              <span>★ ${g.finalStars} (best ${g.peak})</span>
              <span class="muted">${r.length} sentences · ${first} first try · ${missed} missed</span></div>`;
          })
          .join("")}</div>`
      : `<div class="empty">Games will show up here.</div>`;
  }

  function exportCustom() {
    const blob = new Blob([JSON.stringify({ app: "sentence-bonanza", version: 1, levels: customLevels }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sentence-bonanza-levels.json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    $("#io-msg").textContent = customLevels.length ? `Downloaded ${customLevels.length} level(s).` : "No custom levels yet — the file is empty.";
  }

  function importCustom(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const levels = Array.isArray(data) ? data : data.levels;
        if (!Array.isArray(levels)) throw new Error("bad");
        let added = 0;
        levels.forEach((l) => {
          if (!l || !l.name || !Array.isArray(l.sentences)) return;
          const sentences = l.sentences
            .map((s) => normalizeSentence(s))
            .filter((s) => s && typeof s.text === "string" && BLANK_RE.test(s.text) && s.answer && Array.isArray(s.distractors))
            .map((s) => ({ text: s.text, answer: String(s.answer), distractors: s.distractors.map(String) }));
          const id = l.id && !customLevels.find((c) => c.id === l.id) && !window.BUILTIN_LEVELS.find((b) => b.id === l.id) ? l.id : "custom-" + uid();
          customLevels.push({ id, name: String(l.name).slice(0, 30), emoji: l.emoji || "⭐", blurb: l.blurb || "", cards: [4, 6, 8].includes(+l.cards) ? +l.cards : 6, sentences });
          added += 1;
        });
        saveCustom();
        $("#io-msg").textContent = `Loaded ${added} level(s).`;
        renderParentLevels();
      } catch (e) {
        $("#io-msg").textContent = "That file doesn't look like Sentence Bonanza levels.";
      }
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------------
  // Wire up
  // ------------------------------------------------------------------
  function init() {
    updateMuteButtons();
    if (HAS_SPEECH) {
      pickVoice();
      window.speechSynthesis.addEventListener ? window.speechSynthesis.addEventListener("voiceschanged", pickVoice) : (window.speechSynthesis.onvoiceschanged = pickVoice);
    }
    renderHome();
    $("#btn-go").addEventListener("click", onGo);
    $("#btn-next").addEventListener("click", onNext);
    $("#btn-quit").addEventListener("click", quitGame);
    $("#btn-speak").addEventListener("click", () => {
      if (!game || !game.cur || !game.cur.view) return;
      readAlong();
    });
    $("#btn-mute").addEventListener("click", toggleMute);
    $("#btn-mute-home").addEventListener("click", toggleMute);
    $("#btn-again").addEventListener("click", () => startGame(game.levelId));
    $("#btn-home").addEventListener("click", () => { renderHome(); show("home"); });
    $("#btn-parent").addEventListener("click", openParent);
    $("#btn-parent-back").addEventListener("click", () => { renderHome(); show("home"); });
    $("#gate-form").addEventListener("submit", onGate);
    $$(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
    $("#new-level-form").addEventListener("submit", onNewLevel);
    $("#btn-export").addEventListener("click", exportCustom);
    $("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importCustom(e.target.files[0]); e.target.value = ""; });
    confirmButton($("#btn-reset-stats"), "Tap again to reset", () => {
      stats = {};
      games = [];
      save(KEYS.stats, stats);
      save(KEYS.games, games);
      renderProgress();
      renderHome();
    });

    // Keyboard: Enter while memorizing (and nothing else focused) presses Go.
    document.addEventListener("keydown", (e) => {
      if (!$("#screen-game").classList.contains("active")) return;
      if (e.key === "Enter" && $("#board").dataset.phase === "memorize" && document.activeElement.tagName !== "BUTTON") onGo();
    });

    // Testing hook (harmless in production): lets automated tests read state.
    window.__sb = { get game() { return game; }, get stats() { return stats; }, get games() { return games; } };
  }

  document.addEventListener("DOMContentLoaded", init);
})();
