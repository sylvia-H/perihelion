/** 可重現的亂數：同一個待辦每次開啟都長同一顆行星。 */

export function hashString(s: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let counter = 0;
/** 不依賴 crypto.randomUUID（file:// 下不保證有） */
export function newId(now: number = Date.now()): string {
  counter = (counter + 1) % 1296;
  const rand = Math.floor(Math.random() * 46656);
  return `${now.toString(36)}${counter.toString(36).padStart(2, '0')}${rand.toString(36).padStart(3, '0')}`;
}
