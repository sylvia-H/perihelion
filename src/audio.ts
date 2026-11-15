/** 提示音：用 WebAudio 即時合成，沒有任何音檔。 */
import type { Settings } from './core/model.ts';

type Kind = 'start' | 'focusEnd' | 'breakEnd' | 'done';

const NOTES: Record<Kind, { freq: number; at: number; len: number; gain: number }[]> = {
  start: [{ freq: 587.33, at: 0, len: 0.5, gain: 0.35 }],
  focusEnd: [
    { freq: 659.25, at: 0, len: 1.6, gain: 0.7 },
    { freq: 880, at: 0.28, len: 2.2, gain: 0.7 },
    { freq: 1318.5, at: 0.56, len: 2.6, gain: 0.45 },
  ],
  breakEnd: [
    { freq: 523.25, at: 0, len: 1.4, gain: 0.6 },
    { freq: 783.99, at: 0.3, len: 2.0, gain: 0.6 },
  ],
  done: [
    { freq: 783.99, at: 0, len: 0.9, gain: 0.4 },
    { freq: 1174.66, at: 0.12, len: 1.4, gain: 0.4 },
  ],
};

export class Chime {
  private ctx: AudioContext | null = null;
  private settings: () => Settings;

  constructor(settings: () => Settings) {
    this.settings = settings;
  }

  /** 瀏覽器要求聲音必須由使用者的操作啟動；在按下開始的那一刻建立 */
  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  play(kind: Kind): void {
    const s = this.settings();
    const ctx = this.ctx;
    if (!s.sound || s.volume <= 0 || !ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = s.volume * 0.5;
    master.connect(ctx.destination);
    for (const n of NOTES[kind]) {
      // 鐘聲：基音加兩個不成整數倍的泛音，各自以不同速度衰減
      for (const [mult, amp, decay] of [
        [1, 1, 1],
        [2.76, 0.32, 0.55],
        [5.4, 0.12, 0.3],
      ] as const) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = n.freq * mult;
        const start = t0 + n.at;
        const end = start + n.len * decay;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(n.gain * amp, start + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(g).connect(master);
        osc.start(start);
        osc.stop(end + 0.05);
      }
    }
    window.setTimeout(() => master.disconnect(), 4000);
  }
}
