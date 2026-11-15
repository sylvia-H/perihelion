/**
 * 計時器的純函式。
 * 全部用時間戳相減，不數畫面更新次數：分頁在背景、電腦睡眠、畫面降到每秒幾幀都不會走慢。
 */
import type { Mode, Settings, TimerState } from './model.ts';

type Running = Extract<TimerState, { kind: 'run' }>;

export function durationOf(mode: Mode, s: Settings): number {
  const min = mode === 'focus' ? s.focusMin : mode === 'break' ? s.breakMin : s.longMin;
  return Math.round(min * 60_000);
}

export function startTimer(mode: Mode, taskId: string | null, now: number, s: Settings): Running {
  return {
    kind: 'run',
    mode,
    taskId,
    startedAt: now,
    durationMs: durationOf(mode, s),
    pausedAt: null,
    pausedMs: 0,
  };
}

/** 已經走掉的毫秒數（扣掉暫停） */
export function elapsed(t: TimerState, now: number): number {
  if (t.kind !== 'run') return 0;
  const ref = t.pausedAt ?? now;
  return Math.max(0, Math.min(t.durationMs, ref - t.startedAt - t.pausedMs));
}

export function remaining(t: TimerState, now: number): number {
  if (t.kind !== 'run') return 0;
  return t.durationMs - elapsed(t, now);
}

/** 0–1 */
export function progress(t: TimerState, now: number): number {
  if (t.kind !== 'run' || t.durationMs <= 0) return 0;
  return elapsed(t, now) / t.durationMs;
}

/** 這一段預計結束的時刻；暫停中沒有結束時刻 */
export function endsAt(t: TimerState): number | null {
  if (t.kind !== 'run' || t.pausedAt !== null) return null;
  return t.startedAt + t.pausedMs + t.durationMs;
}

export function isOver(t: TimerState, now: number): boolean {
  const end = endsAt(t);
  return end !== null && now >= end;
}

export function pauseTimer(t: TimerState, now: number): TimerState {
  if (t.kind !== 'run' || t.pausedAt !== null) return t;
  // 已經走完就不能再暫停，否則會停在 00:00 之後
  if (isOver(t, now)) return t;
  return { ...t, pausedAt: now };
}

export function resumeTimer(t: TimerState, now: number): TimerState {
  if (t.kind !== 'run' || t.pausedAt === null) return t;
  return { ...t, pausedAt: null, pausedMs: t.pausedMs + Math.max(0, now - t.pausedAt) };
}

/** 12:05 這種顯示用字串；無條件進位到秒，所以剩 0.2 秒時顯示 00:01 而不是 00:00 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
