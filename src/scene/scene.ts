/**
 * 3D 場景。只讀 AppState、只透過 hooks 回報使用者的操作，不自己改資料。
 *
 * 省電的做法集中在這個檔案：
 * - 星雲在啟動時烤成一張立方體貼圖，之後每幀只取樣
 * - 沒有後製、沒有陰影貼圖；光暈用加色面片，行星環的影子在 shader 裡解析計算
 * - 依情境切換更新率：操作中 60、靜置 30、專注中 20、視窗失焦 12、分頁隱藏 0
 * - 連續掉幀時自動調降解析度
 */
import * as THREE from 'three';
import { dayNoon, tasksForDay, type AppState, type Task } from '../core/model.ts';
import { angularSpeed, constellation, initialAngle, orbitRadius, planetRadius, slotFromRadius, SUN_RADIUS } from '../core/orbit.ts';
import { hashString, mulberry32 } from '../core/rng.ts';
import { dayFraction, dayKey, focusSessionsOn } from '../core/stats.ts';
import { progress } from '../core/timer.ts';
import * as G from './shaders.ts';

export const DIAL_R = 10.9;
const SKY_R = 380;
const TAU = Math.PI * 2;
const FOV = 38;
const ELEV = (33 * Math.PI) / 180;
const MAX_CONSTELLATIONS = 12;

const ADD = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
} as const;
const OVER = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
} as const;

interface Recipe {
  type: 0 | 1 | 2 | 3;
  a: number;
  b: number;
  c: number;
  atmo: number;
}
/** 行星的配方：類型加三個表面色與大氣色。由待辦的種子挑一個 */
const RECIPES: Recipe[] = [
  { type: 0, a: 0x9c4a2e, b: 0xc97b4a, c: 0x5a2e22, atmo: 0xff9d6b },
  { type: 1, a: 0xc9a27a, b: 0x8a5a3c, c: 0xf1dcc0, atmo: 0xffd9a8 },
  { type: 2, a: 0x1f5fae, b: 0x3f7d3a, c: 0xb59a62, atmo: 0x7fc0ff },
  { type: 3, a: 0xcfe3ee, b: 0x9fbfd4, c: 0x7a5a48, atmo: 0xcfefff },
  { type: 1, a: 0x2b59c3, b: 0x4f8fe8, c: 0xb8d8ff, atmo: 0x6fa8ff },
  { type: 0, a: 0x7d7a75, b: 0xa9a39a, c: 0x4c4a48, atmo: 0xb9c4d6 },
  { type: 1, a: 0xd9c08a, b: 0xb89a5e, c: 0xf3e6c4, atmo: 0xffe9b0 },
  { type: 2, a: 0x127a7a, b: 0x7a9a3a, c: 0xd9c9a0, atmo: 0x7fffe0 },
  { type: 1, a: 0x6b4a9c, b: 0xa57fd1, c: 0xe7d6ff, atmo: 0xc3a1ff },
  { type: 0, a: 0xc9a23a, b: 0xe2c96a, c: 0x7a4a1f, atmo: 0xffe08a },
  { type: 3, a: 0xe9d3d8, b: 0xc9a3b4, c: 0x7a4a5c, atmo: 0xffd0e0 },
];

export interface ScreenPoint {
  id: string;
  x: number;
  y: number;
  /** 行星在畫面上的半徑（px） */
  r: number;
  alpha: number;
}
export interface FrameInfo {
  w: number;
  h: number;
  planets: ScreenPoint[];
  hours: { h: number; x: number; y: number; alpha: number }[];
  sky: { key: string; x: number; y: number }[];
  /** 0 = 俯瞰，1 = 貼近專注中的行星 */
  focusBlend: number;
  /** 太陽在畫面上的 x：標籤放在背對太陽的那一側 */
  sunX: number;
}
export interface SceneHooks {
  onHover(id: string | null): void;
  onSelect(id: string | null): void;
  onReorder(id: string, to: number): void;
  onFrame(info: FrameInfo): void;
}
export interface PerfInfo {
  fps: number;
  target: number;
  dpr: number;
  calls: number;
  triangles: number;
}

interface PlanetView {
  id: string;
  group: THREE.Group;
  tilt: THREE.Group;
  body: THREE.Mesh;
  atmo: THREE.Mesh;
  ring: THREE.Mesh;
  orbit: THREE.LineLoop;
  u: Record<string, THREE.IUniform>;
  ou: Record<string, THREE.IUniform>;
  ru: Record<string, THREE.IUniform>;
  angle: number;
  radius: number;
  targetRadius: number;
  size: number;
  targetSize: number;
  appear: number;
  alive: boolean;
  hover: number;
  spinRate: number;
  color: THREE.Color;
}

interface Spark {
  sprite: THREE.Sprite;
  from: THREE.Vector3;
  ctrl: THREE.Vector3;
  local: THREE.Vector3;
  t: number;
}

const ease = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class Scene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1200);
  private skyGroup = new THREE.Group();
  private sphereGeo = new THREE.SphereGeometry(1, 48, 32);
  private ringGeo = new THREE.RingGeometry(1.3, 3.3, 112, 1);
  private orbitGeo = new THREE.BufferGeometry();
  private planets = new Map<string, PlanetView>();
  private sparks: Spark[] = [];
  private sparkTex: THREE.Texture;

  private uTime = { value: 0 };
  private uCursor = { value: new THREE.Vector2(99, 99) };
  private uPull = { value: 0 };
  private sunU: Record<string, THREE.IUniform>;
  private coronaU: Record<string, THREE.IUniform>;
  private corona: THREE.Mesh;
  private sun: THREE.Mesh;
  /** 專注時掛在行星上的月亮與它的軌道 */
  private timerGroup = new THREE.Group();
  private moon!: THREE.Mesh;
  private moonU!: Record<string, THREE.IUniform>;
  private moonOrbitU!: Record<string, THREE.IUniform>;
  private bangleGlowU!: Record<string, THREE.IUniform>;
  private bangleTube!: THREE.Mesh;
  private bangleGlow!: THREE.Mesh;
  private bangleLine!: THREE.Mesh;
  private bangleStyle = 0;
  private starsU: Record<string, THREE.IUniform>;
  private skyU: Record<string, THREE.IUniform> = { uSky: { value: null }, uGain: { value: 1 } };
  private dialGroup = new THREE.Group();
  private dialU: Record<string, THREE.IUniform>;
  private arcDone: THREE.Mesh;
  private arcPart: THREE.Mesh;
  private arcU: Record<string, THREE.IUniform>;
  private arcPartU: Record<string, THREE.IUniform>;
  private nowMark = new THREE.Group();
  private conPoints: THREE.Points;
  private conLines: THREE.LineSegments;
  private conU: Record<string, THREE.IUniform>;
  private conAnchors: { key: string; local: THREE.Vector3 }[] = [];
  private conStarLocal = new Map<string, THREE.Vector3>();
  private seenCompleted: Set<string> | null = null;
  private refBasis: { fwd: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3; tanH: number; tanV: number };

  private state: AppState | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private focusId: string | null = null;
  private overviewOverride = false;
  private focusBlend = 0;
  private reduced = false;
  /** 正在看的是不是今天；不是的話 viewRef 是那一天中午的時間戳 */
  private isToday = true;
  private viewRef: number | null = null;
  private lowQuality = false;

  private w = 1;
  private h = 1;
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3(0, -0.4, 0);
  private viewShift = new THREE.Vector2();
  private overviewShift = new THREE.Vector2();
  private fitCam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1200);
  private panelShiftPx = 0;
  private overviewDist = 22;
  /** 使用者轉動星系後的視角：azimuth 繞垂直軸，elev 是俯角 */
  private azimuth = 0;
  private elev = ELEV;
  private azVel = 0;
  private fitElev = ELEV;
  private resetting = false;
  private rotateLast: { x: number; y: number; t: number; focus: boolean } | null = null;
  /** 專注時使用者繞著行星轉的角度，相對於預設的鏡頭位置 */
  private focusAz = 0;
  private focusEl = 0;
  private focusReset = false;
  /** 月亮的起點是否已經依目前的鏡頭定好 */
  private timerAnchored = false;
  private settled = false;

  private pointer = { x: 0, y: 0, inside: false, moved: false, lastMs: -1e9, px: 0, py: 0 };
  private press: { id: string | null; x: number; y: number; dragging: boolean } | null = null;
  private dragRadius = 0;
  private ray = new THREE.Raycaster();

  private raf = 0;
  private lastFrameMs = 0;
  private lastMinute = -1;
  private busy = true;
  private dprLevels: number[] = [1];
  private dprIndex = 0;
  private slowFrames = 0;
  private fpsAvg = 60;
  private targetFps = 60;
  private sessionSig = '';
  private completedSig = '';
  private info: FrameInfo = { w: 1, h: 1, planets: [], hours: [], sky: [], focusBlend: 0, sunX: 0 };
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  private canvas: HTMLCanvasElement;
  private hooks: SceneHooks;

  constructor(canvas: HTMLCanvasElement, hooks: SceneHooks) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: false });
    this.renderer.setClearColor(0x04060c, 1);
    this.renderer.autoClear = true;

    // 軌道線共用一份幾何：256 個角度，半徑由各自的 uniform 決定
    const N = 256;
    const angles = new Float32Array(N);
    for (let i = 0; i < N; i++) angles[i] = (i / N) * TAU;
    this.orbitGeo.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
    this.orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));

    this.refBasis = this.makeRefBasis();
    this.scene.add(this.skyGroup);
    this.bakeSky();
    this.starsU = this.buildStars();

    // 太陽
    this.sunU = { uTime: this.uTime, uGain: { value: 1 }, uTint: { value: new THREE.Vector3(1, 1, 1) } };
    this.sun = new THREE.Mesh(
      this.sphereGeo,
      new THREE.ShaderMaterial({ vertexShader: G.BODY_VERT, fragmentShader: G.SUN_FRAG, uniforms: this.sunU }),
    );
    this.sun.scale.setScalar(SUN_RADIUS);
    this.scene.add(this.sun);

    const half = 7;
    this.coronaU = {
      uTime: this.uTime,
      uGain: { value: 1 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uR0: { value: SUN_RADIUS / half },
      uArc: { value: 0 },
      uProgress: { value: 0 },
      uArcColor: { value: new THREE.Vector3(1, 0.72, 0.35) },
    };
    this.corona = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.ShaderMaterial({
        vertexShader: G.BILLBOARD_VERT,
        fragmentShader: G.CORONA_FRAG,
        uniforms: this.coronaU,
        ...ADD,
      }),
    );
    this.corona.renderOrder = 5;
    this.scene.add(this.corona);

    // 24 小時刻度盤
    this.dialU = { uColor: { value: new THREE.Vector3(0.72, 0.76, 0.86) }, uAlpha: { value: 0.34 }, uTime: this.uTime };
    this.arcU = { uColor: { value: new THREE.Vector3(1, 0.72, 0.35) }, uAlpha: { value: 0.9 }, uTime: this.uTime };
    this.arcPartU = { uColor: { value: new THREE.Vector3(1, 0.72, 0.35) }, uAlpha: { value: 0.32 }, uTime: this.uTime };
    this.buildDial();
    this.arcDone = new THREE.Mesh(new THREE.BufferGeometry(), this.flatMat(this.arcU, true));
    this.arcPart = new THREE.Mesh(new THREE.BufferGeometry(), this.flatMat(this.arcPartU, true));
    this.dialGroup.add(this.arcDone, this.arcPart, this.nowMark);
    this.scene.add(this.dialGroup);

    // 星座
    this.conU = { uPx: { value: 1 }, uTime: this.uTime, uTwinkle: { value: 0 } };
    this.conPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({ vertexShader: G.STARS_VERT, fragmentShader: G.STARS_FRAG, uniforms: this.conU, ...ADD }),
    );
    this.conLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      this.flatMat({ uColor: { value: new THREE.Vector3(0.95, 0.9, 0.78) }, uAlpha: { value: 0.3 }, uTime: this.uTime }, false),
    );
    this.conPoints.frustumCulled = false;
    this.conLines.frustumCulled = false;
    this.skyGroup.add(this.conPoints, this.conLines);

    this.sparkTex = this.makeSparkTexture();
    this.buildTimerMoon();

    this.bindPointer();
    this.resize();
    this.snapCamera();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ── 對外 ────────────────────────────────────────────────

  sync(state: AppState, now: number, day?: string): void {
    this.state = state;
    const todayKey = dayKey(now);
    const viewDay = day ?? todayKey;
    this.isToday = viewDay === todayKey;
    this.viewRef = this.isToday ? null : dayNoon(viewDay);
    this.selected = state.selected;
    this.reduced =
      state.settings.motion === 'reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const low = state.settings.quality === 'low';
    if (low !== this.lowQuality) {
      this.lowQuality = low;
      this.resize();
    }

    const act = tasksForDay(state, viewDay, todayKey);
    const ids = new Set(act.map((t) => t.id));
    act.forEach((task, i) => {
      let p = this.planets.get(task.id);
      if (!p) {
        p = this.makePlanet(task, i, act.length);
        this.planets.set(task.id, p);
      }
      p.alive = true;
      p.targetRadius = orbitRadius(i, act.length);
      p.targetSize = planetRadius(task.est);
      p.ru.uBands!.value = Math.min(8, task.done);
      p.ring.visible = task.done > 0;
      p.ou.uDash!.value = task.done === 0 ? 1 : 0;
    });
    for (const p of this.planets.values()) if (!ids.has(p.id)) p.alive = false;

    this.moonOrbitU.uTicks!.value = Math.max(1, Math.min(60, Math.round(state.settings.focusMin)));
    const t = state.timer;
    const focusId = t.kind === 'run' && t.mode === 'focus' ? t.taskId : null;
    if (focusId !== this.focusId) {
      this.focusId = focusId;
      this.overviewOverride = false;
      this.focusAz = 0;
      this.focusEl = 0;
      this.focusReset = false;
    }

    // 已完成的待辦 → 星座
    const completed = state.tasks.filter((x) => x.completedAt !== null);
    const sig = completed.map((x) => x.id).join(',');
    if (sig !== this.completedSig) {
      this.completedSig = sig;
      const fresh: Task[] = [];
      if (this.seenCompleted === null) this.seenCompleted = new Set(completed.map((x) => x.id));
      else {
        for (const x of completed) {
          if (!this.seenCompleted.has(x.id)) {
            this.seenCompleted.add(x.id);
            fresh.push(x);
          }
        }
      }
      this.buildConstellations(completed, now, new Set(fresh.map((x) => x.id)));
      for (const x of fresh) this.launchSpark(x.id);
    }

    const ref = this.viewRef ?? now;
    const shown = focusSessionsOn(state.sessions, ref);
    const ssig = `${dayKey(ref)}:${shown.length}:${shown[shown.length - 1]?.id ?? ''}`;
    if (ssig !== this.sessionSig) {
      this.sessionSig = ssig;
      this.buildArcs(now);
    }
    this.busy = true;
  }

  /** 左側面板佔掉的寬度：場景整體右移，讓星系落在剩下的空間正中央 */
  setPanelWidth(px: number): void {
    if (px === this.panelShiftPx) return;
    this.panelShiftPx = px;
    this.fitOverview();
    this.busy = true;
  }

  /** 專注中按 Esc：在俯瞰與貼近之間切換 */
  toggleOverview(): boolean {
    this.overviewOverride = !this.overviewOverride;
    this.busy = true;
    return this.overviewOverride;
  }

  wake(): void {
    this.pointer.lastMs = performance.now();
  }

  /** 轉動星系。俯角夾在 11°–78°：再低會看成一條線，再高軌道會疊在一起 */
  rotateBy(dAz: number, dEl: number): void {
    if (this.focusBlend >= 0.5) return this.rotateFocusBy(dAz, dEl);
    this.resetting = false;
    this.azimuth += dAz;
    this.elev = Math.min(1.36, Math.max(0.2, this.elev + dEl));
    this.busy = true;
  }

  /** 回到預設視角，走比較近的那一邊轉回去 */
  /** 月亮軌道的樣式：0 細線、1 清透琉璃、2 細線加光暈 */
  setBangleStyle(style: number): void {
    this.bangleStyle = style;
    this.bangleLine.visible = style !== 1;
    this.bangleTube.visible = style === 1;
    this.bangleGlow.visible = style !== 0;
    this.bangleGlowU.uGlow!.value = style === 1 ? 0.7 : 1;
    this.busy = true;
  }

  /** 專注時繞著行星看：被行星擋住的月亮與亮段，轉一下就看得到 */
  rotateFocusBy(dAz: number, dEl: number): void {
    this.focusReset = false;
    this.focusAz += dAz;
    this.focusEl = Math.min(1.25, Math.max(-1.5, this.focusEl + dEl));
    this.busy = true;
  }

  resetView(): void {
    if (this.focusBlend >= 0.5) {
      this.focusAz = Math.atan2(Math.sin(this.focusAz), Math.cos(this.focusAz));
      this.focusReset = true;
      this.busy = true;
      return;
    }
    this.azimuth = Math.atan2(Math.sin(this.azimuth), Math.cos(this.azimuth));
    this.azVel = 0;
    this.resetting = true;
    this.busy = true;
  }

  perf(): PerfInfo {
    const r = this.renderer.info.render;
    return {
      fps: Math.round(this.fpsAvg),
      target: this.targetFps,
      dpr: this.renderer.getPixelRatio(),
      calls: r.calls,
      triangles: r.triangles,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }

  // ── 建構 ────────────────────────────────────────────────

  private flatMat(uniforms: Record<string, THREE.IUniform>, doubleSide: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: G.FLAT_VERT,
      fragmentShader: G.FLAT_FRAG,
      uniforms,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      ...OVER,
    });
  }

  private makeRefBasis() {
    const pos = new THREE.Vector3(0, Math.sin(ELEV), Math.cos(ELEV)).multiplyScalar(22);
    const fwd = new THREE.Vector3(0, -0.4, 0).sub(pos).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const tanV = Math.tan((FOV * Math.PI) / 360);
    return { fwd, right, up, tanH: tanV * (16 / 9), tanV };
  }

  /** 參考鏡頭下的畫面座標（-1..1）→ 天球上的位置 */
  private skyFromNdc(x: number, y: number): THREE.Vector3 {
    const b = this.refBasis;
    return new THREE.Vector3()
      .copy(b.fwd)
      .addScaledVector(b.right, x * b.tanH)
      .addScaledVector(b.up, y * b.tanV)
      .normalize()
      .multiplyScalar(SKY_R);
  }

  private bakeSky(): void {
    const rt = new THREE.WebGLCubeRenderTarget(512, { generateMipmaps: false });
    const bakeScene = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({ vertexShader: G.BODY_VERT, fragmentShader: G.SKY_FRAG, side: THREE.BackSide });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), mat);
    bakeScene.add(ball);
    const cube = new THREE.CubeCamera(1, 100, rt);
    cube.update(this.renderer, bakeScene);
    mat.dispose();
    ball.geometry.dispose();

    this.skyU.uSky!.value = rt.texture;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(600, 24, 12),
      new THREE.ShaderMaterial({
        vertexShader: G.BODY_VERT,
        fragmentShader: G.SKYBOX_FRAG,
        uniforms: this.skyU,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.skyGroup.add(sky);
  }

  private buildStars(): Record<string, THREE.IUniform> {
    const COUNT = 3600;
    const rnd = mulberry32(20261112);
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    const size = new Float32Array(COUNT);
    const phase = new Float32Array(COUNT);
    // 與星雲 shader 裡的銀河帶同一個法向量，星星才會沿著銀河變密
    const gn = new THREE.Vector3(0.45, 0.74, -0.5).normalize();
    const d = new THREE.Vector3();
    let i = 0;
    while (i < COUNT) {
      const z = rnd() * 2 - 1;
      const a = rnd() * TAU;
      const s = Math.sqrt(1 - z * z);
      d.set(s * Math.cos(a), z, s * Math.sin(a));
      const off = d.dot(gn);
      if (rnd() > 0.28 + 0.72 * Math.exp(-off * off * 9)) continue;
      pos.set([d.x * SKY_R, d.y * SKY_R, d.z * SKY_R], i * 3);
      // 星等分布：絕大多數很暗，少數亮星
      const m = Math.pow(rnd(), 5.5);
      size[i] = 1.9 + m * 4.4;
      const bright = 0.4 + m * 0.6;
      const temp = rnd();
      const r = temp < 0.25 ? 1.0 : temp < 0.8 ? 0.95 : 0.72;
      const g = temp < 0.25 ? 0.8 : temp < 0.8 ? 0.95 : 0.82;
      const b = temp < 0.25 ? 0.62 : temp < 0.8 ? 1.0 : 1.0;
      col.set([r * bright, g * bright, b * bright], i * 3);
      phase[i] = rnd() * 0.999;
      i++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    const u = { uPx: { value: 1 }, uTime: this.uTime, uTwinkle: { value: 0.6 } };
    const stars = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({ vertexShader: G.STARS_VERT, fragmentShader: G.STARS_FRAG, uniforms: u, ...ADD }),
    );
    stars.frustumCulled = false;
    this.skyGroup.add(stars);
    return u;
  }

  private dialPoint(frac: number, r: number, out: number[]): void {
    const th = frac * TAU;
    out.push(Math.sin(th) * r, 0, -Math.cos(th) * r);
  }

  private buildDial(): void {
    const v: number[] = [];
    for (let i = 0; i < 96; i++) {
      const f = i / 96;
      const len = i % 24 === 0 ? 0.62 : i % 4 === 0 ? 0.34 : 0.13;
      this.dialPoint(f, DIAL_R, v);
      this.dialPoint(f, DIAL_R + len, v);
    }
    for (let i = 0; i < 192; i++) {
      this.dialPoint(i / 192, DIAL_R, v);
      this.dialPoint((i + 1) / 192, DIAL_R, v);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    this.dialGroup.add(new THREE.LineSegments(geo, this.flatMat(this.dialU, false)));

    const m: number[] = [];
    this.dialPoint(0, DIAL_R - 0.55, m);
    this.dialPoint(0, DIAL_R + 0.75, m);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(m, 3));
    this.nowMark.add(
      new THREE.LineSegments(
        mg,
        this.flatMat({ uColor: { value: new THREE.Vector3(1, 0.96, 0.88) }, uAlpha: { value: 0.95 }, uTime: this.uTime }, false),
      ),
    );
  }

  private arcGeometry(spans: [number, number][]): THREE.BufferGeometry {
    const v: number[] = [];
    const r0 = DIAL_R - 0.3;
    const r1 = DIAL_R - 0.1;
    for (const [a, b] of spans) {
      const steps = Math.max(2, Math.ceil((b - a) * 384));
      for (let i = 0; i < steps; i++) {
        const f0 = a + ((b - a) * i) / steps;
        const f1 = a + ((b - a) * (i + 1)) / steps;
        const q: number[] = [];
        this.dialPoint(f0, r0, q);
        this.dialPoint(f0, r1, q);
        this.dialPoint(f1, r0, q);
        this.dialPoint(f1, r1, q);
        v.push(q[0]!, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!, q[6]!, q[7]!, q[8]!);
        v.push(q[6]!, q[7]!, q[8]!, q[3]!, q[4]!, q[5]!, q[9]!, q[10]!, q[11]!);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return geo;
  }

  /** 今天每一顆番茄在刻度盤上的弧；進行中的那一顆畫到現在為止 */
  private buildArcs(now: number): void {
    if (!this.state) return;
    const done: [number, number][] = [];
    const part: [number, number][] = [];
    const ref = this.viewRef ?? now;
    const key = dayKey(ref);
    for (const s of focusSessionsOn(this.state.sessions, ref)) {
      const a = dayFraction(s.start);
      const b = dayKey(s.end) === key ? dayFraction(s.end) : 1;
      (s.completed ? done : part).push([a, Math.max(b, a + 0.0015)]);
    }
    const t = this.state.timer;
    if (this.isToday && t.kind === 'run' && t.mode === 'focus' && dayKey(t.startedAt) === key) {
      part.push([dayFraction(t.startedAt), Math.max(dayFraction(now), dayFraction(t.startedAt) + 0.0015)]);
    }
    this.arcDone.geometry.dispose();
    this.arcPart.geometry.dispose();
    this.arcDone.geometry = this.arcGeometry(done);
    this.arcPart.geometry = this.arcGeometry(part);
  }

  private makePlanet(task: Task, index: number, count: number): PlanetView {
    const recipe = RECIPES[task.seed % RECIPES.length]!;
    const rnd = mulberry32(task.seed);
    const atmo = new THREE.Color(recipe.atmo);
    const shared = {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uPhaseDir: { value: new THREE.Vector3(1, 0, 0) },
      uLightMix: { value: 0 },
      uDim: { value: 0 },
      uHover: { value: 0 },
    };
    const u: Record<string, THREE.IUniform> = {
      ...shared,
      uTime: this.uTime,
      uA: { value: new THREE.Color(recipe.a) },
      uB: { value: new THREE.Color(recipe.b) },
      uC: { value: new THREE.Color(recipe.c) },
      uAtmo: { value: atmo },
      uType: { value: recipe.type },
      uSeed: { value: (task.seed % 1000) / 37 },
      uSpin: { value: rnd() * TAU },
      uOct: { value: 4 },
    };
    const body = new THREE.Mesh(
      this.sphereGeo,
      new THREE.ShaderMaterial({ vertexShader: G.BODY_VERT, fragmentShader: G.PLANET_FRAG, uniforms: u }),
    );
    const atmoMesh = new THREE.Mesh(
      this.sphereGeo,
      new THREE.ShaderMaterial({
        vertexShader: G.BODY_VERT,
        fragmentShader: G.ATMO_FRAG,
        uniforms: { ...shared, uAtmo: u.uAtmo! },
        side: THREE.BackSide,
        ...ADD,
      }),
    );
    atmoMesh.scale.setScalar(1.16);

    const ringColor = new THREE.Color(recipe.c).lerp(new THREE.Color(0xf2e6cf), 0.55);
    const ru: Record<string, THREE.IUniform> = {
      ...shared,
      uColor: { value: ringColor },
      uBands: { value: 0 },
      uInner: { value: 1.42 },
      uBandW: { value: 0.15 },
      uGap: { value: 0.075 },
      uCenter: { value: new THREE.Vector3() },
      uPlanetR: { value: 1 },
    };
    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.ShaderMaterial({
        vertexShader: G.RING_VERT,
        fragmentShader: G.RING_FRAG,
        uniforms: ru,
        side: THREE.DoubleSide,
        ...OVER,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;

    const tilt = new THREE.Group();
    tilt.rotation.set(0.28 + rnd() * 0.42, 0, (rnd() - 0.5) * 0.5);
    tilt.add(body, atmoMesh, ring);
    const group = new THREE.Group();
    group.add(tilt);
    this.scene.add(group);

    const color = atmo.clone();
    const ou: Record<string, THREE.IUniform> = {
      uRadius: { value: 1 },
      uCursor: this.uCursor,
      uPull: this.uPull,
      uColor: { value: color },
      uPlanetAngle: { value: 0 },
      uBase: { value: 0.1 },
      uDash: { value: 1 },
      uDim: shared.uDim,
      uFade: { value: 1 },
    };
    const orbit = new THREE.LineLoop(
      this.orbitGeo,
      new THREE.ShaderMaterial({ vertexShader: G.ORBIT_VERT, fragmentShader: G.ORBIT_FRAG, uniforms: ou, ...OVER }),
    );
    orbit.frustumCulled = false;
    this.scene.add(orbit);

    const target = orbitRadius(index, count);
    // 讓行星的位置跟著真實時間走：重新開啟頁面時不會全部回到同一個起點
    const epoch = (Date.now() / 1000) % 1e6;
    return {
      id: task.id,
      group,
      tilt,
      body,
      atmo: atmoMesh,
      ring,
      orbit,
      u,
      ou,
      ru,
      angle: (initialAngle(task.seed, index) + angularSpeed(target) * epoch) % TAU,
      // 新增時從外側螺旋進場
      radius: this.settled ? target + 6.5 : target,
      targetRadius: target,
      size: planetRadius(task.est),
      targetSize: planetRadius(task.est),
      appear: this.settled ? 0 : 1,
      alive: true,
      hover: 0,
      spinRate: 0.02 + rnd() * 0.035,
      color,
    };
  }

  private buildTimerMoon(): void {
    this.moonOrbitU = {
      uProgress: { value: 0 },
      uTicks: { value: 25 },
      uStart: { value: Math.PI / 2 },
      uDir: { value: -1 },
      uAlpha: { value: 0 },
      uTube: { value: 0.01 },
      uMoonGap: { value: 0.08 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    const orbit = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.01, 12, 256),
      new THREE.ShaderMaterial({
        vertexShader: G.BANGLE_VERT,
        fragmentShader: G.BANGLE_FRAG,
        uniforms: this.moonOrbitU,
        ...OVER,
      }),
    );
    const u = this.moonOrbitU;
    this.bangleGlowU = {
      uProgress: u.uProgress!,
      uStart: u.uStart!,
      uDir: u.uDir!,
      uAlpha: u.uAlpha!,
      uTube: { value: 0.03 },
      uGlow: { value: 1 },
      uMoonGap: u.uMoonGap!,
    };
    const glow = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.01, 8, 192),
      new THREE.ShaderMaterial({
        vertexShader: G.BANGLE_VERT,
        fragmentShader: G.BANGLE_GLOW_FRAG,
        uniforms: this.bangleGlowU,
        ...ADD,
      }),
    );
    glow.renderOrder = 1;
    orbit.renderOrder = 2;
    const line = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.12, 192, 1),
      new THREE.ShaderMaterial({
        vertexShader: G.RING_VERT,
        fragmentShader: G.MOON_ORBIT_FRAG,
        uniforms: {
          uProgress: u.uProgress!,
          uTicks: u.uTicks!,
          uStart: u.uStart!,
          uDir: u.uDir!,
          uAlpha: u.uAlpha!,
          uMoonGap: u.uMoonGap!,
          uColor: { value: new THREE.Vector3(1, 0.8, 0.5) },
        },
        side: THREE.DoubleSide,
        ...OVER,
      }),
    );
    line.renderOrder = 2;
    this.bangleTube = orbit;
    this.bangleGlow = glow;
    this.bangleLine = line;
    this.timerGroup.add(glow, line);
    this.setBangleStyle(this.bangleStyle);
    this.moonU = {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uPhaseDir: { value: new THREE.Vector3(1, 0, 0) },
      uLightMix: { value: 1 },
      uDim: { value: 0 },
      uHover: { value: 0 },
      uTime: this.uTime,
      uA: { value: new THREE.Color(0xb7b1a6) },
      uB: { value: new THREE.Color(0xe8e2d4) },
      uC: { value: new THREE.Color(0x6e6961) },
      uAtmo: { value: new THREE.Color(0x3a4252) },
      uType: { value: 0 },
      uSeed: { value: 3.3 },
      uSpin: { value: 0 },
      uOct: { value: 3 },
    };
    this.moon = new THREE.Mesh(
      this.sphereGeo,
      new THREE.ShaderMaterial({ vertexShader: G.BODY_VERT, fragmentShader: G.PLANET_FRAG, uniforms: this.moonU }),
    );
    // 與行星環同一個平面：月亮會繞到行星背後再出來
    this.timerGroup.rotation.x = -Math.PI / 2;
    this.timerGroup.add(orbit, this.moon);
    this.timerGroup.visible = false;
  }

  /** 月亮軌道的半徑（以行星半徑為單位）：排在最外一道行星環之外 */
  private timerRadius(p: PlanetView): number {
    const bands = p.ru.uBands!.value as number;
    return (bands > 0 ? 1.42 + bands * 0.225 : 1.3) + 0.45;
  }

  private updateTimerMoon(fp: PlanetView | undefined, prog: number): void {
    if (!fp || !fp.alive || this.focusBlend < 0.01) {
      if (this.timerGroup.parent) this.timerGroup.removeFromParent();
      this.timerGroup.visible = false;
      this.timerAnchored = false;
      return;
    }
    if (this.timerGroup.parent !== fp.tilt) fp.tilt.add(this.timerGroup);
    this.timerGroup.visible = true;
    const R = this.timerRadius(fp);
    this.timerGroup.scale.setScalar(R);
    // 起點定在鏡頭看過去的左前方，往行星正面走。鏡頭還在飛的時候持續校正，到位後固定
    // 重新開啟頁面或關閉動態時鏡頭是直接到位的，沒有「還在飛」的階段，所以另外記一個旗標
    if (!this.timerAnchored || this.focusBlend < 0.98) {
      this.timerGroup.updateWorldMatrix(true, false);
      const pos = new THREE.Vector3();
      const target = new THREE.Vector3();
      if (this.desiredCamera(pos, target)) {
        const P = fp.group.position;
        const view = target.clone().sub(pos).normalize();
        const right = new THREE.Vector3().crossVectors(view, new THREE.Vector3(0, 1, 0)).normalize();
        const o = this.timerGroup.worldToLocal(P.clone());
        const c = this.timerGroup.worldToLocal(pos.clone()).sub(o);
        const l = this.timerGroup.worldToLocal(P.clone().sub(right)).sub(o);
        const camA = Math.atan2(c.y, c.x);
        const leftA = Math.atan2(l.y, l.x);
        const dir = Math.sin(camA - leftA) >= 0 ? 1 : -1;
        this.moonOrbitU.uDir!.value = dir;
        // 起點離開橢圓的尖端約 50 度：尖端的段被透視壓得很短，開頭那幾分鐘會看不出在走
        this.moonOrbitU.uStart!.value = leftA + dir * 0.88;
        this.timerAnchored = true;
      }
    }
    // 角度的算法要和 shader 裡的進度一致
    const a = (this.moonOrbitU.uStart!.value as number) + (this.moonOrbitU.uDir!.value as number) * prog * TAU;
    this.moon.position.set(Math.cos(a), Math.sin(a), 0);
    this.moon.scale.setScalar((0.105 / R) * this.focusBlend + 1e-4);
    this.moonOrbitU.uProgress!.value = prog;
    this.moonOrbitU.uAlpha!.value = this.focusBlend;
    // 粗細以行星半徑為單位固定，不隨軌道半徑放大：本體約行星半徑的 1.4%，光暈約 7%
    // 月亮半徑是行星半徑的 10.5%；軌道在它前後各留半個月亮寬的空隙
    this.moonOrbitU.uMoonGap!.value = 0.16 / R;
    this.moonOrbitU.uTube!.value = 0.014 / R;
    this.bangleGlowU.uTube!.value = 0.07 / R;
    // 高光的光源跟著鏡頭走（右上前方），轉動視角時亮點會沿著鐲子滑動
    const m = this.camera.matrixWorld.elements;
    (this.moonOrbitU.uLightDir!.value as THREE.Vector3).set(
      m[0]! * 0.5 + m[4]! * 0.8 + m[8]! * 0.55,
      m[1]! * 0.5 + m[5]! * 0.8 + m[9]! * 0.55,
      m[2]! * 0.5 + m[6]! * 0.8 + m[10]! * 0.55,
    );
    (this.moonU.uSunDir!.value as THREE.Vector3).copy(fp.u.uSunDir!.value as THREE.Vector3);
    (this.moonU.uPhaseDir!.value as THREE.Vector3).copy(fp.u.uPhaseDir!.value as THREE.Vector3);
    this.moonU.uLightMix!.value = fp.u.uLightMix!.value;
  }

  private removePlanet(p: PlanetView): void {
    if (this.timerGroup.parent === p.tilt) this.timerGroup.removeFromParent();
    this.scene.remove(p.group, p.orbit);
    (p.body.material as THREE.Material).dispose();
    (p.atmo.material as THREE.Material).dispose();
    (p.ring.material as THREE.Material).dispose();
    (p.orbit.material as THREE.Material).dispose();
    this.planets.delete(p.id);
  }

  /** 已完成的待辦依完成日分組，每一天連成一個星座 */
  private buildConstellations(completed: Task[], now: number, fresh: Set<string>): void {
    const byDay = new Map<string, Task[]>();
    for (const t of completed) {
      const k = dayKey(t.completedAt!);
      const list = byDay.get(k);
      if (list) list.push(t);
      else byDay.set(k, [t]);
    }
    const days = [...byDay.keys()].sort().slice(-MAX_CONSTELLATIONS);
    const today = dayKey(now);
    const pos: number[] = [];
    const col: number[] = [];
    const size: number[] = [];
    const phase: number[] = [];
    const lines: number[] = [];
    const births: number[] = [];
    const placed: { x: number; y: number }[] = [];
    this.conAnchors = [];
    this.conStarLocal.clear();
    const birth = this.uTime.value + 1.25;

    for (const key of days) {
      const tasks = byDay.get(key)!.sort((p, q) => p.completedAt! - q.completedAt!);
      const rnd = mulberry32(hashString(key));
      // 兩塊留給星座的天區：畫面上緣中段、右側中段；避開彼此
      let ax = 0;
      let ay = 0;
      for (let tries = 0; tries < 24; tries++) {
        if (rnd() < 0.62) {
          ax = -0.5 + rnd() * 0.86;
          ay = 0.5 + rnd() * 0.13;
        } else {
          ax = 0.34 + rnd() * 0.26;
          ay = -0.8 + rnd() * 0.3;
        }
        if (placed.every((p) => Math.hypot(p.x - ax, (p.y - ay) * 0.6) > 0.2)) break;
      }
      placed.push({ x: ax, y: ay });
      const shape = constellation(hashString(key), tasks.length);
      const scale = tasks.length === 1 ? 0 : 0.07 + Math.min(0.04, tasks.length * 0.007);
      const isToday = key === today;
      let prev: THREE.Vector3 | null = null;
      tasks.forEach((t, i) => {
        const s = shape[i]!;
        const local = this.skyFromNdc(ax + (s.x - 0.5) * scale, ay + (s.y - 0.5) * scale * 1.2);
        this.conStarLocal.set(t.id, local);
        pos.push(local.x, local.y, local.z);
        const b = isToday ? 1 : 0.72;
        col.push(1.0 * b, 0.93 * b, 0.78 * b);
        size.push(3.4 + Math.min(3.2, Math.sqrt(t.done) * 1.1));
        const isFresh = fresh.has(t.id);
        phase.push(isFresh ? 1.001 + birth : -(0.2 + rnd() * 0.7));
        if (prev) {
          lines.push(prev.x, prev.y, prev.z, local.x, local.y, local.z);
          const lb = isFresh ? birth : 0;
          births.push(lb, lb);
        }
        prev = local;
      });
      this.conAnchors.push({ key, local: this.skyFromNdc(ax, ay) });
    }

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    pg.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    pg.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
    this.conPoints.geometry.dispose();
    this.conPoints.geometry = pg;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    lg.setAttribute('aBirth', new THREE.Float32BufferAttribute(births, 1));
    this.conLines.geometry.dispose();
    this.conLines.geometry = lg;
  }

  private makeSparkTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,250,235,1)');
    grad.addColorStop(0.25, 'rgba(255,225,170,0.6)');
    grad.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  /** 做完的行星化成一點光，飛向它在星座裡的位置 */
  private launchSpark(taskId: string): void {
    const p = this.planets.get(taskId);
    const local = this.conStarLocal.get(taskId);
    if (!p || !local || this.reduced) return;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.sparkTex, depthTest: false, ...ADD }),
    );
    const from = p.group.position.clone();
    const ctrl = from.clone().add(new THREE.Vector3(0, 5, 0)).addScaledVector(local, 0.012);
    this.scene.add(sprite);
    this.sparks.push({ sprite, from, ctrl, local: local.clone(), t: 0 });
  }

  // ── 鏡頭 ────────────────────────────────────────────────

  /**
   * 俯瞰的取景：實際把刻度盤外緣投影到畫面上量測，二分搜尋出剛好放得進可用區域的距離，
   * 再算出要平移多少才會落在可用區域正中央。可用區域 = 視窗扣掉左側面板與上下的文字。
   */
  private fitOverview(): void {
    const wide = this.w > 860;
    const l = wide ? this.panelShiftPx + 20 : 10;
    const r = this.w - (wide ? 20 : 10);
    const t = wide ? 104 : 356;
    const b = this.h - (wide ? 104 : 128);
    const rw = Math.max(160, r - l);
    const rh = Math.max(140, b - t);
    const cam = this.fitCam;
    cam.aspect = this.w / this.h;
    cam.updateProjectionMatrix();
    const v = new THREE.Vector3();
    const box = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const measure = (dist: number) => {
      cam.position.set(0, Math.sin(this.elev) * dist, Math.cos(this.elev) * dist);
      cam.lookAt(0, -0.4, 0);
      cam.updateMatrixWorld();
      box.minX = box.minY = Infinity;
      box.maxX = box.maxY = -Infinity;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * TAU;
        v.set(Math.cos(a) * (DIAL_R + 1.7), 0, Math.sin(a) * (DIAL_R + 1.7)).project(cam);
        const x = (v.x * 0.5 + 0.5) * this.w;
        const y = (-v.y * 0.5 + 0.5) * this.h;
        box.minX = Math.min(box.minX, x);
        box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y);
        box.maxY = Math.max(box.maxY, y);
      }
      return box.maxX - box.minX <= rw && box.maxY - box.minY <= rh;
    };
    let lo = 12;
    let hi = 140;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (measure(mid)) hi = mid;
      else lo = mid;
    }
    measure(hi);
    this.overviewDist = hi;
    this.overviewShift.set((l + r) / 2 - (box.minX + box.maxX) / 2, (t + b) / 2 - (box.minY + box.maxY) / 2);
    this.fitElev = this.elev;
  }

  private desiredCamera(pos: THREE.Vector3, target: THREE.Vector3): boolean {
    const fp = this.focusId && !this.overviewOverride ? this.planets.get(this.focusId) : undefined;
    if (fp && fp.alive) {
      const P = fp.group.position;
      const radial = this.tmp.copy(P).setY(0).normalize();
      const tanV = Math.tan((FOV * Math.PI) / 360);
      const aspect = this.w / this.h;
      const reach = this.timerRadius(fp) + 0.3;
      // 行星偏在畫面右側，右邊只剩 36% 的寬度給月亮的軌道
      const need = aspect < 0.9 ? reach / (tanV * aspect) : reach / (0.72 * tanV * aspect);
      const dist = fp.size * Math.max(aspect < 0.9 ? 9.5 : 6.6, need);
      // 預設方位：行星前進方向的後方、略靠軌道內側
      const hx = -radial.x * 0.15 + radial.z * 0.9;
      const hz = -radial.z * 0.15 - radial.x * 0.9;
      const hl = Math.hypot(hx, hz);
      // 預設高度：固定在行星環平面上方約 28 度。
      // 環的傾角每顆行星不同，若只用世界座標的高度，有時會剛好把月亮的軌道看成一條線
      const n = this.tmp2.set(0, 1, 0).applyQuaternion(fp.tilt.quaternion);
      const along = (hx * n.x + hz * n.z) / hl;
      let cx = hx / hl - n.x * along;
      let cy = -n.y * along;
      let cz = hz / hl - n.z * along;
      const cl = Math.hypot(cx, cy, cz) || 1;
      const lift = 0.49;
      cx = (cx / cl) * Math.cos(lift) + n.x * Math.sin(lift);
      cy = (cy / cl) * Math.cos(lift) + n.y * Math.sin(lift);
      cz = (cz / cl) * Math.cos(lift) + n.z * Math.sin(lift);
      const r = dist * 0.94;
      const az = Math.atan2(cx, cz) + this.focusAz;
      // 俯仰夾在正負 75 度內，不翻過行星的兩極
      const el = Math.max(-1.3, Math.min(1.3, Math.asin(Math.max(-1, Math.min(1, cy))) + this.focusEl));
      const ce = Math.cos(el);
      pos.set(P.x + Math.sin(az) * ce * r, P.y + Math.sin(el) * r, P.z + Math.cos(az) * ce * r);
      target.copy(P);
      return true;
    }
    const ce = Math.cos(this.elev);
    pos
      .set(Math.sin(this.azimuth) * ce, Math.sin(this.elev), Math.cos(this.azimuth) * ce)
      .multiplyScalar(this.overviewDist);
    if (!this.reduced && !this.rotateLast) {
      // 游標視差沿著鏡頭的右方向走，星系轉到哪個角度手感都一樣
      pos.x += Math.cos(this.azimuth) * this.pointer.px * 0.9;
      pos.z -= Math.sin(this.azimuth) * this.pointer.px * 0.9;
      pos.y += this.pointer.py * 0.45;
    }
    target.set(0, -0.4, 0);
    return false;
  }

  private snapCamera(): void {
    this.desiredCamera(this.camPos, this.camTarget);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
  }

  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.w = w;
    this.h = h;
    const device = window.devicePixelRatio || 1;
    const top = this.lowQuality ? Math.min(device, 1) : Math.min(device, 1.5);
    this.dprLevels = [top, 1.25, 1, 0.8].filter((v, i) => i === 0 || v < top);
    this.dprIndex = Math.min(this.dprIndex, this.dprLevels.length - 1);
    this.applyDpr();
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.fitOverview();
    this.busy = true;
  };

  private applyDpr(): void {
    const dpr = this.dprLevels[this.dprIndex] ?? 1;
    this.renderer.setPixelRatio(dpr);
    this.starsU.uPx!.value = dpr;
    this.conU.uPx!.value = dpr;
  }

  // ── 指標 ────────────────────────────────────────────────

  private bindPointer(): void {
    const c = this.canvas;
    const setPos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      this.pointer.inside = true;
      this.pointer.moved = true;
      this.pointer.lastMs = performance.now();
    };
    c.addEventListener('pointermove', (e) => {
      setPos(e);
      const press = this.press;
      if (!press) return;
      if (!press.dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 7) {
        press.dragging = true;
        // 俯瞰：按在行星上拖曳是改優先度，按在空白處拖曳是轉動星系。專注：拖曳是繞著行星看
        if (!press.id) {
          this.rotateLast = { x: e.clientX, y: e.clientY, t: e.timeStamp, focus: this.focusBlend >= 0.5 };
          this.resetting = false;
          this.azVel = 0;
          c.style.cursor = 'grabbing';
        }
      }
      const last = this.rotateLast;
      if (last) {
        const dAz = -(e.clientX - last.x) * 0.0062;
        const dEl = (e.clientY - last.y) * 0.0045;
        const dtSec = Math.max(0.008, (e.timeStamp - last.t) / 1000);
        last.x = e.clientX;
        last.y = e.clientY;
        last.t = e.timeStamp;
        if (last.focus) {
          this.rotateFocusBy(dAz, dEl);
        } else {
          this.rotateBy(dAz, dEl);
          // 記下放手前的角速度，給慣性用
          this.azVel = this.azVel * 0.5 + (dAz / dtSec) * 0.5;
        }
      }
    });
    c.addEventListener('dblclick', () => {
      if (this.hovered === null) this.resetView();
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      setPos(e);
      this.pick();
      this.press = { id: this.focusBlend > 0.5 ? null : this.hovered, x: e.clientX, y: e.clientY, dragging: false };
      c.setPointerCapture(e.pointerId);
    });
    const release = (e: PointerEvent) => {
      const press = this.press;
      this.press = null;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (!press) return;
      if (this.rotateLast) {
        // 停住一下才放手就不滑行
        if (this.reduced || e.timeStamp - this.rotateLast.t > 90) this.azVel = 0;
        this.azVel = Math.max(-3, Math.min(3, this.azVel));
        this.rotateLast = null;
        c.style.cursor = '';
        return;
      }
      if (press.dragging && press.id) {
        const count = [...this.planets.values()].filter((p) => p.alive).length;
        this.hooks.onReorder(press.id, slotFromRadius(this.dragRadius, count));
      } else if (!press.dragging && this.focusBlend < 0.5) {
        this.hooks.onSelect(press.id);
      }
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', () => {
      this.press = null;
      this.rotateLast = null;
      this.azVel = 0;
      c.style.cursor = '';
    });
    c.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      if (this.hovered !== null) {
        this.hovered = null;
        this.hooks.onHover(null);
      }
      c.style.cursor = '';
    });
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.lastFrameMs = performance.now();
        this.busy = true;
      }
    });
  }

  /** 射線對球的解析判定，不建 BVH：最多十幾顆行星 */
  private pick(): void {
    this.ray.setFromCamera(new THREE.Vector2(this.pointer.x, this.pointer.y), this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    const worldPerPx = (2 * Math.tan((FOV * Math.PI) / 360)) / this.h;
    let best: string | null = null;
    let bestT = Infinity;
    if (this.focusBlend < 0.5 && !(this.press && this.press.dragging)) {
      for (const p of this.planets.values()) {
        if (!p.alive) continue;
        const oc = this.tmp.copy(p.group.position).sub(o);
        const t = oc.dot(d);
        if (t <= 0) continue;
        const miss2 = oc.lengthSq() - t * t;
        // 小行星也要點得到：判定半徑至少 18px
        const hit = Math.max(p.size * 1.25, worldPerPx * t * 18);
        if (miss2 < hit * hit && t < bestT) {
          bestT = t;
          best = p.id;
        }
      }
    }
    if (d.y < -1e-4) {
      const t = -o.y / d.y;
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      this.uCursor.value.set(x, z);
      this.dragRadius = Math.hypot(x, z);
    }
    if (!(this.press && this.press.dragging) && best !== this.hovered) {
      this.hovered = best;
      this.hooks.onHover(best);
      this.canvas.style.cursor = best ? 'pointer' : '';
    }
  }

  // ── 每一幀 ──────────────────────────────────────────────

  private pickInterval(nowMs: number, focusing: boolean): number {
    const active = this.busy || this.sparks.length > 0 || nowMs - this.pointer.lastMs < 2500 || this.press !== null;
    if (active) return 60;
    if (!document.hasFocus()) return 12;
    return focusing ? 20 : 30;
  }

  private loop = (nowMs: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const st = this.state;
    const focusing = st !== null && st.timer.kind === 'run' && st.timer.mode === 'focus' && st.timer.pausedAt === null;
    this.targetFps = this.pickInterval(nowMs, focusing);
    const since = nowMs - this.lastFrameMs;
    if (since < 1000 / this.targetFps - 3) return;
    const rawDt = Math.min(3600, since / 1000);
    const dt = Math.min(0.1, rawDt);
    this.lastFrameMs = nowMs;
    this.fpsAvg = ease(this.fpsAvg, 1000 / Math.max(1, since), 2, dt);
    this.govern(since);
    this.update(dt, rawDt, focusing);
    this.renderer.render(this.scene, this.camera);
  };

  /** 在 60fps 檔位連續掉幀就降一級解析度；不往回升，避免來回抖動 */
  private govern(sinceMs: number): void {
    if (this.targetFps !== 60 || !this.settled) return;
    this.slowFrames = sinceMs > 26 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 2);
    if (this.slowFrames > 50 && this.dprIndex < this.dprLevels.length - 1) {
      this.dprIndex++;
      this.slowFrames = 0;
      this.applyDpr();
      this.renderer.setSize(this.w, this.h, false);
    }
  }

  private update(dt: number, rawDt: number, focusing: boolean): void {
    const st = this.state;
    const now = Date.now();
    this.uTime.value += dt;
    const snap = this.reduced || !this.settled;
    const rate = (r: number) => (snap ? 1e3 : r);
    let busy = false;

    if (this.pointer.moved || this.press) {
      this.pointer.moved = false;
      this.pick();
    }
    const tpx = this.pointer.inside ? this.pointer.x : 0;
    const tpy = this.pointer.inside ? this.pointer.y : 0;
    this.pointer.px = ease(this.pointer.px, tpx, 2.2, dt);
    this.pointer.py = ease(this.pointer.py, tpy, 2.2, dt);
    const pullTarget =
      this.pointer.inside && this.focusBlend < 0.3 && !this.reduced && performance.now() - this.pointer.lastMs < 4000
        ? 0.17
        : 0;
    this.uPull.value = ease(this.uPull.value, pullTarget, 3, dt);

    // 計時器在場景裡的樣子
    const timer = st?.timer;
    const running = timer?.kind === 'run';
    const prog = st ? progress(st.timer, now) : 0;
    const onBreak = running && timer.mode !== 'focus';
    const arcT = (running ? (timer.pausedAt !== null ? 0.45 : 1) : 0) * (1 - this.focusBlend);
    this.coronaU.uArc!.value = ease(this.coronaU.uArc!.value, arcT, 4, dt);
    this.coronaU.uProgress!.value = prog;
    const arcCol = this.coronaU.uArcColor!.value as THREE.Vector3;
    arcCol.lerp(onBreak ? this.tmp.set(0.45, 0.86, 0.8) : this.tmp.set(1, 0.72, 0.35), 1 - Math.exp(-4 * dt));
    const gain = onBreak ? 0.7 : 1;
    this.sunU.uGain!.value = ease(this.sunU.uGain!.value, gain, 2, dt);
    // 專注時太陽也退場：視窗再寬、行星再靠內圈，畫面裡都只有那一顆行星
    this.coronaU.uGain!.value = this.sunU.uGain!.value * (1 - this.focusBlend);
    this.sun.scale.setScalar(Math.max(1e-4, SUN_RADIUS * (1 - this.focusBlend)));

    const wantFocus = this.focusId !== null && !this.overviewOverride && this.planets.get(this.focusId)?.alive === true;
    this.focusBlend = ease(this.focusBlend, wantFocus ? 1 : 0, rate(2.6), dt);
    if (Math.abs(this.focusBlend - (wantFocus ? 1 : 0)) > 0.004) busy = true;

    // 專注時整個星系放慢、星星不閃：畫面只剩時間在走
    const speed = this.reduced ? 0.15 : focusing ? 0.3 : 1;
    this.starsU.uTwinkle!.value = ease(this.starsU.uTwinkle!.value, focusing || this.reduced ? 0 : 0.6, 2, dt);
    const dialAlpha = 1 - this.focusBlend * 0.9;
    this.dialU.uAlpha!.value = 0.34 * dialAlpha;
    this.arcU.uAlpha!.value = 0.9 * dialAlpha;
    this.arcPartU.uAlpha!.value = 0.32 * dialAlpha;
    this.nowMark.visible = dialAlpha > 0.2 && this.isToday;

    const minute = Math.floor(now / 60_000);
    if (minute !== this.lastMinute) {
      this.lastMinute = minute;
      this.nowMark.rotation.y = -dayFraction(now) * TAU;
      this.buildArcs(now);
    }

    // 行星
    const orbitHold = this.focusId !== null ? 1 - this.focusBlend : 1;
    const dragging = this.press?.dragging ? this.press.id : null;
    for (const p of this.planets.values()) {
      const isFocus = p.id === this.focusId;
      const targetR = p.id === dragging ? Math.max(1.9, Math.min(DIAL_R - 0.7, this.dragRadius)) : p.targetRadius;
      p.radius = ease(p.radius, targetR, rate(p.id === dragging ? 14 : 3.2), dt);
      p.size = ease(p.size, p.targetSize, rate(6), dt);
      p.appear = ease(p.appear, p.alive ? 1 : 0, rate(p.alive ? 3.5 : 5), dt);
      if (!p.alive && p.appear < 0.02) {
        this.removePlanet(p);
        continue;
      }
      if (Math.abs(p.radius - targetR) > 0.01 || Math.abs(p.appear - (p.alive ? 1 : 0)) > 0.01) busy = true;
      p.angle = (p.angle + angularSpeed(p.radius) * rawDt * speed * orbitHold) % TAU;
      const hoverT = p.id === this.hovered || p.id === this.selected || p.id === dragging ? 1 : 0;
      p.hover = ease(p.hover, hoverT, 9, dt);
      if (Math.abs(p.hover - hoverT) > 0.01) busy = true;

      const x = Math.cos(p.angle) * p.radius;
      const z = Math.sin(p.angle) * p.radius;
      p.group.position.set(x, 0, z);
      // 專注時其他行星整顆退場，畫面只留下正在做的那一顆
      const recede = this.focusId !== null && !isFocus ? 1 - this.focusBlend : 1;
      const s = Math.max(1e-4, p.size * p.appear * recede * (1 + p.hover * 0.07));
      p.group.scale.setScalar(s);
      (p.u.uSunDir!.value as THREE.Vector3).set(-x, 0, -z).normalize();
      const idleSpin = p.spinRate * speed;
      const spin = isFocus ? idleSpin * (1 - this.focusBlend) + (focusing ? TAU / 60 : 0) * this.focusBlend : idleSpin;
      p.u.uSpin!.value = (p.u.uSpin!.value + spin * rawDt) % TAU;
      p.u.uHover!.value = p.hover;
      const dimT = this.focusId !== null && !isFocus ? this.focusBlend : 0;
      p.u.uDim!.value = ease(p.u.uDim!.value, dimT, rate(4), dt);
      p.u.uLightMix!.value = isFocus ? this.focusBlend : ease(p.u.uLightMix!.value, 0, rate(4), dt);
      p.u.uOct!.value = this.lowQuality ? 3 : isFocus && this.focusBlend > 0.3 ? 5 : 4;
      p.atmo.visible = !this.lowQuality;
      (p.ru.uCenter!.value as THREE.Vector3).set(x, 0, z);
      p.ru.uPlanetR!.value = s;
      p.ou.uRadius!.value = p.radius;
      p.ou.uPlanetAngle!.value = p.angle;
      p.ou.uBase!.value = (0.1 + p.hover * 0.3) * p.appear;
      p.ou.uFade!.value = isFocus ? 1 - this.focusBlend : 1;
    }

    // 轉動星系：放手後的慣性、回到預設視角、俯角變了就重新取景
    if (!this.rotateLast && Math.abs(this.azVel) > 0.004) {
      this.azimuth += this.azVel * dt;
      this.azVel *= Math.exp(-3.4 * dt);
      busy = true;
    }
    if (this.resetting) {
      this.azimuth = ease(this.azimuth, 0, rate(5), dt);
      this.elev = ease(this.elev, ELEV, rate(5), dt);
      if (Math.abs(this.azimuth) < 0.002 && Math.abs(this.elev - ELEV) < 0.002) {
        this.azimuth = 0;
        this.elev = ELEV;
        this.resetting = false;
      }
      busy = true;
    }
    if (this.focusReset) {
      this.focusAz = ease(this.focusAz, 0, rate(5), dt);
      this.focusEl = ease(this.focusEl, 0, rate(5), dt);
      if (Math.abs(this.focusAz) < 0.002 && Math.abs(this.focusEl) < 0.002) {
        this.focusAz = 0;
        this.focusEl = 0;
        this.focusReset = false;
      }
      busy = true;
    }
    if (Math.abs(this.elev - this.fitElev) > 0.004) this.fitOverview();

    // 鏡頭
    const desiredPos = this.tmp2.clone();
    const desiredTarget = new THREE.Vector3();
    const inFocus = this.desiredCamera(desiredPos, desiredTarget);
    // 拖曳中鏡頭要緊跟著手，放手後才回到柔和的跟隨
    const camRate = rate(this.rotateLast ? 18 : inFocus ? 2.4 : 2.8);
    this.camPos.set(
      ease(this.camPos.x, desiredPos.x, camRate, dt),
      ease(this.camPos.y, desiredPos.y, camRate, dt),
      ease(this.camPos.z, desiredPos.z, camRate, dt),
    );
    this.camTarget.set(
      ease(this.camTarget.x, desiredTarget.x, camRate, dt),
      ease(this.camTarget.y, desiredTarget.y, camRate, dt),
      ease(this.camTarget.z, desiredTarget.z, camRate, dt),
    );
    if (this.camPos.distanceTo(desiredPos) > 0.03) busy = true;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

    // 俯瞰時把星系移到面板以外的空間；專注時把行星放在畫面右側，左邊留給時間
    const narrow = this.w <= 860;
    const sx = inFocus ? (narrow ? 0 : this.w * 0.14) : this.overviewShift.x;
    const sy = inFocus ? (narrow ? -this.h * 0.14 : 0) : this.overviewShift.y;
    this.viewShift.set(ease(this.viewShift.x, sx, rate(3), dt), ease(this.viewShift.y, sy, rate(3), dt));
    this.camera.setViewOffset(this.w, this.h, -this.viewShift.x, -this.viewShift.y, this.w, this.h);
    this.camera.updateMatrixWorld();

    // 專注中的行星：光從背後繞到正面，晨昏線掃過一圈就是一顆番茄
    const fp = this.focusId ? this.planets.get(this.focusId) : undefined;
    if (fp) {
      const toCam = this.tmp.copy(this.camera.position).sub(fp.group.position).normalize();
      const e = this.camera.matrixWorld.elements;
      const side = this.tmp2.set(e[0]! * 0.94 + e[4]! * 0.34, e[1]! * 0.94 + e[5]! * 0.34, e[2]! * 0.94 + e[6]! * 0.34).normalize();
      const phi = Math.PI * 0.8 * (1 - prog) + 0.02;
      (fp.u.uPhaseDir!.value as THREE.Vector3)
        .copy(toCam)
        .multiplyScalar(Math.cos(phi))
        .addScaledVector(side, Math.sin(phi))
        .normalize();
    }

    this.updateTimerMoon(fp, prog);

    this.skyGroup.position.copy(this.camera.position);
    this.corona.quaternion.copy(this.camera.quaternion);

    // 飛向星座的光點
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]!;
      s.t += dt / 1.25;
      const t = Math.min(1, s.t);
      const k = t * t * (3 - 2 * t);
      const to = this.tmp.copy(this.camera.position).add(s.local);
      const a = (1 - k) * (1 - k);
      const b = 2 * (1 - k) * k;
      const c = k * k;
      s.sprite.position.set(
        s.from.x * a + s.ctrl.x * b + to.x * c,
        s.from.y * a + s.ctrl.y * b + to.y * c,
        s.from.z * a + s.ctrl.z * b + to.z * c,
      );
      const dist = s.sprite.position.distanceTo(this.camera.position);
      s.sprite.scale.setScalar(dist * 0.03 * (1 - 0.65 * k));
      if (s.t >= 1) {
        this.scene.remove(s.sprite);
        s.sprite.material.dispose();
        this.sparks.splice(i, 1);
      }
    }

    this.report();
    this.busy = busy;
    this.settled = true;
  }

  /** 把 3D 位置投影成畫面座標，交給 DOM 標籤 */
  private report(): void {
    const info = this.info;
    info.w = this.w;
    info.h = this.h;
    info.focusBlend = this.focusBlend;
    info.planets.length = 0;
    info.hours.length = 0;
    info.sky.length = 0;
    const worldPerPx = (2 * Math.tan((FOV * Math.PI) / 360)) / this.h;
    const v = this.tmp;
    v.set(0, 0, 0).project(this.camera);
    info.sunX = (v.x * 0.5 + 0.5) * this.w;
    for (const p of this.planets.values()) {
      v.copy(p.group.position);
      const dist = v.distanceTo(this.camera.position);
      v.project(this.camera);
      if (v.z > 1) continue;
      info.planets.push({
        id: p.id,
        x: (v.x * 0.5 + 0.5) * this.w,
        y: (-v.y * 0.5 + 0.5) * this.h,
        r: ((p.size * p.appear) / (worldPerPx * dist)) * (p.ring.visible ? 1.42 + (p.ru.uBands!.value as number) * 0.225 : 1),
        alpha: p.alive ? p.appear * (1 - this.focusBlend) : 0,
      });
    }
    const hourAlpha = 1 - this.focusBlend;
    if (hourAlpha > 0.05) {
      for (const h of [0, 6, 12, 18]) {
        const th = (h / 24) * TAU;
        v.set(Math.sin(th) * (DIAL_R + 1.25), 0, -Math.cos(th) * (DIAL_R + 1.25)).project(this.camera);
        info.hours.push({ h, x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h, alpha: hourAlpha });
      }
      for (const a of this.conAnchors) {
        v.copy(this.camera.position).add(a.local).project(this.camera);
        if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
        info.sky.push({ key: a.key, x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h });
      }
    }
    this.hooks.onFrame(info);
  }
}
