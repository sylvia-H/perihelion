/**
 * 示範資料：網址加 ?demo=overview、?demo=focus 或 ?demo=break。
 * 用途是不必真的累積好幾天的紀錄，就能看到行星環、星座、刻度盤上的弧長什麼樣子。
 * 示範模式完全不碰 localStorage。
 */
import { dayKey, emptyState, shiftDay, type AppState, type Session, type Task } from './core/model.ts';
import { hashString } from './core/rng.ts';
import { startTimer } from './core/timer.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function demoState(kind: string, now: number, elapsedMin = 11): AppState {
  const s = emptyState();
  const active: [string, number, number][] = [
    ['回一封重要的信', 1, 0],
    ['複習第三單元的筆記', 3, 2],
    ['讀完第五章', 2, 1],
    ['寫兩題練習題', 4, 0],
    ['整理下週要做的事', 1, 0],
    ['修改報告的第二段', 3, 1],
  ];
  const tasks: Task[] = active.map(([title, est, done], i) => ({
    id: `demo-a${i}`,
    title,
    est,
    done,
    createdAt: now - DAY,
    completedAt: null,
    seed: hashString(title) + i * 3,
    day: dayKey(now),
  }));
  // 排在之後幾天的
  const later: [number, string, number][] = [
    [1, '準備週會的資料', 2],
    [1, '讀完第六章', 3],
    [3, '整理這個月的收據', 1],
  ];
  later.forEach(([ahead, title, est], i) => {
    tasks.push({
      id: `demo-f${i}`,
      title,
      est,
      done: 0,
      createdAt: now,
      completedAt: null,
      seed: hashString(title) + i,
      day: shiftDay(dayKey(now), ahead),
    });
  });

  // 過去幾天做完的事：每天一個星座
  const past: [number, string, number][] = [
    [5, '讀完第一章', 2],
    [5, '整理筆記', 1],
    [5, '寫一題練習', 2],
    [4, '讀完第二章', 3],
    [4, '回信', 1],
    [3, '練習十分鐘簡報', 2],
    [3, '讀完第三章', 2],
    [3, '寫兩題進階題', 3],
    [3, '看一篇文章', 1],
    [2, '讀完第四章', 4],
    [1, '複習上週的筆記', 2],
    [1, '寫一題挑戰題', 2],
    [1, '整理書桌', 3],
    [0, '確認明天的行程', 1],
    [0, '讀一篇長文', 1],
  ];
  past.forEach(([ago, title, done], i) => {
    tasks.push({
      id: `demo-c${i}`,
      title,
      est: done,
      done,
      createdAt: now - (ago + 1) * DAY,
      completedAt: now - ago * DAY - (15 - i) * 7 * MIN,
      seed: hashString(title),
      day: dayKey(now - ago * DAY),
    });
  });

  const sessions: Session[] = [];
  // 今天稍早的四顆
  for (let i = 0; i < 4; i++) {
    const start = now - (190 - i * 34) * MIN;
    sessions.push({
      id: `demo-s${i}`,
      taskId: tasks[i < 2 ? 1 : 2]!.id,
      taskTitle: tasks[i < 2 ? 1 : 2]!.title,
      mode: 'focus',
      start,
      end: start + 25 * MIN,
      completed: i !== 3,
    });
  }
  // 前幾天的紀錄，給十四天長條圖用
  [3, 5, 2, 6, 4, 0, 7, 3, 5, 4].forEach((count, d) => {
    for (let i = 0; i < count; i++) {
      const start = now - (d + 1) * DAY - i * 40 * MIN;
      sessions.push({ id: `demo-h${d}-${i}`, taskId: null, taskTitle: '', mode: 'focus', start, end: start + 25 * MIN, completed: true });
    }
  });
  sessions.sort((a, b) => a.start - b.start);

  let timer: AppState['timer'] = { kind: 'idle' };
  if (kind === 'focus') timer = { ...startTimer('focus', tasks[1]!.id, now - elapsedMin * MIN, s.settings) };
  if (kind === 'break') timer = { ...startTimer('break', tasks[1]!.id, now - 2 * MIN, s.settings) };

  return { ...s, tasks, sessions, timer, streak: 3, selected: kind === 'overview' ? tasks[2]!.id : null };
}
