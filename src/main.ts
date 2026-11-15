/** 進入點：把資料、場景、介面、計時、聲音接在一起。 */
import '@fontsource-variable/jost/wght.css';
import './style.css';
import { dayKey, emptyState, shiftDay, tasksForDay, type AppState, type Task } from './core/model.ts';
import { parseQuickAdd } from './core/parse.ts';
import { hashString, newId } from './core/rng.ts';
import { catchUp, prune, reduce, sanitize, type Action } from './core/store.ts';
import { formatClock, isOver, progress, remaining } from './core/timer.ts';
import { Chime } from './audio.ts';
import { demoState } from './demo.ts';
import { Scene } from './scene/scene.ts';
import { Hud, type Actions } from './ui.ts';

const KEY = 'perihelion.v1';

// ── 載入 ──────────────────────────────────────────────────

/** 網址加 ?demo=overview、?demo=focus、?demo=break 可以看示範資料；示範模式不讀也不寫儲存空間 */
const demo = new URLSearchParams(location.search).get('demo');

function load(): AppState {
  if (demo) return demoState(demo, Date.now(), Number(new URLSearchParams(location.search).get('t')) || 11);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // 無痕模式或被封鎖的儲存空間：照常運作，只是關掉頁面後不會留下資料
  }
  if (raw === null) return seedSamples(emptyState());
  try {
    return catchUp(prune(sanitize(JSON.parse(raw)), Date.now()), Date.now(), newId);
  } catch {
    return emptyState();
  }
}

/** 第一次開啟時放幾件範例，畫面才不是空的；每一件都標成範例，可以一鍵清掉 */
function seedSamples(s: AppState): AppState {
  const samples: [string, number][] = [
    ['回一封拖了很久的信', 1],
    ['讀完手上那本書的一章', 2],
    ['整理明天要用的資料', 3],
    ['出門走三十分鐘', 1],
    ['規劃下週的行程', 2],
  ];
  const now = Date.now();
  return samples.reduce((acc, [title, est], i) => {
    const id = `sample-${i}`;
    return reduce(acc, { type: 'add', id, title, est, urgent: false, seed: hashString(title) + i * 7, sample: true }, now);
  }, s);
}

let state = load();
/** 正在看哪一天；null 表示今天（跨過午夜會自動跟著走） */
let viewDay: string | null = null;
/** 畫面上看得到的那一組待辦 */
function visible(): Task[] {
  const today = dayKey(Date.now());
  return tasksForDay(state, viewDay ?? today, today);
}
let undoState: AppState | null = null;
let saveWarned = false;

function persist(): void {
  if (demo) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    if (!saveWarned) {
      saveWarned = true;
      hud.toast('這個瀏覽器不讓頁面存資料，關掉後今天的紀錄會消失。可以到「紀錄與設定」匯出備份。');
    }
  }
}

// ── 計時：背景分頁的 setInterval 會被瀏覽器壓到一分鐘一次，Worker 不會 ──

const tickSource = `let iv = 0; onmessage = (e) => { clearInterval(iv); if (e.data > 0) iv = setInterval(() => postMessage(0), e.data); };`;
let worker: Worker | null = null;
let fallbackTimer = 0;
try {
  worker = new Worker(URL.createObjectURL(new Blob([tickSource], { type: 'text/javascript' })));
  worker.onmessage = () => tick();
  worker.onerror = () => {
    worker = null;
    schedule();
  };
} catch {
  worker = null;
}

function schedule(): void {
  const running = state.timer.kind === 'run' && state.timer.pausedAt === null;
  if (worker) worker.postMessage(running ? 250 : 0);
  else {
    window.clearInterval(fallbackTimer);
    if (running) fallbackTimer = window.setInterval(tick, 250);
  }
}

function tick(): void {
  const now = Date.now();
  if (isOver(state.timer, now)) {
    const wasFocus = state.timer.kind === 'run' && state.timer.mode === 'focus';
    dispatch({ type: 'finish', sessionId: newId() });
    chime.play(wasFocus ? 'focusEnd' : 'breakEnd');
    hud.toast(wasFocus ? '一顆番茄完成，休息一下。' : '休息結束，可以開始下一顆。');
    return;
  }
  hud.tick(state, now);
  updateTitle(now);
}

// ── 分頁標題與圖示：頁面在背景時，這是唯一看得到的地方 ──

const iconCanvas = document.createElement('canvas');
iconCanvas.width = iconCanvas.height = 64;
const iconLink = document.getElementById('favicon') as HTMLLinkElement;
let iconSig = '';

function updateTitle(now: number): void {
  const t = state.timer;
  if (t.kind !== 'run') {
    document.title = '近日點';
  } else {
    const clock = formatClock(remaining(t, now));
    const name = t.mode === 'focus' ? (state.tasks.find((x) => x.id === t.taskId)?.title ?? '專注') : '休息';
    document.title = `${t.pausedAt !== null ? '暫停 ' : ''}${clock}　${name}`;
  }
  // 圖示是一顆由暗轉亮的小行星；每 5% 才重畫一次
  const p = t.kind === 'run' ? Math.round(progress(t, now) * 20) / 20 : -1;
  const mode = t.kind === 'run' ? t.mode : 'idle';
  const sig = `${mode}:${p}`;
  if (sig === iconSig) return;
  iconSig = sig;
  const g = iconCanvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, 64, 64);
  const color = mode === 'focus' || mode === 'idle' ? '#ffb85c' : '#74dccd';
  g.beginPath();
  g.arc(32, 32, 27, 0, Math.PI * 2);
  g.fillStyle = mode === 'idle' ? color : '#1a2030';
  g.fill();
  if (p >= 0) {
    // 月相：亮面從右邊長出來
    g.save();
    g.beginPath();
    g.arc(32, 32, 27, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = color;
    g.beginPath();
    g.arc(32, 32, 27, -Math.PI / 2, Math.PI / 2);
    const k = 1 - 2 * p;
    g.ellipse(32, 32, Math.abs(k) * 27, 27, 0, Math.PI / 2, -Math.PI / 2, k > 0);
    g.fill();
    g.restore();
    g.lineWidth = 3;
    g.strokeStyle = color;
    g.beginPath();
    g.arc(32, 32, 27, 0, Math.PI * 2);
    g.stroke();
  }
  iconLink.href = iconCanvas.toDataURL('image/png');
}

// ── 狀態更新 ──────────────────────────────────────────────

function dispatch(action: Action): void {
  const now = Date.now();
  const next = reduce(state, action, now);
  if (next === state) return;
  state = next;
  persist();
  refresh(now);
}

function refresh(now: number): void {
  hud.render(state, now, viewDay);
  scene.sync(state, now, viewDay ?? undefined);
  scene.setPanelWidth(hud.panelWidth);
  updateTitle(now);
  schedule();
}

function titleOf(id: string): string {
  return state.tasks.find((x) => x.id === id)?.title ?? '';
}

const chime = new Chime(() => state.settings);
let overview = false;

const actions: Actions = {
  add(text) {
    const q = parseQuickAdd(text);
    if (!q) return false;
    const id = newId();
    const today = dayKey(Date.now());
    if (viewDay !== null && viewDay < today) return false;
    dispatch({
      type: 'add',
      id,
      title: q.title,
      est: q.est,
      urgent: q.urgent,
      seed: hashString(q.title + id),
      ...(viewDay ? { day: viewDay } : {}),
    });
    return true;
  },
  select: (id) => dispatch({ type: 'select', id }),
  start(id) {
    // 正在排別天的事：先回到今天，不直接開始
    if (viewDay !== null) return actions.setDay(null);
    chime.unlock();
    const before = state.timer;
    overview = false;
    hud.setOverview(false);
    dispatch({ type: 'start', taskId: id });
    if (state.timer !== before) chime.play('start');
  },
  pauseResume() {
    chime.unlock();
    const t = state.timer;
    if (t.kind !== 'run') return;
    dispatch({ type: t.pausedAt === null ? 'pause' : 'resume' });
  },
  abandon() {
    if (state.timer.kind !== 'run') return;
    dispatch({ type: 'abandon', sessionId: newId() });
    hud.toast('這顆番茄已放棄，不計入今天的顆數。');
  },
  skipBreak: () => dispatch({ type: 'skip-break' }),
  complete(id) {
    const title = titleOf(id);
    undoState = state;
    dispatch({ type: 'complete', id, sessionId: newId() });
    chime.play('done');
    hud.toast(`「${title}」做完了，已經升上星空。`, true);
  },
  remove(id) {
    const title = titleOf(id);
    undoState = state;
    dispatch({ type: 'remove', id });
    hud.toast(`已刪除「${title}」。`, true);
  },
  est(id, delta) {
    const task = state.tasks.find((x) => x.id === id);
    if (task) dispatch({ type: 'est', id, est: task.est + delta });
  },
  move(id, delta) {
    const list = visible();
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) dispatch({ type: 'reorder', id, to: idx + delta, scope: list.map((x) => x.id) });
  },
  undo() {
    if (!undoState) return;
    // 計時器不跟著倒回去：復原的是待辦，不是時間
    const restored: AppState = { ...undoState, timer: state.timer, sessions: state.sessions, streak: state.streak };
    undoState = null;
    dispatch({ type: 'replace', state: restored });
    hud.toast('已復原。');
  },
  settings: (patch) => dispatch({ type: 'settings', patch }),
  exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `perihelion-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    hud.toast('備份檔已下載。');
  },
  importData(file) {
    file
      .text()
      .then((text) => {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
          throw new Error('not a backup');
        }
        const next = catchUp(sanitize(parsed), Date.now(), newId);
        undoState = state;
        dispatch({ type: 'replace', state: next });
        hud.toast(`已匯入 ${next.tasks.length} 件待辦與 ${next.sessions.length} 筆紀錄。`, true);
      })
      .catch(() => hud.toast('這個檔案不是近日點的備份，資料沒有變動。'));
  },
  clearSamples: () => dispatch({ type: 'clear-samples' }),
  setDay(day) {
    const today = dayKey(Date.now());
    const next = day === null || day === today ? null : day;
    if (next === viewDay) return;
    if (next !== null && state.timer.kind === 'run' && state.timer.mode === 'focus') {
      hud.toast('專注中不能切到別天。先暫停或做完這一顆。');
      return;
    }
    viewDay = next;
    if (state.selected !== null) dispatch({ type: 'select', id: null });
    refresh(Date.now());
  },
  reschedule(id, day) {
    const title = titleOf(id);
    const before = state;
    undoState = state;
    dispatch({ type: 'reschedule', id, day });
    if (state === before) {
      undoState = null;
      hud.toast('正在專注的這一件不能改期。');
      return;
    }
    const [, m, d] = day.split('-');
    hud.toast(`「${title}」改到 ${Number(m)} 月 ${Number(d)} 日。`, true);
  },
  toggleOverview() {
    overview = scene.toggleOverview();
    hud.setOverview(overview);
    hud.render(state, Date.now());
  },
  cycleBangle() {
    bangle = (bangle + 1) % BANGLE_NAMES.length;
    scene.setBangleStyle(bangle);
    if (!demo) {
      try {
        localStorage.setItem(BANGLE_KEY, String(bangle));
      } catch {
        // 存不了就只在這次開啟期間有效
      }
    }
    hud.toast(`月亮軌道的樣式：${BANGLE_NAMES[bangle]}（按 B 換下一種）`);
  },
  rotate: (dAz) => scene.rotateBy(dAz, 0),
  resetView: () => scene.resetView(),
  wake: () => scene.wake(),
};

const hud = new Hud(actions);
let perfCount = 0;
const scene = new Scene(document.getElementById('stage') as HTMLCanvasElement, {
  onHover: (id) => hud.setHover(id),
  onSelect: (id) => dispatch({ type: 'select', id }),
  onReorder: (id, to) => dispatch({ type: 'reorder', id, to, scope: visible().map((x) => x.id) }),
  onFrame: (info) => {
    hud.frame(info);
    if (++perfCount % 20 === 0) hud.showPerf(scene.perf());
  },
});

// 月亮軌道的樣式是純外觀的偏好，另外存一個鍵，不放進待辦資料裡
const BANGLE_KEY = 'perihelion.bangle';
const BANGLE_NAMES = ['細線', '清透琉璃', '細線加光暈'];
function readBangle(): number {
  const fromUrl = new URLSearchParams(location.search).get('bangle');
  let raw: string | null = fromUrl;
  if (raw === null && !demo) {
    try {
      raw = localStorage.getItem(BANGLE_KEY);
    } catch {
      raw = null;
    }
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < BANGLE_NAMES.length ? n : 0;
}
let bangle = readBangle();
scene.setBangleStyle(bangle);

// 示範模式可以用 az、el 指定視角（弧度），方便直接連到某個角度
if (demo) {
  const q = new URLSearchParams(location.search);
  scene.rotateBy(Number(q.get('az')) || 0, Number(q.get('el')) || 0);
  scene.rotateFocusBy(Number(q.get('faz')) || 0, Number(q.get('fel')) || 0);
  // day=1 看明天、day=-2 看前天；cal=1 直接打開月曆
  // 要等第一次畫完才能切日期、開月曆
  window.setTimeout(() => {
    const offset = Number(q.get('day')) || 0;
    if (offset !== 0) actions.setDay(shiftDay(dayKey(Date.now()), offset));
    if (q.get('cal')) hud.openCalendar();
  }, 0);
}

// 啟動時補記的番茄（頁面關掉期間走完的）已經在 load() 處理；存回去一次
persist();
refresh(Date.now());

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    tick();
    hud.render(state, Date.now());
  }
});
// 跨日：午夜之後「今日」的數字要歸零。一分鐘檢查一次，成本可以忽略
let lastDay = new Date().getDate();
window.setInterval(() => {
  const d = new Date().getDate();
  if (d !== lastDay) {
    lastDay = d;
    // 原本在看的「明天」變成了今天
    if (viewDay !== null && viewDay <= dayKey(Date.now())) viewDay = null;
    refresh(Date.now());
  }
}, 60_000);
