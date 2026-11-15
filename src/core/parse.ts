/** 快速新增的語法：「讀教材 D ×2」「!回信」 */
import { clampEst } from './model.ts';

export interface QuickAdd {
  title: string;
  est: number;
  /** 開頭或結尾有驚嘆號：直接排進最內圈 */
  urgent: boolean;
}

// 結尾的「×3」「x3」「*3」「＊3」，前面要有空白或直接接在中文後面；
// 用 \d{1,2} 避免把「iPhone x15000」這類標題吃掉。
const EST_RE = /(?:^|\s|(?<=[^\x00-\x7F]))[×xX*＊]\s*(\d{1,2})\s*$/u;
const BANG_HEAD = /^\s*[!！]+\s*/u;
const BANG_TAIL = /\s*[!！]+\s*$/u;

export function parseQuickAdd(input: string): QuickAdd | null {
  let text = input.normalize('NFC').trim();
  if (!text) return null;

  let urgent = false;
  if (BANG_HEAD.test(text)) {
    urgent = true;
    text = text.replace(BANG_HEAD, '');
  }

  // 驚嘆號可能寫在 ×n 的後面（「回信 ×2！」），所以取預估數之前先收一次
  if (BANG_TAIL.test(text)) {
    urgent = true;
    text = text.replace(BANG_TAIL, '');
  }

  let est = 1;
  const m = EST_RE.exec(text);
  if (m) {
    est = clampEst(Number(m[1]));
    text = text.slice(0, m.index).trim();
  }

  if (BANG_TAIL.test(text)) {
    urgent = true;
    text = text.replace(BANG_TAIL, '');
  }

  text = text.replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  // 標題太長會撐破標籤；一個字元一個字元截，不切斷代理對
  const chars = Array.from(text);
  const title = chars.length > 60 ? chars.slice(0, 60).join('') : text;
  return { title, est, urgent };
}
