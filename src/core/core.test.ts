import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activeTasks, completedOn, dayNoon, emptyState, shiftDay, tasksForDay, type AppState } from './model.ts';
import { angularSpeed, constellation, orbitRadius, planetRadius, slotFromRadius } from './orbit.ts';
import { parseQuickAdd } from './parse.ts';
import { capacity, dayFraction, dayKey, formatDuration, history, statsOn } from './stats.ts';
import { catchUp, prune, reduce, sanitize, type Action } from './store.ts';
import { elapsed, endsAt, formatClock, isOver, pauseTimer, progress, remaining, resumeTimer, startTimer } from './timer.ts';

const MIN = 60_000;
const T0 = new Date(2026, 10, 12, 19, 0, 0).getTime(); // 2026-11-12 19:00 本地時間

let n = 0;
const id = () => `id${++n}`;
function run(s: AppState, now: number, ...actions: Action[]): AppState {
  return actions.reduce((acc, a) => reduce(acc, a, now), s);
}
function add(s: AppState, title: string, est = 1, urgent = false, now = T0): AppState {
  return reduce(s, { type: 'add', id: id(), title, est, urgent, seed: 7 }, now);
}

describe('timer', () => {
  const settings = emptyState().settings;

  it('用時間戳算，不管中間隔多久才問', () => {
    const t = startTimer('focus', null, T0, settings);
    assert.equal(remaining(t, T0), 25 * MIN);
    assert.equal(remaining(t, T0 + 10 * MIN), 15 * MIN);
    assert.equal(progress(t, T0 + 12.5 * MIN), 0.5);
    assert.equal(remaining(t, T0 + 999 * MIN), 0);
    assert.equal(progress(t, T0 + 999 * MIN), 1);
  });

  it('暫停期間不走，恢復後結束時刻往後延', () => {
    let t = startTimer('focus', null, T0, settings);
    t = pauseTimer(t, T0 + 5 * MIN) as typeof t;
    assert.equal(elapsed(t, T0 + 20 * MIN), 5 * MIN);
    assert.equal(endsAt(t), null);
    assert.equal(isOver(t, T0 + 99 * MIN), false);
    t = resumeTimer(t, T0 + 20 * MIN) as typeof t;
    assert.equal(endsAt(t), T0 + 40 * MIN);
    assert.equal(elapsed(t, T0 + 21 * MIN), 6 * MIN);
  });

  it('暫停兩次會累計', () => {
    let t = startTimer('focus', null, T0, settings);
    t = resumeTimer(pauseTimer(t, T0 + 1 * MIN), T0 + 3 * MIN) as typeof t;
    t = resumeTimer(pauseTimer(t, T0 + 5 * MIN), T0 + 9 * MIN) as typeof t;
    assert.equal(t.kind === 'run' && t.pausedMs, 6 * MIN);
    assert.equal(endsAt(t), T0 + 31 * MIN);
  });

  it('已經走完就不能再暫停', () => {
    const t = startTimer('break', null, T0, settings);
    assert.equal(pauseTimer(t, T0 + 6 * MIN), t);
  });

  it('顯示用字串無條件進位到秒', () => {
    assert.equal(formatClock(25 * MIN), '25:00');
    assert.equal(formatClock(200), '00:01');
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(-5), '00:00');
    assert.equal(formatClock(61_000), '01:01');
  });
});

describe('parseQuickAdd', () => {
  it('結尾的 ×n 是預估番茄數', () => {
    assert.deepEqual(parseQuickAdd('讀教材 D ×2'), { title: '讀教材 D', est: 2, urgent: false });
    assert.deepEqual(parseQuickAdd('寫題目 x3'), { title: '寫題目', est: 3, urgent: false });
    assert.deepEqual(parseQuickAdd('寫題目*4'), { title: '寫題目', est: 4, urgent: false });
    assert.deepEqual(parseQuickAdd('複習 ＊ 2 '), { title: '複習', est: 2, urgent: false });
  });

  it('驚嘆號是緊急，前後都認，全形也認', () => {
    assert.deepEqual(parseQuickAdd('!回信'), { title: '回信', est: 1, urgent: true });
    assert.deepEqual(parseQuickAdd('回信！ ×2'), { title: '回信', est: 2, urgent: true });
    assert.deepEqual(parseQuickAdd('回信 ×2！'), { title: '回信', est: 2, urgent: true });
  });

  it('不把英文單字結尾的 x 當成語法', () => {
    assert.deepEqual(parseQuickAdd('研究 Linux3'), { title: '研究 Linux3', est: 1, urgent: false });
    assert.deepEqual(parseQuickAdd('看 box2'), { title: '看 box2', est: 1, urgent: false });
  });

  it('預估數夾在 1–12', () => {
    assert.equal(parseQuickAdd('大工程 ×99')?.est, 12);
    assert.equal(parseQuickAdd('小事 ×0')?.est, 1);
  });

  it('空白或只有符號不產生待辦', () => {
    assert.equal(parseQuickAdd('   '), null);
    assert.equal(parseQuickAdd('!!'), null);
    assert.equal(parseQuickAdd('×3'), null);
  });

  it('太長的標題截到 60 個字元，不切壞表情符號', () => {
    const r = parseQuickAdd('😀'.repeat(80));
    assert.equal(Array.from(r!.title).length, 60);
    assert.equal(r!.title, '😀'.repeat(60));
  });
});

describe('reduce：待辦', () => {
  it('新增排到最外圈，緊急的排到最內圈', () => {
    let s = add(add(emptyState(), 'A'), 'B');
    s = add(s, 'C', 1, true);
    assert.deepEqual(activeTasks(s).map((t) => t.title), ['C', 'A', 'B']);
  });

  it('重排只動還在軌道上的，已完成的留在原位', () => {
    let s = add(add(add(emptyState(), 'A'), 'B'), 'C');
    const [a, b, c] = s.tasks.map((t) => t.id) as [string, string, string];
    s = reduce(s, { type: 'complete', id: b, sessionId: id() }, T0);
    s = reduce(s, { type: 'reorder', id: c, to: 0 }, T0);
    assert.deepEqual(s.tasks.map((t) => t.id), [c, b, a]);
    assert.deepEqual(activeTasks(s).map((t) => t.id), [c, a]);
  });

  it('重排的目標超出範圍時夾住', () => {
    let s = add(add(emptyState(), 'A'), 'B');
    const first = s.tasks[0]!.id;
    s = reduce(s, { type: 'reorder', id: first, to: 99 }, T0);
    assert.equal(activeTasks(s)[1]!.id, first);
  });

  it('刪掉正在專注的待辦，計時器回到待命', () => {
    let s = add(emptyState(), 'A');
    const a = s.tasks[0]!.id;
    s = run(s, T0, { type: 'start', taskId: a }, { type: 'remove', id: a });
    assert.equal(s.timer.kind, 'idle');
    assert.equal(s.selected, null);
  });

  it('不能選已完成或不存在的待辦', () => {
    let s = add(emptyState(), 'A');
    const a = s.tasks[0]!.id;
    s = reduce(s, { type: 'complete', id: a, sessionId: id() }, T0);
    assert.equal(reduce(s, { type: 'select', id: a }, T0).selected, null);
    assert.equal(reduce(s, { type: 'select', id: 'nope' }, T0).selected, null);
  });
});

describe('reduce：番茄鐘', () => {
  function focused(): { s: AppState; a: string } {
    const s0 = add(emptyState(), 'A', 2);
    const a = s0.tasks[0]!.id;
    return { s: reduce(s0, { type: 'start', taskId: a }, T0), a };
  }

  it('專注走完：記一顆、待辦加一、自動進短休', () => {
    const { s, a } = focused();
    const done = reduce(s, { type: 'finish', sessionId: 'x1' }, T0 + 25 * MIN);
    assert.equal(done.tasks[0]!.done, 1);
    assert.equal(done.sessions.length, 1);
    assert.deepEqual(
      { ...done.sessions[0] },
      { id: 'x1', taskId: a, taskTitle: 'A', mode: 'focus', start: T0, end: T0 + 25 * MIN, completed: true },
    );
    assert.equal(done.timer.kind === 'run' && done.timer.mode, 'break');
    assert.equal(done.streak, 1);
  });

  it('時間還沒到就送 finish 不會生效', () => {
    const { s } = focused();
    assert.equal(reduce(s, { type: 'finish', sessionId: 'x' }, T0 + 24 * MIN), s);
  });

  it('第四顆之後是長休', () => {
    let { s } = focused();
    let now = T0;
    for (let i = 0; i < 4; i++) {
      now += 25 * MIN;
      s = reduce(s, { type: 'finish', sessionId: id() }, now);
      if (i < 3) {
        assert.equal(s.timer.kind === 'run' && s.timer.mode, 'break');
        s = reduce(s, { type: 'start', taskId: null }, now);
      }
    }
    assert.equal(s.timer.kind === 'run' && s.timer.mode, 'long');
    assert.equal(s.timer.kind === 'run' && s.timer.durationMs, 15 * MIN);
  });

  it('休息從專注該結束的時刻起算，不是從回來的時刻', () => {
    const { s } = focused();
    const late = reduce(s, { type: 'finish', sessionId: 'x' }, T0 + 27 * MIN);
    assert.equal(late.timer.kind === 'run' && late.timer.startedAt, T0 + 25 * MIN);
    assert.equal(remaining(late.timer, T0 + 27 * MIN), 3 * MIN);
  });

  it('中途放棄：滿一分鐘才留紀錄，而且不算一顆', () => {
    const { s } = focused();
    const quick = reduce(s, { type: 'abandon', sessionId: 'x' }, T0 + 30_000);
    assert.equal(quick.sessions.length, 0);
    const later = reduce(s, { type: 'abandon', sessionId: 'x' }, T0 + 10 * MIN);
    assert.equal(later.sessions.length, 1);
    assert.equal(later.sessions[0]!.completed, false);
    assert.equal(later.tasks[0]!.done, 0);
    assert.equal(later.timer.kind, 'idle');
  });

  it('專注到一半就做完：時間照記，計時器停下', () => {
    const { s, a } = focused();
    const done = reduce(s, { type: 'complete', id: a, sessionId: 'x' }, T0 + 12 * MIN);
    assert.equal(done.timer.kind, 'idle');
    assert.equal(done.sessions[0]!.end - done.sessions[0]!.start, 12 * MIN);
    assert.equal(statsOn(done.sessions, T0).count, 0);
    assert.equal(statsOn(done.sessions, T0).focusMs, 12 * MIN);
  });

  it('暫停過的專注，紀錄的結束時刻包含暫停的時間', () => {
    let { s } = focused();
    s = run(s, T0 + 5 * MIN, { type: 'pause' });
    s = run(s, T0 + 15 * MIN, { type: 'resume' });
    s = reduce(s, { type: 'finish', sessionId: 'x' }, T0 + 35 * MIN);
    assert.equal(s.sessions[0]!.end, T0 + 35 * MIN);
  });

  it('沒指定待辦時從最內圈開始；沒有待辦也能計時', () => {
    const s = add(add(emptyState(), 'A'), 'B');
    const started = reduce(s, { type: 'start', taskId: null }, T0);
    assert.equal(started.timer.kind === 'run' && started.timer.taskId, s.tasks[0]!.id);
    const bare = reduce(emptyState(), { type: 'start', taskId: null }, T0);
    assert.equal(bare.timer.kind === 'run' && bare.timer.taskId, null);
  });

  it('專注中再按開始不會重來', () => {
    const { s } = focused();
    assert.equal(reduce(s, { type: 'start', taskId: null }, T0 + 5 * MIN), s);
  });
});

describe('載入與修復', () => {
  it('髒資料不會讓狀態壞掉', () => {
    const s = sanitize({
      tasks: [{ id: 'a', title: ' 好的 ', est: 99, done: -3 }, { id: 'a', title: '重複' }, { title: '沒 id' }, 5, null],
      sessions: [{ id: 's', start: 10, end: 5 }, { id: 't', start: 5, end: 10, mode: 'weird' }],
      settings: { focusMin: 'x', budget: 500, volume: -1 },
      timer: { kind: 'run', startedAt: 'never' },
      selected: 'ghost',
      streak: -4,
    });
    assert.equal(s.tasks.length, 1);
    assert.deepEqual({ t: s.tasks[0]!.title, e: s.tasks[0]!.est, d: s.tasks[0]!.done }, { t: '好的', e: 12, d: 0 });
    assert.equal(s.sessions.length, 1);
    assert.equal(s.sessions[0]!.mode, 'focus');
    assert.equal(s.settings.focusMin, 25);
    assert.equal(s.settings.budget, 24);
    assert.equal(s.settings.volume, 0);
    assert.equal(s.timer.kind, 'idle');
    assert.equal(s.selected, null);
    assert.equal(s.streak, 0);
    assert.deepEqual(sanitize('垃圾'), emptyState());
    assert.deepEqual(sanitize(null), emptyState());
  });

  it('存出去再讀回來是同一份', () => {
    let s = add(add(emptyState(), 'A', 3), 'B', 1, true);
    s = reduce(s, { type: 'start', taskId: s.tasks[0]!.id }, T0);
    s = reduce(s, { type: 'finish', sessionId: 'x' }, T0 + 25 * MIN);
    assert.deepEqual(sanitize(JSON.parse(JSON.stringify(s))), s);
  });

  it('頁面關掉期間專注結束：重開後補記一顆並進休息', () => {
    const s0 = add(emptyState(), 'A');
    const s = reduce(s0, { type: 'start', taskId: null }, T0);
    const back = catchUp(s, T0 + 27 * MIN, id);
    assert.equal(back.tasks[0]!.done, 1);
    assert.equal(back.timer.kind === 'run' && back.timer.mode, 'break');
  });

  it('關了一整晚：專注與休息都補完，回到待命', () => {
    const s0 = add(emptyState(), 'A');
    const s = reduce(s0, { type: 'start', taskId: null }, T0);
    const back = catchUp(s, T0 + 600 * MIN, id);
    assert.equal(back.timer.kind, 'idle');
    assert.deepEqual(back.sessions.map((x) => x.mode), ['focus', 'break']);
    assert.equal(back.sessions[1]!.end, T0 + 30 * MIN);
  });

  it('暫停中關掉頁面，重開後仍是暫停', () => {
    let s = reduce(add(emptyState(), 'A'), { type: 'start', taskId: null }, T0);
    s = reduce(s, { type: 'pause' }, T0 + 5 * MIN);
    assert.equal(catchUp(s, T0 + 600 * MIN, id), s);
  });
});

describe('stats', () => {
  it('以開始時刻歸日，跨午夜的算在開始那天', () => {
    const late = new Date(2026, 10, 12, 23, 50).getTime();
    const sessions = [
      { id: '1', taskId: null, taskTitle: '', mode: 'focus' as const, start: late, end: late + 25 * MIN, completed: true },
    ];
    assert.equal(statsOn(sessions, late).count, 1);
    assert.equal(statsOn(sessions, late + 20 * MIN).count, 0);
    assert.equal(dayKey(late), '2026-11-12');
  });

  it('容量：已完成加還排著的超過預算時算出超出幾顆', () => {
    let s = add(add(emptyState(), 'A', 5), 'B', 4);
    s = reduce(s, { type: 'settings', patch: { budget: 8 } }, T0);
    assert.deepEqual(capacity(s, T0), { budget: 8, done: 0, planned: 9, free: 0, overflow: 1 });
    s = reduce(s, { type: 'start', taskId: s.tasks[0]!.id }, T0);
    s = reduce(s, { type: 'finish', sessionId: 'x' }, T0 + 25 * MIN);
    // 做完一顆：已完成 1、A 還剩 4、B 還剩 4，總數仍是 9
    assert.deepEqual(capacity(s, T0 + 25 * MIN), { budget: 8, done: 1, planned: 8, free: 0, overflow: 1 });
  });

  it('做超過預估的待辦不會讓還排著的變成負數', () => {
    let s = add(emptyState(), 'A', 1);
    s = { ...s, tasks: s.tasks.map((t) => ({ ...t, done: 3 })) };
    assert.equal(capacity(s, T0).planned, 0);
  });

  it('歷史回傳連續的每一天，沒做的日子是 0', () => {
    const d = (day: number) => new Date(2026, 10, day, 20).getTime();
    const mk = (i: number, at: number) => ({ id: String(i), taskId: null, taskTitle: '', mode: 'focus' as const, start: at, end: at + 25 * MIN, completed: true });
    const h = history([mk(1, d(10)), mk(2, d(10)), mk(3, d(12))], d(12), 4);
    assert.deepEqual(h.map((x) => [x.key, x.count]), [['2026-11-09', 0], ['2026-11-10', 2], ['2026-11-11', 0], ['2026-11-12', 1]]);
  });

  it('格式化', () => {
    assert.equal(formatDuration(35 * MIN), '35 分');
    assert.equal(formatDuration(100 * MIN), '1 時 40 分');
    assert.equal(formatDuration(120 * MIN), '2 時');
    assert.equal(dayFraction(new Date(2026, 10, 12, 12).getTime()), 0.5);
  });
});

describe('orbit', () => {
  it('圈數與半徑互為反函數', () => {
    for (const count of [1, 2, 5, 9, 14]) {
      for (let i = 0; i < count; i++) {
        assert.equal(slotFromRadius(orbitRadius(i, count), count), i);
      }
    }
  });

  it('半徑嚴格遞增，待辦再多也不超出外圈', () => {
    for (let i = 1; i < 14; i++) assert.ok(orbitRadius(i, 14) > orbitRadius(i - 1, 14));
    assert.ok(orbitRadius(13, 14) <= 9.2 + 1e-9);
  });

  it('越外圈轉越慢（克卜勒第三定律）', () => {
    const r1 = orbitRadius(0, 6);
    const r2 = orbitRadius(5, 6);
    assert.ok(angularSpeed(r2) < angularSpeed(r1));
    const ratio = angularSpeed(r1) / angularSpeed(r2);
    assert.ok(Math.abs(ratio - Math.pow(r2 / r1, 1.5)) < 1e-9);
  });

  it('預估越多行星越大', () => {
    assert.ok(planetRadius(4) > planetRadius(1));
    assert.ok(planetRadius(12) < 0.85);
  });

  it('星座：同一個種子永遠同一個形狀，而且落在單位方格內', () => {
    const a = constellation(20261112, 6);
    assert.deepEqual(a, constellation(20261112, 6));
    assert.notDeepEqual(a, constellation(20261113, 6));
    for (const p of a) {
      assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
    }
    assert.equal(constellation(1, 1).length, 1);
  });
});

describe('日期：預先排之後的待辦', () => {
  const TODAY = '2026-11-12';
  const TOMORROW = '2026-11-13';
  const DAY = 24 * 60 * MIN;
  const addOn = (s: AppState, title: string, day: string, est = 1, urgent = false) =>
    reduce(s, { type: 'add', id: id(), title, est, urgent, seed: 1, day }, T0);
  const titles = (list: { title: string }[]) => list.map((t) => t.title);

  it('沒指定日期就是排在今天；日期格式不對也退回今天', () => {
    const s = add(emptyState(), 'A');
    assert.equal(s.tasks[0]!.day, TODAY);
    assert.equal(addOn(emptyState(), 'B', '明天').tasks[0]!.day, TODAY);
  });

  it('排在明天的不會出現在今天的軌道上', () => {
    const s = addOn(add(emptyState(), '今天的'), '明天的', TOMORROW);
    assert.deepEqual(titles(tasksForDay(s, TODAY, TODAY)), ['今天的']);
    assert.deepEqual(titles(tasksForDay(s, TOMORROW, TODAY)), ['明天的']);
  });

  it('過了日子還沒做完的，自動留在今天，但不會跑到明天', () => {
    const s = addOn(emptyState(), '前天排的', '2026-11-10');
    assert.deepEqual(titles(tasksForDay(s, TODAY, TODAY)), ['前天排的']);
    assert.deepEqual(tasksForDay(s, TOMORROW, TODAY), []);
  });

  it('過去的日子沒有軌道，只有那天做完的紀錄', () => {
    let s = add(emptyState(), 'A');
    s = reduce(s, { type: 'complete', id: s.tasks[0]!.id, sessionId: id() }, T0 - 2 * DAY);
    assert.deepEqual(tasksForDay(s, '2026-11-10', TODAY), []);
    assert.deepEqual(titles(completedOn(s, '2026-11-10')), ['A']);
    assert.deepEqual(completedOn(s, TODAY), []);
  });

  it('沒指定待辦就開始專注：跳過排在未來的', () => {
    // 緊急的排在陣列最前面，但它是明天的
    const s = addOn(add(emptyState(), '今天的'), '明天的急件', TOMORROW, 1, true);
    assert.equal(s.tasks[0]!.title, '明天的急件');
    const started = reduce(s, { type: 'start', taskId: null }, T0);
    assert.equal(started.timer.kind === 'run' && started.timer.taskId, s.tasks[1]!.id);
  });

  it('指定排在未來的待辦開始專注：不接受，改從今天的開始', () => {
    const s = addOn(add(emptyState(), '今天的'), '明天的', TOMORROW);
    const started = reduce(s, { type: 'start', taskId: s.tasks[1]!.id }, T0);
    assert.equal(started.timer.kind === 'run' && started.timer.taskId, s.tasks[0]!.id);
  });

  it('重排只在看得到的那一組裡面換位置，別天的留在原位', () => {
    let s = add(emptyState(), 'A');
    s = addOn(s, 'F1', TOMORROW);
    s = add(s, 'B');
    s = addOn(s, 'F2', TOMORROW);
    const scope = tasksForDay(s, TODAY, TODAY).map((t) => t.id);
    const b = s.tasks.find((t) => t.title === 'B')!.id;
    s = reduce(s, { type: 'reorder', id: b, to: 0, scope }, T0);
    assert.deepEqual(titles(s.tasks), ['B', 'F1', 'A', 'F2']);
    assert.deepEqual(titles(tasksForDay(s, TOMORROW, TODAY)), ['F1', 'F2']);
  });

  it('改期：移到明天就離開今天的軌道', () => {
    let s = add(emptyState(), 'A');
    const a = s.tasks[0]!.id;
    s = reduce(s, { type: 'select', id: a }, T0);
    s = reduce(s, { type: 'reschedule', id: a, day: TOMORROW }, T0);
    assert.deepEqual(tasksForDay(s, TODAY, TODAY), []);
    assert.deepEqual(titles(tasksForDay(s, TOMORROW, TODAY)), ['A']);
    assert.equal(s.selected, null);
    assert.equal(reduce(s, { type: 'reschedule', id: a, day: '不是日期' }, T0), s);
  });

  it('正在專注的那一件不能改期', () => {
    let s = add(emptyState(), 'A');
    s = reduce(s, { type: 'start', taskId: s.tasks[0]!.id }, T0);
    assert.equal(reduce(s, { type: 'reschedule', id: s.tasks[0]!.id, day: TOMORROW }, T0), s);
  });

  it('容量可以算未來的某一天：只看排了多少', () => {
    let s = addOn(add(emptyState(), '今天的', 3), '明天的', TOMORROW, 5);
    s = reduce(s, { type: 'settings', patch: { budget: 4 } }, T0);
    assert.deepEqual(capacity(s, T0, TOMORROW), { budget: 4, done: 0, planned: 5, free: 0, overflow: 1 });
    assert.deepEqual(capacity(s, T0), { budget: 4, done: 0, planned: 3, free: 1, overflow: 0 });
  });

  it('舊資料沒有日期：當成建立那天排的，所以會出現在今天', () => {
    const s = sanitize({ tasks: [{ id: 'a', title: '舊的', createdAt: T0 - 3 * DAY }, { id: 'b', title: '壞日期', createdAt: T0, day: '11/12' }] });
    assert.equal(s.tasks[0]!.day, '2026-11-09');
    assert.equal(s.tasks[1]!.day, TODAY);
    assert.deepEqual(titles(tasksForDay(s, TODAY, TODAY)), ['舊的', '壞日期']);
  });

  it('超過 400 天的已完成待辦與紀錄會清掉；沒做完的永遠留著', () => {
    let s = add(add(emptyState(), '很久以前做完的'), '很久以前排的、還沒做');
    s = reduce(s, { type: 'start', taskId: s.tasks[0]!.id }, T0);
    s = reduce(s, { type: 'finish', sessionId: 'old' }, T0 + 25 * MIN);
    s = reduce(s, { type: 'complete', id: s.tasks[0]!.id, sessionId: id() }, T0 + 26 * MIN);
    assert.equal(prune(s, T0 + 30 * DAY), s);
    const later = prune(s, T0 + 401 * DAY);
    assert.deepEqual(titles(later.tasks), ['很久以前排的、還沒做']);
    assert.equal(later.sessions.length, 0);
  });

  it('日期的加減跨月、跨年都對', () => {
    assert.equal(shiftDay('2026-11-30', 1), '2026-12-01');
    assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
    assert.equal(shiftDay('2028-02-28', 1), '2028-02-29');
    assert.equal(dayKey(dayNoon('2026-11-12')), '2026-11-12');
  });
});
