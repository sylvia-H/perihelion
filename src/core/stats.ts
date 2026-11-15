/** 從紀錄算出畫面要顯示的數字。全部以本地時區的日期為界。 */
import { dayKey, tasksForDay, type AppState, type Session } from './model.ts';

export { dayKey };

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 以「開始時刻」歸日：跨午夜的那一顆算在開始的那一天 */
export function focusSessionsOn(sessions: readonly Session[], now: number): Session[] {
  const key = dayKey(now);
  return sessions.filter((x) => x.mode === 'focus' && dayKey(x.start) === key);
}

export interface DayStats {
  /** 完整的番茄數 */
  count: number;
  /** 專注的總毫秒數，含中途結束的 */
  focusMs: number;
}

export function statsOn(sessions: readonly Session[], now: number): DayStats {
  const list = focusSessionsOn(sessions, now);
  return {
    count: list.filter((x) => x.completed).length,
    focusMs: list.reduce((sum, x) => sum + (x.end - x.start), 0),
  };
}

export interface Capacity {
  budget: number;
  /** 今天已完成的番茄數 */
  done: number;
  /** 還在軌道上的待辦，預估還要幾顆 */
  planned: number;
  /** 還能再排進去的空位 */
  free: number;
  /** 排不進今天的顆數 */
  overflow: number;
}

/**
 * 一天的番茄數是有限的。已完成加上還排著的若超過預算，
 * 超出的部分要讓使用者看得到，而不是默默往後擠。
 */
export function capacity(s: AppState, now: number, day: string = dayKey(now)): Capacity {
  const budget = s.settings.budget;
  const today = dayKey(now);
  // 未來的某一天還沒有任何完成紀錄，只看排了多少
  const done = day === today ? statsOn(s.sessions, now).count : 0;
  const planned = tasksForDay(s, day, today).reduce((sum, t) => sum + Math.max(0, t.est - t.done), 0);
  const total = done + planned;
  return {
    budget,
    done,
    planned,
    free: Math.max(0, budget - total),
    overflow: Math.max(0, total - budget),
  };
}

export interface HistoryDay {
  key: string;
  /** 當天午夜的時間戳 */
  at: number;
  count: number;
}

/** 最近 n 天（含今天）每天完成幾顆，由舊到新 */
export function history(sessions: readonly Session[], now: number, days: number): HistoryDay[] {
  const counts = new Map<string, number>();
  for (const x of sessions) {
    if (x.mode !== 'focus' || !x.completed) continue;
    const k = dayKey(x.start);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: HistoryDay[] = [];
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const at = d.getTime();
    const key = dayKey(at);
    out.push({ key, at, count: counts.get(key) ?? 0 });
    // 用 setDate 前進而不是加 86400000：日光節約時間切換日一天不是 24 小時
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** 「1 時 40 分」「35 分」 */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} 分`;
  return m === 0 ? `${h} 時` : `${h} 時 ${m} 分`;
}

/** 一天之中的位置，0–1 */
export function dayFraction(ts: number): number {
  const start = startOfDay(ts);
  const d = new Date(start);
  d.setDate(d.getDate() + 1);
  const len = d.getTime() - start;
  return (ts - start) / len;
}
