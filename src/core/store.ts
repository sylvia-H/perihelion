/**
 * 狀態轉移。reduce 是純函式：同樣的 (state, action, now) 永遠得到同樣的結果，
 * 所以每一條規則都能直接用測試釘住，不需要瀏覽器。
 */
import {
  activeTasks,
  clampEst,
  dayKey,
  DEFAULT_SETTINGS,
  emptyState,
  type AppState,
  type Mode,
  type Session,
  type Settings,
  type Task,
} from './model.ts';
import { elapsed, endsAt, pauseTimer, resumeTimer, startTimer } from './timer.ts';

export type Action =
  | { type: 'add'; id: string; title: string; est: number; urgent: boolean; seed: number; sample?: boolean; day?: string }
  | { type: 'reschedule'; id: string; day: string }
  | { type: 'remove'; id: string }
  | { type: 'complete'; id: string; sessionId: string }
  | { type: 'reorder'; id: string; to: number; scope?: string[] }
  | { type: 'est'; id: string; est: number }
  | { type: 'rename'; id: string; title: string }
  | { type: 'select'; id: string | null }
  | { type: 'start'; taskId: string | null }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'abandon'; sessionId: string }
  | { type: 'finish'; sessionId: string }
  | { type: 'skip-break' }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'clear-samples' }
  | { type: 'replace'; state: AppState };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 已完成的待辦與紀錄保留這麼多天，更舊的在載入時清掉 */
const KEEP_DAYS = 400;
/** 中途結束的專注至少要滿一分鐘才留紀錄，避免誤觸留下一堆零碎紀錄 */
const MIN_PARTIAL_MS = 60_000;
/** 紀錄最多留這麼多筆（約一年份），localStorage 不會無限長大 */
const MAX_SESSIONS = 4000;

function titleOf(s: AppState, taskId: string | null): string {
  if (taskId === null) return '';
  return s.tasks.find((t) => t.id === taskId)?.title ?? '';
}

function pushSession(sessions: Session[], x: Session): Session[] {
  const next = sessions.concat(x);
  return next.length > MAX_SESSIONS ? next.slice(next.length - MAX_SESSIONS) : next;
}

/** 把正在跑的專注記成一筆「中途結束」；太短就不記 */
function logPartial(s: AppState, sessionId: string, now: number): Session[] {
  const t = s.timer;
  if (t.kind !== 'run' || t.mode !== 'focus') return s.sessions;
  const ms = elapsed(t, now);
  if (ms < MIN_PARTIAL_MS) return s.sessions;
  return pushSession(s.sessions, {
    id: sessionId,
    taskId: t.taskId,
    taskTitle: titleOf(s, t.taskId),
    mode: 'focus',
    start: t.startedAt,
    end: t.startedAt + t.pausedMs + ms,
    completed: false,
  });
}

export function reduce(s: AppState, a: Action, now: number): AppState {
  switch (a.type) {
    case 'add': {
      const title = a.title.trim();
      if (!title || s.tasks.some((t) => t.id === a.id)) return s;
      const task: Task = {
        id: a.id,
        title,
        est: clampEst(a.est),
        done: 0,
        createdAt: now,
        completedAt: null,
        seed: a.seed >>> 0,
        day: a.day && DAY_RE.test(a.day) ? a.day : dayKey(now),
        ...(a.sample ? { sample: true } : {}),
      };
      // urgent 排到最前面（最內圈），其餘排到還在軌道上的最後一個之後
      if (a.urgent) return { ...s, tasks: [task, ...s.tasks] };
      const lastActive = s.tasks.reduce((idx, t, i) => (t.completedAt === null ? i : idx), -1);
      const tasks = s.tasks.slice();
      tasks.splice(lastActive + 1, 0, task);
      return { ...s, tasks };
    }

    case 'remove': {
      if (!s.tasks.some((t) => t.id === a.id)) return s;
      const running = s.timer.kind === 'run' && s.timer.mode === 'focus' && s.timer.taskId === a.id;
      return {
        ...s,
        tasks: s.tasks.filter((t) => t.id !== a.id),
        timer: running ? { kind: 'idle' } : s.timer,
        selected: s.selected === a.id ? null : s.selected,
      };
    }

    case 'complete': {
      const task = s.tasks.find((t) => t.id === a.id);
      if (!task || task.completedAt !== null) return s;
      const running = s.timer.kind === 'run' && s.timer.mode === 'focus' && s.timer.taskId === a.id;
      return {
        ...s,
        tasks: s.tasks.map((t) => (t.id === a.id ? { ...t, completedAt: now } : t)),
        // 專注到一半就做完：這段時間照記，但不算一顆完整的番茄
        sessions: running ? logPartial(s, a.sessionId, now) : s.sessions,
        timer: running ? { kind: 'idle' } : s.timer,
        selected: s.selected === a.id ? null : s.selected,
      };
    }

    case 'reorder': {
      // scope 是畫面上看得到的那一組（例如某一天的待辦）；只在這一組裡面換位置，
      // 其他日子的待辦與已完成的都留在原位
      const all = activeTasks(s);
      const inScope = a.scope ? new Set(a.scope) : null;
      const act = inScope ? all.filter((t) => inScope.has(t.id)) : all;
      const from = act.findIndex((t) => t.id === a.id);
      if (from < 0) return s;
      const to = Math.min(act.length - 1, Math.max(0, Math.round(a.to)));
      if (to === from) return s;
      const moved = act.slice();
      const [x] = moved.splice(from, 1);
      moved.splice(to, 0, x!);
      const slot = new Set(act.map((t) => t.id));
      let i = 0;
      return { ...s, tasks: s.tasks.map((t) => (slot.has(t.id) ? moved[i++]! : t)) };
    }

    case 'reschedule': {
      if (!DAY_RE.test(a.day) || !s.tasks.some((t) => t.id === a.id && t.completedAt === null && t.day !== a.day)) return s;
      const running = s.timer.kind === 'run' && s.timer.mode === 'focus' && s.timer.taskId === a.id;
      // 正在專注的那一件不能改期
      if (running) return s;
      return {
        ...s,
        tasks: s.tasks.map((t) => (t.id === a.id ? { ...t, day: a.day } : t)),
        selected: s.selected === a.id ? null : s.selected,
      };
    }

    case 'est': {
      const est = clampEst(a.est);
      if (!s.tasks.some((t) => t.id === a.id && t.est !== est)) return s;
      return { ...s, tasks: s.tasks.map((t) => (t.id === a.id ? { ...t, est } : t)) };
    }

    case 'rename': {
      const title = a.title.trim();
      if (!title) return s;
      return { ...s, tasks: s.tasks.map((t) => (t.id === a.id ? { ...t, title } : t)) };
    }

    case 'select': {
      if (a.id !== null && !s.tasks.some((t) => t.id === a.id && t.completedAt === null)) return s;
      return s.selected === a.id ? s : { ...s, selected: a.id };
    }

    case 'start': {
      // 休息中按開始 = 提早結束休息；專注中再按開始不做事
      if (s.timer.kind === 'run' && s.timer.mode === 'focus') return s;
      // 沒指定就從今天最內圈的開始；排在未來的不算
      const today = dayKey(now);
      const act = activeTasks(s).filter((t) => t.day <= today);
      const taskId =
        a.taskId !== null && act.some((t) => t.id === a.taskId) ? a.taskId : (act[0]?.id ?? null);
      return { ...s, timer: startTimer('focus', taskId, now, s.settings), selected: taskId };
    }

    case 'pause':
      return { ...s, timer: pauseTimer(s.timer, now) };

    case 'resume':
      return { ...s, timer: resumeTimer(s.timer, now) };

    case 'abandon': {
      if (s.timer.kind !== 'run') return s;
      return { ...s, sessions: logPartial(s, a.sessionId, now), timer: { kind: 'idle' } };
    }

    case 'finish': {
      const t = s.timer;
      const end = endsAt(t);
      if (t.kind !== 'run' || end === null || now < end) return s;
      const session: Session = {
        id: a.sessionId,
        taskId: t.taskId,
        taskTitle: titleOf(s, t.taskId),
        mode: t.mode,
        start: t.startedAt,
        end,
        completed: true,
      };
      const sessions = pushSession(s.sessions, session);
      if (t.mode !== 'focus') return { ...s, sessions, timer: { kind: 'idle' } };

      const streak = s.streak + 1;
      const isLong = streak % Math.max(1, s.settings.longEvery) === 0;
      const next: Mode = isLong ? 'long' : 'break';
      return {
        ...s,
        sessions,
        streak,
        tasks: s.tasks.map((x) => (x.id === t.taskId ? { ...x, done: x.done + 1 } : x)),
        // 休息從專注「該結束的時刻」起算，不是從使用者回來的時刻
        timer: startTimer(next, t.taskId, end, s.settings),
      };
    }

    case 'skip-break': {
      if (s.timer.kind !== 'run' || s.timer.mode === 'focus') return s;
      return { ...s, timer: { kind: 'idle' } };
    }

    case 'settings': {
      const p = a.patch;
      const cur = s.settings;
      const num = (v: number | undefined, lo: number, hi: number, fallback: number) =>
        v === undefined || !Number.isFinite(v) ? fallback : Math.min(hi, Math.max(lo, v));
      return {
        ...s,
        settings: {
          focusMin: num(p.focusMin, 0.05, 120, cur.focusMin),
          breakMin: num(p.breakMin, 0.05, 60, cur.breakMin),
          longMin: num(p.longMin, 0.05, 90, cur.longMin),
          longEvery: Math.round(num(p.longEvery, 2, 12, cur.longEvery)),
          budget: Math.round(num(p.budget, 1, 24, cur.budget)),
          sound: p.sound ?? cur.sound,
          volume: num(p.volume, 0, 1, cur.volume),
          motion: p.motion ?? cur.motion,
          quality: p.quality ?? cur.quality,
        },
      };
    }

    case 'clear-samples': {
      const ids = new Set(s.tasks.filter((t) => t.sample).map((t) => t.id));
      if (ids.size === 0) return s;
      const running = s.timer.kind === 'run' && s.timer.taskId !== null && ids.has(s.timer.taskId);
      return {
        ...s,
        tasks: s.tasks.filter((t) => !t.sample),
        timer: running ? { kind: 'idle' } : s.timer,
        selected: s.selected !== null && ids.has(s.selected) ? null : s.selected,
      };
    }

    case 'replace':
      return a.state;
  }
}

// ── 載入與修復 ─────────────────────────────────────────────

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';

/**
 * 把 localStorage 或匯入檔裡的東西變回可信的 AppState。
 * 壞掉的欄位退回預設值、壞掉的項目丟掉，絕不讓整個頁面因為一筆髒資料開不起來。
 */
export function sanitize(raw: unknown): AppState {
  const base = emptyState();
  if (!isObj(raw)) return base;

  const tasks: Task[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.tasks)) {
    for (const t of raw.tasks) {
      if (!isObj(t) || !isStr(t.id) || !isStr(t.title) || !t.title.trim() || seen.has(t.id)) continue;
      seen.add(t.id);
      tasks.push({
        id: t.id,
        title: t.title.trim(),
        est: clampEst(isNum(t.est) ? t.est : 1),
        done: isNum(t.done) ? Math.max(0, Math.round(t.done)) : 0,
        createdAt: isNum(t.createdAt) ? t.createdAt : 0,
        completedAt: isNum(t.completedAt) ? t.completedAt : null,
        seed: isNum(t.seed) ? t.seed >>> 0 : 1,
        // 舊資料沒有日期：當成建立那天排的，沒做完的會自動留在今天
        day: isStr(t.day) && DAY_RE.test(t.day) ? t.day : dayKey(isNum(t.createdAt) ? t.createdAt : 0),
        ...(t.sample === true ? { sample: true } : {}),
      });
    }
  }

  const sessions: Session[] = [];
  if (Array.isArray(raw.sessions)) {
    for (const x of raw.sessions) {
      if (!isObj(x) || !isStr(x.id) || !isNum(x.start) || !isNum(x.end) || x.end < x.start) continue;
      const mode: Mode = x.mode === 'break' || x.mode === 'long' ? x.mode : 'focus';
      sessions.push({
        id: x.id,
        taskId: isStr(x.taskId) ? x.taskId : null,
        taskTitle: isStr(x.taskTitle) ? x.taskTitle : '',
        mode,
        start: x.start,
        end: x.end,
        completed: x.completed !== false,
      });
    }
    sessions.sort((p, q) => p.start - q.start);
  }

  let withSettings = base;
  if (isObj(raw.settings)) {
    const r = raw.settings;
    withSettings = reduce(
      base,
      {
        type: 'settings',
        patch: {
          ...(isNum(r.focusMin) ? { focusMin: r.focusMin } : {}),
          ...(isNum(r.breakMin) ? { breakMin: r.breakMin } : {}),
          ...(isNum(r.longMin) ? { longMin: r.longMin } : {}),
          ...(isNum(r.longEvery) ? { longEvery: r.longEvery } : {}),
          ...(isNum(r.budget) ? { budget: r.budget } : {}),
          ...(typeof r.sound === 'boolean' ? { sound: r.sound } : {}),
          ...(isNum(r.volume) ? { volume: r.volume } : {}),
          ...(r.motion === 'reduced' || r.motion === 'auto' ? { motion: r.motion } : {}),
          ...(r.quality === 'low' || r.quality === 'auto' ? { quality: r.quality } : {}),
        },
      },
      0,
    );
  }

  let timer: AppState['timer'] = { kind: 'idle' };
  const rt = raw.timer;
  if (isObj(rt) && rt.kind === 'run' && isNum(rt.startedAt) && isNum(rt.durationMs) && rt.durationMs > 0) {
    const mode: Mode = rt.mode === 'break' || rt.mode === 'long' ? rt.mode : 'focus';
    const taskId = isStr(rt.taskId) && seen.has(rt.taskId) ? rt.taskId : null;
    timer = {
      kind: 'run',
      mode,
      taskId,
      startedAt: rt.startedAt,
      durationMs: rt.durationMs,
      pausedAt: isNum(rt.pausedAt) ? rt.pausedAt : null,
      pausedMs: isNum(rt.pausedMs) ? Math.max(0, rt.pausedMs) : 0,
    };
  }

  const selected =
    isStr(raw.selected) && tasks.some((t) => t.id === raw.selected && t.completedAt === null)
      ? raw.selected
      : null;

  return {
    v: 1,
    tasks,
    sessions,
    timer,
    settings: withSettings.settings ?? { ...DEFAULT_SETTINGS },
    streak: isNum(raw.streak) ? Math.max(0, Math.round(raw.streak)) : 0,
    selected,
  };
}

/** 丟掉太舊的已完成待辦與紀錄，localStorage 不會無限長大。還沒做完的待辦永遠不丟 */
export function prune(s: AppState, now: number): AppState {
  const cutoff = now - KEEP_DAYS * 86_400_000;
  const tasks = s.tasks.filter((t) => t.completedAt === null || t.completedAt >= cutoff);
  const sessions = s.sessions.filter((x) => x.end >= cutoff);
  if (tasks.length === s.tasks.length && sessions.length === s.sessions.length) return s;
  return { ...s, tasks, sessions };
}

/**
 * 頁面關掉期間計時器照樣在走。重新開啟時把該結束的都結束掉：
 * 專注結束 → 記一顆番茄並開始休息；休息也過了 → 回到待命。
 */
export function catchUp(s: AppState, now: number, makeId: () => string): AppState {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const end = endsAt(cur.timer);
    if (end === null || now < end) break;
    cur = reduce(cur, { type: 'finish', sessionId: makeId() }, now);
  }
  return cur;
}
