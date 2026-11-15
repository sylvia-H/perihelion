/**
 * 軌道幾何。同一組函式同時決定：行星畫在哪、點擊判到誰、標籤放哪、拖曳放開後落在第幾圈。
 * 單位是場景單位，太陽在原點，軌道躺在 XZ 平面。
 */

export const SUN_RADIUS = 1.15;
export const INNER_ORBIT = 2.7;
export const OUTER_ORBIT = 9.2;
const MAX_GAP = 1.55;

/** 第 index 圈（0 最靠近太陽）的半徑；待辦多的時候圈距自動收緊 */
export function orbitRadius(index: number, count: number): number {
  if (count <= 1) return INNER_ORBIT + 0.9;
  const gap = Math.min(MAX_GAP, (OUTER_ORBIT - INNER_ORBIT) / (count - 1));
  return INNER_ORBIT + gap * index;
}

/** 拖曳時：場景裡的半徑對應到第幾圈 */
export function slotFromRadius(r: number, count: number): number {
  if (count <= 1) return 0;
  const gap = Math.min(MAX_GAP, (OUTER_ORBIT - INNER_ORBIT) / (count - 1));
  return Math.min(count - 1, Math.max(0, Math.round((r - INNER_ORBIT) / gap)));
}

/**
 * 克卜勒第三定律：週期平方正比於半徑立方，所以角速度正比於 r^-1.5。
 * 最內圈約 150 秒繞一圈，外圈慢很多；整個畫面的動態因此很安靜。
 */
export function angularSpeed(r: number): number {
  const innerPeriod = 150;
  return ((2 * Math.PI) / innerPeriod) * Math.pow(INNER_ORBIT / r, 1.5);
}

/** 預估番茄數決定行星大小；用平方根，12 顆的不會大到蓋住鄰居 */
export function planetRadius(est: number): number {
  return 0.34 + 0.13 * Math.sqrt(Math.max(1, est));
}

/** 起始角度由種子決定，用黃金角打散，相鄰的待辦不會擠在同一側 */
export function initialAngle(seed: number, index: number): number {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return ((seed % 628) / 100 + index * golden) % (2 * Math.PI);
}

export interface Point2 {
  x: number;
  y: number;
}

/**
 * 一天的星座：n 顆星在單位方格裡的位置，由日期決定、每次算都一樣。
 * 做法是沿一條有方向的折線走，每一步轉一個受限的角度，看起來像星座而不是亂點。
 */
export function constellation(seed: number, n: number): Point2[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts: Point2[] = [];
  let x = 0;
  let y = 0;
  let dir = rnd() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    pts.push({ x, y });
    dir += (rnd() - 0.5) * 1.9;
    const step = 0.55 + rnd() * 0.6;
    x += Math.cos(dir) * step;
    y += Math.sin(dir) * step;
  }
  // 正規化到 0–1，保持長寬比
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const offX = (1 - (maxX - minX) / span) / 2;
  const offY = (1 - (maxY - minY) / span) / 2;
  return pts.map((p) => ({ x: (p.x - minX) / span + offX, y: (p.y - minY) / span + offY }));
}
