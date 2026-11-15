/** DOM 介面層：把 AppState 畫成文字與按鈕，把使用者的操作轉成 Actions。不用框架。 */
import { completedOn, dayNoon, shiftDay, tasksForDay, type AppState, type Settings, type Task } from './core/model.ts';
import { parseQuickAdd } from './core/parse.ts';
import { capacity, dayKey, focusSessionsOn, formatDuration, history, statsOn } from './core/stats.ts';
import { durationOf, formatClock, remaining } from './core/timer.ts';
import type { FrameInfo, PerfInfo } from './scene/scene.ts';

export interface Actions {
  add(text: string): boolean;
  select(id: string | null): void;
  start(id: string | null): void;
  pauseResume(): void;
  abandon(): void;
  skipBreak(): void;
  complete(id: string): void;
  remove(id: string): void;
  est(id: string, delta: number): void;
  move(id: string, delta: number): void;
  undo(): void;
  settings(patch: Partial<Settings>): void;
  exportData(): void;
  importData(file: File): void;
  clearSamples(): void;
  toggleOverview(): void;
  setDay(day: string | null): void;
  reschedule(id: string, day: string): void;
  cycleBangle(): void;
  rotate(dAz: number): void;
  resetView(): void;
  wake(): void;
}

const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  play: svg('<path d="M7 5l12 7-12 7z"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  list: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  sound: svg('<path d="M4 10v4h4l5 4V6L8 10zM16.5 9a4 4 0 010 6M19 6.5a8 8 0 010 11"/>'),
  mute: svg('<path d="M4 10v4h4l5 4V6L8 10zM17 9.5l5 5M22 9.5l-5 5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-1 .7-1.5 1.3-1.5 2.5M12 17.2v.1"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  orbit: svg('<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4.5"/>'),
  left: svg('<path d="M14.5 6l-6 6 6 6"/>'),
  right: svg('<path d="M9.5 6l6 6-6 6"/>'),
  cal: svg('<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
  later: svg('<path d="M5 12h13M13 7l5 5-5 5"/>'),
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dayLabel = (day: string) => {
  const [, m, d] = day.split('-');
  return `${Number(m)} 月 ${Number(d)} 日`;
};
const hm = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function pips(done: number, est: number, max = 8): string {
  const total = Math.max(done, est);
  const shown = Math.min(total, max);
  let out = '';
  for (let i = 0; i < shown; i++) out += `<i class="pip${i < done ? ' on' : ''}"></i>`;
  if (total > max) out += `<span class="more">+${total - max}</span>`;
  return out;
}

export class Hud {
  private state!: AppState;
  private sheetOpen = false;
  private helpOpen = false;
  private perfOn = false;
  private overview = false;
  private hovered: string | null = null;
  private listSig = '';
  private clockText = '';
  private labels = new Map<string, HTMLElement>();
  private hours = new Map<number, HTMLElement>();
  private mouse = { x: -1e4, y: -1e4, onStage: false };
  private tipKey = '';
  private toastTimer = 0;
  private awakeTimer = 0;
  /** 待辦列的拖曳排序 */
  private drag: {
    id: string;
    from: number;
    target: number;
    startY: number;
    active: boolean;
    rows: { el: HTMLElement; mid: number; h: number }[];
  } | null = null;
  private suppressClick = false;
  /** 正在看哪一天；null 是今天 */
  private viewDay: string | null = null;
  private today = '';
  private calOpen = false;
  private calMonth: { y: number; m: number } | null = null;

  private el = {
    date: $('today-date'),
    stats: $('today-stats'),
    clock: document.querySelector<HTMLElement>('.clock')!,
    status: $('clock-status'),
    digits: $('clock-digits'),
    clockActions: $('clock-actions'),
    tasksTitle: $('tasks-title'),
    samples: $('samples-note'),
    list: $('task-list'),
    empty: $('tasks-empty'),
    form: $<HTMLFormElement>('cmd'),
    input: $<HTMLInputElement>('cmd-input'),
    hint: $('cmd-hint'),
    capText: $('cap-text'),
    capPips: $('cap-pips'),
    tools: $('tools'),
    focusTitle: $('focus-title'),
    focusDigits: $('focus-digits'),
    focusSub: $('focus-sub'),
    focusActions: $('focus-actions'),
    sheet: $('sheet'),
    help: $('help'),
    labels: $('labels'),
    tip: $('tip'),
    toast: $('toast'),
    perf: $('perf'),
    cal: $('cal'),
  };

  private actions: Actions;

  constructor(actions: Actions) {
    this.actions = actions;
    this.bind();
  }

  get panelWidth(): number {
    return window.innerWidth > 860 ? 300 : 0;
  }

  setOverview(on: boolean): void {
    this.overview = on;
  }

  // ── 繪製 ────────────────────────────────────────────────

  render(state: AppState, now: number, viewDay: string | null = this.viewDay): void {
    this.state = state;
    this.viewDay = viewDay;
    this.today = dayKey(now);
    const day = viewDay ?? this.today;
    const isToday = day === this.today;
    const isPast = day < this.today;
    const label = dayLabel(day);
    const t = state.timer;
    const act = tasksForDay(state, day, this.today);
    const past = isPast ? completedOn(state, day) : [];
    const focusing = t.kind === 'run' && t.mode === 'focus';
    document.body.dataset.view = focusing && !this.overview ? 'focus' : 'overview';

    const ref = isToday ? now : dayNoon(day);
    this.el.date.innerHTML =
      ICON.cal + esc(new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric', weekday: 'long' }).format(ref));
    this.el.date.setAttribute('aria-expanded', String(this.calOpen));
    this.el.date.title = '打開月曆 (C)';
    const st = statsOn(state.sessions, ref);
    const statText = st.focusMs > 0 ? `${isToday ? '今日' : '這天'} ${st.count} 顆，專注 ${formatDuration(st.focusMs)}` : isToday ? '今天還沒開始' : isPast ? '這天沒有紀錄' : '還沒到的日子';
    this.el.stats.innerHTML = isToday
      ? esc(statText)
      : `${esc(statText)}　<button type="button" class="link" data-act="today">回到今天</button>`;

    // 番茄鐘
    const task = t.kind === 'run' && t.taskId ? state.tasks.find((x) => x.id === t.taskId) : undefined;
    const paused = t.kind === 'run' && t.pausedAt !== null;
    this.el.clock.dataset.mode = t.kind === 'run' ? (t.mode === 'focus' ? 'focus' : 'break') : 'idle';
    let status = '待命';
    let buttons = `<button type="button" class="primary" data-act="start">${ICON.play}開始專注<kbd>Space</kbd></button>`;
    if (t.kind === 'run' && t.mode === 'focus') {
      status = `${paused ? '已暫停' : '專注中'}${task ? `　${task.title}` : ''}`;
      buttons =
        (paused
          ? `<button type="button" class="primary" data-act="pause">${ICON.play}繼續<kbd>Space</kbd></button>`
          : `<button type="button" data-act="pause">${ICON.pause}暫停<kbd>Space</kbd></button>`) +
        `<button type="button" data-act="overview">${ICON.orbit}回到行星<kbd>Esc</kbd></button>` +
        `<button type="button" data-act="abandon">放棄這顆</button>`;
    } else if (t.kind === 'run') {
      status = t.mode === 'long' ? '長休息' : '休息一下';
      buttons =
        `<button type="button" class="rest" data-act="skip">略過休息<kbd>S</kbd></button>` +
        `<button type="button" data-act="start">${ICON.play}直接開始下一顆<kbd>Space</kbd></button>`;
    }
    if (!isToday && t.kind !== 'run') {
      status = isPast ? `${label}　已經過去` : `${label}　先排好，到時候再做`;
      buttons = `<button type="button" class="primary" data-act="today">回到今天<kbd>T</kbd></button>`;
    }
    this.el.status.textContent = status;
    this.el.clockActions.innerHTML = buttons;

    // 待辦
    this.el.tasksTitle.textContent = isPast
      ? `${label} 做完的 ${past.length} 件`
      : act.length
        ? isToday
          ? `軌道上 ${act.length} 件，越上面越急，可拖曳排序`
          : `${label} 排了 ${act.length} 件，可拖曳排序`
        : isToday
          ? '軌道上'
          : `${label} 還沒排事情`;
    this.el.samples.hidden = !isToday || !act.some((x) => x.sample);
    this.el.empty.hidden = isPast ? past.length > 0 : act.length > 0;
    this.el.empty.textContent = isPast
      ? '這一天沒有做完的待辦。'
      : isToday
        ? '軌道上還沒有行星。在下方輸入第一件要做的事。'
        : '在下方輸入，就會排到這一天。';
    this.el.input.disabled = isPast;
    this.el.hint.hidden = isPast;
    this.el.input.placeholder = isPast ? '過去的日子不能新增' : isToday ? '讀一章書 ×2' : `排到 ${label}：讀一章書 ×2`;
    const sig = JSON.stringify([day, act.map((x) => [x.id, x.title, x.est, x.done]), past.map((x) => x.id), state.selected, t.kind, this.hovered]);
    if (sig !== this.listSig) {
      this.listSig = sig;
      this.cancelDrag();
      const key = (document.activeElement as HTMLElement | null)?.dataset?.key;
      this.el.list.innerHTML = isPast
        ? past
            .map(
              (x) =>
                `<li class="task past"><div class="task-main">${ICON.check}<span class="task-t">${esc(x.title)}</span><span class="pips">${pips(x.done, x.done)}</span></div></li>`,
            )
            .join('')
        : act.map((x, i) => this.taskRow(x, i)).join('');
      if (key) this.el.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
      this.syncLabels(act);
    }

    // 容量
    const c = capacity(state, now, day);
    if (isPast) c.done = st.count;
    const tail =
      c.overflow > 0
        ? `，<span class="over">排不進${isToday ? '今天' : '這天'}的有 ${c.overflow} 顆</span>`
        : c.planned > 0
          ? `，${isToday ? '還排著' : '排了'} ${c.planned} 顆`
          : '';
    this.el.capText.innerHTML = `${isToday ? '今日' : label} <b>${c.done}</b>／${c.budget} 顆${tail}`;
    let cp = '';
    const inBudget = Math.min(c.planned, Math.max(0, c.budget - c.done));
    for (let i = 0; i < Math.min(c.done, 24); i++) cp += '<i class="pip on"></i>';
    for (let i = 0; i < inBudget; i++) cp += '<i class="pip"></i>';
    for (let i = 0; i < c.free; i++) cp += '<i class="pip" style="opacity:.35"></i>';
    for (let i = 0; i < Math.min(c.overflow, 12); i++) cp += '<i class="pip over"></i>';
    this.el.capPips.innerHTML = cp;

    // 工具
    const snd = state.settings.sound;
    this.el.tools.innerHTML =
      `<button type="button" class="icon" data-act="sheet" aria-label="紀錄與設定" title="紀錄與設定 (L)" aria-pressed="${this.sheetOpen}">${ICON.list}</button>` +
      `<button type="button" class="icon" data-act="mute" aria-label="${snd ? '關閉提示音' : '開啟提示音'}" title="提示音 (M)">${snd ? ICON.sound : ICON.mute}</button>` +
      `<button type="button" class="icon" data-act="help" aria-label="鍵盤操作說明" title="鍵盤操作 (?)" aria-pressed="${this.helpOpen}">${ICON.help}</button>`;

    // 專注畫面
    if (focusing) {
      this.el.focusTitle.textContent = task ? task.title : '專注';
      this.el.focusSub.textContent = task
        ? `這是第 ${task.done + 1} 顆，預估 ${task.est} 顆${paused ? '　已暫停' : ''}`
        : paused
          ? '已暫停'
          : '';
      this.el.focusActions.innerHTML =
        (paused
          ? `<button type="button" class="primary" data-act="pause">${ICON.play}繼續<kbd>Space</kbd></button>`
          : `<button type="button" data-act="pause">${ICON.pause}暫停<kbd>Space</kbd></button>`) +
        (task ? `<button type="button" data-act="complete" data-id="${task.id}">${ICON.check}這件做完了</button>` : '') +
        `<button type="button" data-act="overview">${ICON.orbit}看整個星系<kbd>Esc</kbd></button>` +
        `<button type="button" data-act="abandon">放棄這顆</button>`;
    }

    if (this.sheetOpen) this.renderLog(now);
    this.el.cal.hidden = !this.calOpen;
    if (this.calOpen) this.renderCal();
    this.clockText = '';
    this.tick(state, now);
  }

  private taskRow(x: Task, i: number): string {
    const sel = this.state.selected === x.id;
    const future = this.viewDay !== null && this.viewDay > this.today;
    const cls = `task${sel ? ' selected' : ''}${this.hovered === x.id ? ' hover' : ''}`;
    const id = esc(x.id);
    return (
      `<li class="${cls}" data-id="${id}">` +
      `<button type="button" class="task-main" data-act="select" data-id="${id}" data-key="m:${id}" aria-expanded="${sel}">` +
      `<span class="task-n">${i + 1}</span><span class="task-t">${esc(x.title)}</span>` +
      `<span class="pips" aria-label="已完成 ${x.done} 顆，預估 ${x.est} 顆">${pips(x.done, x.est)}</span></button>` +
      `<div class="task-ops"><div><div class="row">` +
      (future
        ? `<button type="button" class="primary" data-act="resched" data-id="${id}" data-day="${this.today}" data-key="s:${id}">移到今天</button>`
        : `<button type="button" class="primary" data-act="start" data-id="${id}" data-key="s:${id}">${ICON.play}專注</button>`) +
      `<button type="button" data-act="complete" data-id="${id}" data-key="c:${id}">${ICON.check}做完了</button>` +
      `<span class="spacer"></span>` +
      `<button type="button" class="icon" data-act="remove" data-id="${id}" data-key="r:${id}" aria-label="刪除「${esc(x.title)}」">${ICON.trash}</button>` +
      `</div><div class="row est-row"><span class="est-label">預估</span>` +
      `<button type="button" class="icon" data-act="est-" data-id="${id}" data-key="e-:${id}" aria-label="預估減一顆"${x.est <= 1 ? ' disabled' : ''}>${ICON.minus}</button>` +
      `<span class="est">${x.est} 顆</span>` +
      `<button type="button" class="icon" data-act="est+" data-id="${id}" data-key="e+:${id}" aria-label="預估加一顆"${x.est >= 12 ? ' disabled' : ''}>${ICON.plus}</button>` +
      (future
        ? ''
        : `<button type="button" class="later" data-act="resched" data-id="${id}" data-day="${shiftDay(this.today, 1)}" data-key="l:${id}">明天再做${ICON.later}</button>`) +
      `</div></div></div></li>`
    );
  }

  private syncLabels(act: Task[]): void {
    const keep = new Set(act.map((x) => x.id));
    for (const [id, node] of this.labels) {
      if (!keep.has(id)) {
        node.remove();
        this.labels.delete(id);
      }
    }
    for (const x of act) {
      let node = this.labels.get(x.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'plabel';
        node.style.opacity = '0';
        this.el.labels.append(node);
        this.labels.set(x.id, node);
      }
      node.innerHTML = `${esc(x.title)}<small>${x.done}/${x.est}</small>`;
      node.classList.toggle('selected', this.state.selected === x.id);
      node.classList.toggle('hover', this.hovered === x.id);
    }
  }

  /** 每秒一次：只更新會隨時間變的文字 */
  tick(state: AppState, now: number): void {
    const t = state.timer;
    const ms = t.kind === 'run' ? remaining(t, now) : durationOf('focus', state.settings);
    const text = formatClock(ms);
    if (text === this.clockText) return;
    this.clockText = text;
    const html = Array.from(text, (ch) => (ch === ':' ? '<span class="sep">:</span>' : `<span>${ch}</span>`)).join('');
    this.el.digits.innerHTML = html;
    this.el.digits.setAttribute('aria-label', text);
    if (t.kind === 'run' && t.mode === 'focus') this.el.focusDigits.innerHTML = html;
  }

  /** 每一幀：把 3D 投影出來的位置套到標籤上 */
  frame(info: FrameInfo): void {
    for (const p of info.planets) {
      const node = this.labels.get(p.id);
      if (!node) continue;
      const a = p.alpha < 0.02 ? 0 : p.alpha;
      node.style.opacity = a.toFixed(2);
      if (a > 0) {
        const left = p.x < info.sunX;
        node.classList.toggle('left', left);
        node.style.transform = left
          ? `translate3d(${(p.x - p.r - 9).toFixed(1)}px,${(p.y - 9).toFixed(1)}px,0) translateX(-100%)`
          : `translate3d(${(p.x + p.r + 9).toFixed(1)}px,${(p.y - 9).toFixed(1)}px,0)`;
      }
    }
    const shown = new Set<number>();
    for (const h of info.hours) {
      shown.add(h.h);
      let node = this.hours.get(h.h);
      if (!node) {
        node = document.createElement('div');
        node.className = 'hlabel';
        node.textContent = `${h.h} 時`;
        this.el.labels.append(node);
        this.hours.set(h.h, node);
      }
      node.style.opacity = (h.alpha * 0.9).toFixed(2);
      node.style.transform = `translate3d(${h.x.toFixed(1)}px,${h.y.toFixed(1)}px,0) translate(-50%,-50%)`;
    }
    for (const [h, node] of this.hours) if (!shown.has(h)) node.style.opacity = '0';

    // 星座提示：游標靠近哪一天的星座，就列出那天做完的事
    let near = '';
    let nx = 0;
    let ny = 0;
    if (this.mouse.onStage && info.focusBlend < 0.3) {
      let best = 70;
      for (const s of info.sky) {
        const d = Math.hypot(s.x - this.mouse.x, s.y - this.mouse.y);
        if (d < best) {
          best = d;
          near = s.key;
          nx = s.x;
          ny = s.y;
        }
      }
    }
    if (near !== this.tipKey) {
      this.tipKey = near;
      this.el.tip.hidden = near === '';
      if (near) this.el.tip.innerHTML = this.tipHtml(near);
    }
    if (near) {
      const w = this.el.tip.offsetWidth;
      const x = Math.min(info.w - w - 12, Math.max(12, nx + 18));
      this.el.tip.style.transform = `translate3d(${x.toFixed(0)}px,${(ny + 18).toFixed(0)}px,0)`;
    }
  }

  private tipHtml(key: string): string {
    const done = this.state.tasks.filter((x) => x.completedAt !== null && dayKey(x.completedAt) === key);
    const [, m, d] = key.split('-');
    const count = done.reduce((s, x) => s + x.done, 0);
    const items = done.slice(0, 6).map((x) => `<li>${esc(x.title)}</li>`).join('');
    const more = done.length > 6 ? `<li>還有 ${done.length - 6} 件</li>` : '';
    return `<b>${Number(m)} 月 ${Number(d)} 日　做完 ${done.length} 件，共 ${count} 顆</b><ul>${items}${more}</ul>`;
  }

  // ── 拖曳排序 ────────────────────────────────────────────

  private onDragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (!d.active) {
      if (Math.abs(dy) < 6) return;
      d.active = true;
      this.el.list.classList.add('sorting');
      d.rows[d.from]!.el.classList.add('dragging');
    }
    const me = d.rows[d.from]!;
    const first = d.rows[0]!;
    const last = d.rows[d.rows.length - 1]!;
    // 被拖的那一列不能離開清單的上下緣
    const minDy = first.mid - first.h / 2 - (me.mid - me.h / 2);
    const maxDy = last.mid + last.h / 2 - (me.mid + me.h / 2);
    const cdy = Math.min(maxDy, Math.max(minDy, dy));
    me.el.style.transform = `translate3d(0,${cdy.toFixed(1)}px,0)`;
    // 越過哪一列的中線，那一列就讓出位置
    // 判定用游標實際的位移，不用被夾住的位置：拖過頭也要算數
    const center = me.mid + dy;
    let target = d.from;
    d.rows.forEach((r, i) => {
      if (i === d.from) return;
      let shift = 0;
      if (i < d.from && center < r.mid) {
        shift = me.h;
        target--;
      } else if (i > d.from && center > r.mid) {
        shift = -me.h;
        target++;
      }
      r.el.style.transform = shift ? `translate3d(0,${shift.toFixed(1)}px,0)` : '';
    });
    d.target = target;
  }

  private endDrag(commit: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.cancelDrag();
    if (!d.active) return;
    // 放開滑鼠會接著觸發一次 click，不能把它當成「選取」
    this.suppressClick = true;
    window.setTimeout(() => (this.suppressClick = false), 0);
    if (commit && d.target !== d.from) this.actions.move(d.id, d.target - d.from);
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.el.list.classList.remove('sorting');
    for (const r of d.rows) {
      r.el.style.transform = '';
      r.el.classList.remove('dragging');
    }
  }

  setHover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    for (const li of this.el.list.querySelectorAll<HTMLElement>('.task')) li.classList.toggle('hover', li.dataset.id === id);
    for (const [pid, node] of this.labels) node.classList.toggle('hover', pid === id);
  }

  toast(message: string, undo = false): void {
    window.clearTimeout(this.toastTimer);
    this.el.toast.innerHTML =
      `<span>${esc(message)}</span>` + (undo ? `<button type="button" data-act="undo">復原<kbd>Ctrl Z</kbd></button>` : '');
    this.el.toast.hidden = false;
    this.toastTimer = window.setTimeout(() => (this.el.toast.hidden = true), undo ? 7000 : 3500);
  }

  hideToast(): void {
    window.clearTimeout(this.toastTimer);
    this.el.toast.hidden = true;
  }

  showPerf(p: PerfInfo): void {
    if (!this.perfOn) return;
    this.el.perf.textContent = `${p.fps} fps（目標 ${p.target}）　解析度 ×${p.dpr.toFixed(2)}　繪製 ${p.calls} 次　${p.triangles.toLocaleString()} 個三角形`;
  }

  // ── 紀錄與設定 ──────────────────────────────────────────

  private renderSheet(now: number): void {
    const s = this.state.settings;
    const num = (name: keyof Settings, label: string, min: number, max: number) =>
      `<label class="field"><span>${label}</span><input type="number" name="${name}" min="${min}" max="${max}" step="1" value="${s[name]}" /></label>`;
    this.el.sheet.innerHTML =
      `<header><h2>紀錄與設定</h2><button type="button" class="icon" data-act="sheet" aria-label="關閉">${ICON.close}</button></header>` +
      `<section><h3>今天的番茄</h3><ul class="log" id="sheet-log"></ul></section>` +
      `<section><h3>最近十四天</h3><div class="hist" id="sheet-hist"></div></section>` +
      `<section><h3>番茄鐘</h3>` +
      num('focusMin', '專注（分鐘）', 1, 120) +
      num('breakMin', '短休息（分鐘）', 1, 60) +
      num('longMin', '長休息（分鐘）', 1, 90) +
      num('longEvery', '每幾顆換長休息', 2, 12) +
      num('budget', '一天打算做幾顆', 1, 24) +
      `</section><section><h3>聲音與畫面</h3>` +
      `<label class="field"><span>番茄結束時播放提示音</span><input type="checkbox" name="sound"${s.sound ? ' checked' : ''} /></label>` +
      `<label class="field"><span>音量</span><input type="range" name="volume" min="0" max="1" step="0.05" value="${s.volume}" /></label>` +
      `<label class="field"><span>減少動態（鏡頭直接切換）</span><input type="checkbox" name="motion"${s.motion === 'reduced' ? ' checked' : ''} /></label>` +
      `<label class="field"><span>省電畫質</span><input type="checkbox" name="quality"${s.quality === 'low' ? ' checked' : ''} /></label>` +
      `<p class="note">省電畫質會關掉大氣光暈、降低解析度與表面細節。按 F 可以看目前的更新率。</p>` +
      `</section><section><h3>資料</h3><div class="row">` +
      `<button type="button" data-act="export">匯出備份</button>` +
      `<button type="button" data-act="import">從備份匯入</button></div>` +
      `<input type="file" id="import-file" accept="application/json,.json" hidden />` +
      `<p class="note">資料只存在這台電腦的這個瀏覽器裡，清除瀏覽資料會一併清掉，建議偶爾匯出備份。</p></section>`;
    this.renderLog(now);
  }

  private renderLog(now: number): void {
    const log = document.getElementById('sheet-log');
    const hist = document.getElementById('sheet-hist');
    if (!log || !hist) return;
    const list = focusSessionsOn(this.state.sessions, now);
    log.innerHTML = list.length
      ? list
          .map(
            (x) =>
              `<li><time>${hm(x.start)}–${hm(x.end)}</time><span${x.completed ? '' : ' class="part"'}>${esc(x.taskTitle || '沒有指定待辦')}${x.completed ? '' : '（未滿一顆）'}</span></li>`,
          )
          .join('')
      : '<li class="none" style="display:block">今天還沒有紀錄。做完第一顆番茄就會出現在這裡。</li>';
    const days = history(this.state.sessions, now, 14);
    const max = Math.max(1, ...days.map((d) => d.count));
    hist.innerHTML = days
      .map((d, i) => {
        const day = new Date(d.at).getDate();
        return `<div class="${i === days.length - 1 ? 'today' : ''}" title="${d.key}：${d.count} 顆"><i style="height:${Math.round((d.count / max) * 100)}%"></i>${day}</div>`;
      })
      .join('');
  }

  private renderHelp(): void {
    const k = (...keys: string[]) => keys.map((x) => `<kbd>${x}</kbd>`).join('');
    const rows: [string, string][] = [
      [k('N'), '輸入新的待辦'],
      [k('Space'), '開始專注、暫停、繼續'],
      [k('↑', '↓'), '選上一件、下一件'],
      [k('Alt', '↑↓'), '把選取的待辦往內圈、外圈移'],
      [k('D'), '選取的待辦做完了'],
      [k('+', '−'), '預估番茄數加減一顆'],
      [k('Del'), '刪除選取的待辦'],
      [k('Esc'), '專注時切換行星與整個星系'],
      [k('←', '→'), '轉動星系；專注時是繞著行星看。按 0 回到預設視角'],
      [k('B'), '切換月亮軌道的樣式（專注時看得到）'],
      [k('S'), '略過休息'],
      [k('C'), '月曆：點某一天，就能先排那天的待辦'],
      [k('[', ']'), '看前一天、後一天；按 T 回到今天'],
      [k('L'), '紀錄與設定'],
      [k('M'), '提示音開關'],
      [k('Ctrl', 'Z'), '復原上一次的完成或刪除'],
    ];
    this.el.help.innerHTML =
      `<h2>鍵盤操作</h2><dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>` +
      `<p class="note" style="margin-top:12px;font-size:12px;color:var(--ink-3)">待辦列可以上下拖曳排序。按住星空的空白處拖曳是轉動星系；專注時按住拖曳是繞著行星上下左右看。連點兩下回到預設視角。拖曳行星也能改優先度：拉近太陽就是往前排。</p>`;
  }

  // ── 月曆 ────────────────────────────────────────────────

  private renderCal(): void {
    const today = this.today;
    const sel = this.viewDay ?? today;
    if (!this.calMonth) {
      const [y, m] = sel.split('-').map(Number);
      this.calMonth = { y: y!, m: m! };
    }
    const { y, m } = this.calMonth;
    const pad = (n: number) => String(n).padStart(2, '0');
    // 每天排了幾件：沒做完的舊待辦都算在今天
    const planned = new Map<string, number>();
    for (const t of this.state.tasks) {
      if (t.completedAt !== null) continue;
      const k = t.day <= today ? today : t.day;
      planned.set(k, (planned.get(k) ?? 0) + 1);
    }
    const done = new Map<string, number>();
    for (const x of this.state.sessions) {
      if (x.mode !== 'focus' || !x.completed) continue;
      const k = dayKey(x.start);
      done.set(k, (done.get(k) ?? 0) + 1);
    }
    const lead = new Date(y, m - 1, 1).getDay();
    const count = new Date(y, m, 0).getDate();
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span></span>';
    for (let d = 1; d <= count; d++) {
      const key = `${y}-${pad(m)}-${pad(d)}`;
      const nDone = done.get(key) ?? 0;
      const nPlan = key >= today ? (planned.get(key) ?? 0) : 0;
      const cls = ['day', key === today ? 'is-today' : '', key === sel ? 'is-sel' : '', key < today ? 'is-past' : ''].filter(Boolean).join(' ');
      const aria = `${m} 月 ${d} 日${key === today ? '，今天' : ''}${nDone ? `，完成 ${nDone} 顆` : ''}${nPlan ? `，排了 ${nPlan} 件` : ''}`;
      cells +=
        `<button type="button" class="${cls}" data-act="pick-day" data-day="${key}" aria-label="${aria}" aria-pressed="${key === sel}">` +
        `<b>${d}</b><span class="marks">${nDone ? `<i class="c-done">${nDone}</i>` : ''}${nPlan ? `<i class="c-plan">${nPlan}</i>` : ''}</span></button>`;
    }
    this.el.cal.innerHTML =
      `<header><button type="button" class="icon" data-act="cal-prev" aria-label="上個月">${ICON.left}</button>` +
      `<h2>${y} 年 ${m} 月</h2>` +
      `<button type="button" class="icon" data-act="cal-next" aria-label="下個月">${ICON.right}</button></header>` +
      `<div class="cal-grid">${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span class="dow">${w}</span>`).join('')}${cells}</div>` +
      `<footer><span class="legend"><i class="c-done">3</i>做完的番茄<i class="c-plan">2</i>排著的待辦</span>` +
      `<button type="button" data-act="today">今天<kbd>T</kbd></button></footer>`;
  }

  openCalendar(): void {
    this.toggleCal(true);
  }

  private toggleCal(force?: boolean): void {
    this.calOpen = force ?? !this.calOpen;
    if (this.calOpen) this.calMonth = null;
    this.render(this.state, Date.now());
    if (this.calOpen) this.el.cal.querySelector<HTMLElement>('.is-sel')?.focus();
  }

  private stepMonth(delta: number): void {
    if (!this.calMonth) return;
    const d = new Date(this.calMonth.y, this.calMonth.m - 1 + delta, 1);
    this.calMonth = { y: d.getFullYear(), m: d.getMonth() + 1 };
    this.renderCal();
  }

  private toggleSheet(force?: boolean): void {
    this.sheetOpen = force ?? !this.sheetOpen;
    this.el.sheet.hidden = !this.sheetOpen;
    if (this.sheetOpen) {
      this.renderSheet(Date.now());
      this.el.sheet.querySelector<HTMLElement>('button')?.focus();
    }
    this.render(this.state, Date.now());
  }

  private toggleHelp(force?: boolean): void {
    this.helpOpen = force ?? !this.helpOpen;
    this.el.help.hidden = !this.helpOpen;
    if (this.helpOpen) this.renderHelp();
    this.render(this.state, Date.now());
  }

  // ── 事件 ────────────────────────────────────────────────

  private bind(): void {
    const a = this.actions;

    document.getElementById('ui')!.addEventListener('click', (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      const id = btn.dataset.id ?? null;
      switch (btn.dataset.act) {
        case 'select':
          a.select(this.state.selected === id ? null : id);
          break;
        case 'start':
          a.start(id);
          break;
        case 'pause':
          a.pauseResume();
          break;
        case 'abandon':
          a.abandon();
          break;
        case 'skip':
          a.skipBreak();
          break;
        case 'overview':
          a.toggleOverview();
          break;
        case 'complete':
          if (id) a.complete(id);
          break;
        case 'remove':
          if (id) a.remove(id);
          break;
        case 'est+':
          if (id) a.est(id, 1);
          break;
        case 'est-':
          if (id) a.est(id, -1);
          break;
        case 'undo':
          a.undo();
          break;
        case 'clear-samples':
          a.clearSamples();
          break;
        case 'cal':
          this.toggleCal();
          break;
        case 'cal-prev':
          this.stepMonth(-1);
          break;
        case 'cal-next':
          this.stepMonth(1);
          break;
        case 'pick-day':
          this.calOpen = false;
          if (btn.dataset.day) a.setDay(btn.dataset.day);
          this.render(this.state, Date.now());
          break;
        case 'today':
          this.calOpen = false;
          a.setDay(null);
          this.render(this.state, Date.now());
          break;
        case 'resched':
          if (id && btn.dataset.day) a.reschedule(id, btn.dataset.day);
          break;
        case 'sheet':
          this.toggleSheet();
          break;
        case 'help':
          this.toggleHelp();
          break;
        case 'mute':
          a.settings({ sound: !this.state.settings.sound });
          break;
        case 'export':
          a.exportData();
          break;
        case 'import':
          document.getElementById('import-file')?.click();
          break;
      }
    });

    this.el.sheet.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.id === 'import-file') {
        const file = input.files?.[0];
        if (file) a.importData(file);
        input.value = '';
        return;
      }
      const name = input.name as keyof Settings;
      if (name === 'sound') a.settings({ sound: input.checked });
      else if (name === 'motion') a.settings({ motion: input.checked ? 'reduced' : 'auto' });
      else if (name === 'quality') a.settings({ quality: input.checked ? 'low' : 'auto' });
      else if (input.value !== '') a.settings({ [name]: Number(input.value) });
    });

    // 待辦列拖曳排序：按住某一列上下拖，放開後行星滑到新的軌道
    this.el.list.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const li = (e.target as HTMLElement).closest<HTMLElement>('.task-main')?.closest<HTMLElement>('.task');
      if (!li) return;
      const items = [...this.el.list.querySelectorAll<HTMLElement>('.task')];
      if (items.length < 2) return;
      const from = items.indexOf(li);
      this.drag = {
        id: li.dataset.id!,
        from,
        target: from,
        startY: e.clientY,
        active: false,
        rows: items.map((el) => {
          const r = el.getBoundingClientRect();
          return { el, mid: r.top + r.height / 2, h: r.height };
        }),
      };
    });
    window.addEventListener('pointermove', (e) => this.onDragMove(e));
    window.addEventListener('pointerup', () => this.endDrag(true));
    window.addEventListener('pointercancel', () => this.endDrag(false));
    window.addEventListener('blur', () => this.endDrag(false));

    this.el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (a.add(this.el.input.value)) {
        this.el.input.value = '';
        this.updateHint();
      } else {
        this.el.hint.textContent = '先寫下要做的事，再按 Enter';
        this.el.hint.className = 'bad';
      }
    });
    this.el.input.addEventListener('input', () => this.updateHint());

    window.addEventListener(
      'pointermove',
      (e) => {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.onStage = (e.target as HTMLElement).id === 'stage';
        this.awake();
      },
      { passive: true },
    );
    window.addEventListener('resize', () => a.wake());
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** 專注畫面的按鈕平常隱藏，動一下滑鼠或按鍵才出現幾秒 */
  private awake(): void {
    document.body.dataset.awake = '1';
    window.clearTimeout(this.awakeTimer);
    this.awakeTimer = window.setTimeout(() => delete document.body.dataset.awake, 3200);
    this.actions.wake();
  }

  private updateHint(): void {
    const q = parseQuickAdd(this.el.input.value);
    if (!q) {
      this.el.hint.textContent = '結尾加 ×3 是預估三顆番茄，加 ! 排到最內圈';
      this.el.hint.className = '';
      return;
    }
    this.el.hint.textContent = `按 Enter 新增「${q.title}」，預估 ${q.est} 顆，${q.urgent ? '排到最內圈' : '排到最外圈'}`;
    this.el.hint.className = 'live';
  }

  private onKey(e: KeyboardEvent): void {
    const a = this.actions;
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    this.awake();

    if (e.key === 'Escape') {
      if (typing) return void target.blur();
      if (this.drag?.active) return this.endDrag(false);
      if (this.calOpen) return this.toggleCal(false);
      if (this.helpOpen) return this.toggleHelp(false);
      if (this.sheetOpen) return this.toggleSheet(false);
      const t = this.state.timer;
      if (t.kind === 'run' && t.mode === 'focus') return a.toggleOverview();
      return a.select(null);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      return a.undo();
    }
    if (typing || e.ctrlKey || e.metaKey) return;

    const act = tasksForDay(this.state, this.viewDay ?? this.today, this.today);
    const sel = this.state.selected;
    const idx = act.findIndex((x) => x.id === sel);
    const onButton = target.tagName === 'BUTTON';

    switch (e.key) {
      case ' ': {
        if (onButton) return;
        e.preventDefault();
        const t = this.state.timer;
        if (t.kind === 'run' && t.mode === 'focus') a.pauseResume();
        else a.start(sel);
        return;
      }
      case 'n':
      case 'N':
      case '/':
        e.preventDefault();
        this.el.input.focus();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!act.length) return;
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        if (e.altKey) {
          if (sel) a.move(sel, dir);
          return;
        }
        const next = idx < 0 ? (dir > 0 ? 0 : act.length - 1) : (idx + dir + act.length) % act.length;
        a.select(act[next]!.id);
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        e.preventDefault();
        a.rotate(e.key === 'ArrowLeft' ? 0.24 : -0.24);
        return;
      case '0':
      case 'Home':
        a.resetView();
        return;
      case 'b':
      case 'B':
        a.cycleBangle();
        return;
      case 'c':
      case 'C':
        this.toggleCal();
        return;
      case 't':
      case 'T':
        this.calOpen = false;
        a.setDay(null);
        this.render(this.state, Date.now());
        return;
      case '[':
      case ']':
        a.setDay(shiftDay(this.viewDay ?? this.today, e.key === ']' ? 1 : -1));
        return;
      case 'd':
      case 'D':
        if (sel) a.complete(sel);
        return;
      case 'Delete':
        if (sel) a.remove(sel);
        return;
      case '+':
      case '=':
        if (sel) a.est(sel, 1);
        return;
      case '-':
      case '_':
        if (sel) a.est(sel, -1);
        return;
      case 's':
      case 'S':
        a.skipBreak();
        return;
      case 'l':
      case 'L':
        this.toggleSheet();
        return;
      case 'm':
      case 'M':
        a.settings({ sound: !this.state.settings.sound });
        return;
      case '?':
        this.toggleHelp();
        return;
      case 'f':
      case 'F':
        this.perfOn = !this.perfOn;
        this.el.perf.hidden = !this.perfOn;
        return;
    }
  }
}
