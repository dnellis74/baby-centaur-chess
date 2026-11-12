/* sound.js — tiny synthesized sound effects for Baby Centaur Chess.
 *
 * No audio files: every sound is built with the Web Audio API, so the
 * game stays dependency-free and works offline. Sounds are short and
 * soft on purpose; this is a kids' game, not an arcade.
 *
 * Browsers block audio until the player interacts, so the AudioContext
 * is created lazily by unlock(), called from the first pointerdown.
 * Everything no-ops when muted or when audio is unavailable, and the
 * module never throws, including in a non-browser environment. */

const STORE_KEY = 'bcc-muted';

export class SoundManager {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try {
      this.muted = typeof localStorage !== 'undefined' && localStorage.getItem(STORE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  isMuted() { return this.muted; }

  setMuted(muted) {
    this.muted = !!muted;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, this.muted ? '1' : '0');
    } catch {
      // Private mode: keep it in memory only.
    }
    return this.muted;
  }

  toggleMuted() { return this.setMuted(!this.muted); }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  // --- primitives ---

  tone({ freq = 440, end = null, dur = 0.12, type = 'sine', gain = 0.15, when = 0 }) {
    if (!this.ctx || this.muted) return;
    try {
      const t0 = this.ctx.currentTime + when;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (end) osc.frequency.exponentialRampToValueAtTime(end, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch {
      // Never let a sound break the game.
    }
  }

  noise({ dur = 0.05, gain = 0.1 }) {
    if (!this.ctx || this.muted) return;
    try {
      const t0 = this.ctx.currentTime;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = this.ctx.createBufferSource();
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.buffer = buf;
      src.connect(g).connect(this.ctx.destination);
      src.start(t0);
    } catch {
      // Never let a sound break the game.
    }
  }

  thock({ freq = 180, dur = 0.09, gain = 0.25 }) {
    // Short woody knock: a fast pitch drop plus a breath of noise.
    this.tone({ freq, end: freq * 0.5, dur, type: 'sine', gain });
    this.noise({ dur: 0.05, gain: gain * 0.5 });
  }

  // --- game sounds ---

  move() { this.thock({ freq: 190, dur: 0.08, gain: 0.22 }); }

  capture() { this.thock({ freq: 140, dur: 0.12, gain: 0.3 }); }

  check() {
    this.tone({ freq: 660, dur: 0.1, type: 'sine', gain: 0.14 });
    this.tone({ freq: 880, dur: 0.14, type: 'sine', gain: 0.14, when: 0.09 });
  }

  checkmate(won) {
    // Win: up the scale. Loss: down it, gently.
    const notes = won ? [523, 659, 784, 1047] : [784, 659, 523, 392];
    notes.forEach((freq, i) => this.tone({ freq, dur: 0.16, type: 'triangle', gain: 0.14, when: i * 0.11 }));
  }

  draw() {
    this.tone({ freq: 523, dur: 0.12, type: 'sine', gain: 0.12 });
    this.tone({ freq: 523, dur: 0.16, type: 'sine', gain: 0.12, when: 0.13 });
  }

  invalid() {
    // Soft low buzz for a bounced move.
    this.tone({ freq: 140, end: 110, dur: 0.16, type: 'square', gain: 0.06 });
  }

  click() { this.tone({ freq: 900, dur: 0.04, type: 'sine', gain: 0.06 }); }

  yourTurn() {
    // A friendly two-note rise, distinct from the move sounds, so a
    // player in another tab or app knows the game is waiting on them.
    this.tone({ freq: 587, dur: 0.11, type: 'triangle', gain: 0.13 });
    this.tone({ freq: 880, dur: 0.15, type: 'triangle', gain: 0.13, when: 0.1 });
  }
}
