/** 資料模型。這一層不碰 DOM、不碰 three.js，全部是可序列化的純資料。 */

export interface Task {
  id: string;
  title: string;
  /** 預估番茄數，1–12 */
  est: number;
  /** 已完成的番茄數 */
  done: number;
  createdAt: number;
  /** null 表示還在軌道上 */
  completedAt: number | null;
  /** 決定行星外觀與起始角度的種子 */
  seed: number;
  /**
   * 排在哪一天（本地日期 YYYY-MM-DD）。
   * 過了那天還沒做完的，會自動留在「今天」，不會消失在過去的日子裡。
   */
  day: string;
  /** 首次開啟時放進去的範例待辦 */
  sample?: boolean;
}

export type Mode = 'focus' | 'break' | 'long';

export interface Session {
  id: string;
  taskId: string | null;
  /** 記下當時的標題：待辦之後被刪掉，紀錄仍然讀得懂 */
  taskTitle: string;
  mode: Mode;
  start: number;
  end: number;
  /** false 表示中途結束，不算一顆番茄，但時間照算 */
  completed: boolean;
}

export interface Settings {
  focusMin: number;
  breakMin: number;
  longMin: number;
  /** 每幾顆番茄換一次長休 */
  longEvery: number;
  /** 一天打算做幾顆番茄 */
  budget: number;
  sound: boolean;
  volume: number;
  motion: 'auto' | 'reduced';
  quality: 'auto' | 'low';
}

export type TimerState =
  | { kind: 'idle' }
  | {
      kind: 'run';
      mode: Mode;
      taskId: string | null;
      startedAt: number;
      durationMs: number;
      /** 不是 null 表示暫停中，值是按下暫停的時刻 */
      pausedAt: number | null;
      /** 之前幾次暫停累計的毫秒數 */
      pausedMs: number;
    };

export interface AppState {
  v: 1;
  /** 陣列順序就是優先度：還在軌道上的待辦，越前面越靠近太陽 */
  tasks: Task[];
  sessions: Session[];
  timer: TimerState;
  settings: Settings;
  /** 上次長休之後完成的番茄數 */
  streak: number;
  selected: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  focusMin: 25,
  breakMin: 5,
  longMin: 15,
  longEvery: 4,
  budget: 8,
  sound: true,
  volume: 0.6,
  motion: 'auto',
  quality: 'auto',
};

export const EST_MIN = 1;
export const EST_MAX = 12;

export function emptyState(): AppState {
  return {
    v: 1,
    tasks: [],
    sessions: [],
    timer: { kind: 'idle' },
    settings: { ...DEFAULT_SETTINGS },
    streak: 0,
    selected: null,
  };
}

/** 本地時區的日期字串；字串本身可以直接比大小 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** YYYY-MM-DD → 那一天中午的時間戳（用中午可以避開日光節約時間的邊界） */
export function dayNoon(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12).getTime();
}

/** 往前或往後幾天 */
export function shiftDay(day: string, delta: number): string {
  const d = new Date(dayNoon(day));
  d.setDate(d.getDate() + delta);
  return dayKey(d.getTime());
}

/**
 * 某一天的軌道上有哪些待辦。
 * 今天 = 排在今天的，加上之前排了還沒做完的；未來 = 只有排在那天的；過去 = 沒有（已經是歷史）。
 */
export function tasksForDay(s: AppState, day: string, today: string): Task[] {
  if (day < today) return [];
  return s.tasks.filter((t) => t.completedAt === null && (day === today ? t.day <= today : t.day === day));
}

/** 某一天做完了哪些待辦，依完成時間排序 */
export function completedOn(s: AppState, day: string): Task[] {
  return s.tasks
    .filter((t) => t.completedAt !== null && dayKey(t.completedAt) === day)
    .sort((a, b) => a.completedAt! - b.completedAt!);
}

export function activeTasks(s: AppState): Task[] {
  return s.tasks.filter((t) => t.completedAt === null);
}

export function clampEst(n: number): number {
  if (!Number.isFinite(n)) return EST_MIN;
  return Math.min(EST_MAX, Math.max(EST_MIN, Math.round(n)));
}
