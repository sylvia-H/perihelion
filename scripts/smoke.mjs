// 互動冒煙測試：用真的滑鼠與鍵盤事件（Chrome DevTools Protocol）操作建置好的 dist/index.html。
// 先 npm run build，再 npm run smoke。Chrome 不在預設位置時用環境變數 CHROME 指定。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SP = path.join(os.tmpdir(), 'perihelion-smoke').split(path.sep).join("/");
fs.mkdirSync(SP + '/shots', { recursive: true });
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.html');
const URL_ = pathToFileURL(dist).href + '?demo=overview';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-extensions', '--no-first-run', `--user-data-dir=${SP}/chrome-cdp`,
  `--remote-debugging-port=${PORT}`, '--window-size=1440,900', '--hide-scrollbars', URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
    } catch {}
  }
  if (!target) throw new Error('找不到頁面');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg.error); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse', ...extra });
  const dragTo = async (x0, y0, x1, y1, steps = 14) => {
    await mouse('mouseMoved', x0, y0, { buttons: 0 });
    await mouse('mousePressed', x0, y0);
    for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await sleep(16); }
    await mouse('mouseReleased', x1, y1);
    await sleep(120);
  };
  const key = async (k, code, vk, mods = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, text: k === 'Enter' ? '\r' : k.length === 1 ? k : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
    await sleep(120);
  };
  await send('Runtime.enable');
  await sleep(2500);

  const order = () => ev(`[...document.querySelectorAll('#task-list .task-t')].map(e=>e.textContent)`);
  const rowY = (i) => ev(`(()=>{const r=document.querySelectorAll('#task-list .task-main')[${i}].getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2]})()`);
  const selected = () => ev(`document.querySelector('#task-list .task.selected .task-t')?.textContent ?? null`);
  const hours = () => ev(`[...document.querySelectorAll('.hlabel')].map(e=>e.textContent+'@'+e.style.transform.match(/translate3d\\(([-\\d.]+)px/)[1]).join(' ')`);

  // 1. 待辦列拖曳：把第 5 列拖到最上面
  const before = await order();
  const selBefore = await selected();
  const [x5, y5] = await rowY(4);
  const [, y1] = await rowY(0);
  await dragTo(x5, y5, x5, y1 - 8);
  const after = await order();
  check('清單拖曳：第 5 列拖到第 1 列', after[0] === before[4] && after.length === before.length, `${before[4]} 現在排第 ${after.indexOf(before[4]) + 1}`);
  check('清單拖曳：其餘順序不變', JSON.stringify(after.slice(1)) === JSON.stringify(before.filter((_, i) => i !== 4)));
  check('清單拖曳：放開不會誤觸選取', (await selected()) === selBefore, `選取仍是 ${selBefore}`);

  // 2. 往下拖一格
  const b2 = await order();
  const [xa, ya] = await rowY(0);
  const [, yb] = await rowY(1);
  await dragTo(xa, ya, xa, yb + 6);
  const a2 = await order();
  check('清單拖曳：第 1 列往下拖一格', a2[1] === b2[0] && a2[0] === b2[1], a2.slice(0, 2).join(' / '));

  // 3. 點一下仍然是選取
  const [xc, yc] = await rowY(4);
  await mouse('mouseMoved', xc, yc, { buttons: 0 });
  await mouse('mousePressed', xc, yc);
  await mouse('mouseReleased', xc, yc);
  await sleep(150);
  const a3 = await order();
  check('點一下是選取，不是拖曳', (await selected()) === a3[4], `選到 ${await selected()}`);

  // 4. 空白處拖曳：轉動星系
  const h0 = await hours();
  await dragTo(420, 720, 700, 720, 18);
  await sleep(900);
  const h1 = await hours();
  check('空白處拖曳：星系轉動', h0 !== h1, `刻度位置 ${h0}  →  ${h1}`);
  check('空白處拖曳：不會清掉選取', (await selected()) === a3[4]);
  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SP}/shots/after-drag.png`, Buffer.from(shot.data, 'base64'));

  // 5. 連點兩下回到預設視角
  await mouse('mousePressed', 420, 720, { clickCount: 2 });
  await mouse('mouseReleased', 420, 720, { clickCount: 2 });
  await sleep(2600);
  const h2 = await hours();
  const xs = (s) => [...s.matchAll(/@([-\d.]+)/g)].map((m) => Number(m[1]));
  const close = xs(h0).every((v, i) => Math.abs(v - xs(h2)[i]) < 14);
  check('連點兩下：回到預設視角', close, h2);

  // 5b. 月曆：點明天，排一件事進去，再回到今天
  const todayCount = (await order()).length;
  const click = async (sel) => {
    const [x, y] = await ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2]})()`);
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
    await sleep(200);
  };
  await click('#today-date');
  check('月曆：點日期會打開', (await ev(`document.getElementById('cal').hidden`)) === false);
  const tomorrow = await ev(`(()=>{const t=document.querySelector('.cal .day.is-today');const all=[...document.querySelectorAll('.cal .day')];const n=all[all.indexOf(t)+1];return n?n.dataset.day:null})()`);
  if (tomorrow) {
    await click(`.cal .day[data-day="${tomorrow}"]`);
    const planned = await order();
    check('月曆：點明天，清單換成明天排的', planned.length === 2 && (await ev(`document.getElementById('cal').hidden`)) === true, planned.join(' / '));
    check('月曆：看別天時主按鈕變成回到今天', (await ev(`document.getElementById('clock-actions').textContent`)).includes('回到今天'));
    await ev(`(()=>{const i=document.getElementById('cmd-input');i.focus();i.value='明天的新待辦 ×2';i.dispatchEvent(new Event('input'));})()`);
    await key('Enter', 'Enter', 13);
    await sleep(250);
    const planned2 = await order();
    check('月曆：在明天新增，會排進明天', planned2.length === 3 && planned2.includes('明天的新待辦'), planned2.join(' / '));
    await ev(`document.activeElement?.blur()`);
    await key('t', 'KeyT', 84);
    await sleep(250);
    const back = await order();
    check('月曆：按 T 回到今天，今天的清單沒有多出明天那件', back.length === todayCount && !back.includes('明天的新待辦'), `今天 ${back.length} 件`);
  } else {
    check('月曆：今天是月底，略過點明天的檢查', true);
  }

  // 6. 鍵盤：方向鍵轉動、Space 開始專注、暫停、Esc 俯瞰
  await key('ArrowLeft', 'ArrowLeft', 37);
  await sleep(700);
  check('← 鍵：星系轉動', (await hours()) !== h2);
  await ev(`document.activeElement?.blur()`);
  await key(' ', 'Space', 32);
  await sleep(600);
  check('Space：進入專注畫面', (await ev(`document.body.dataset.view`)) === 'focus', await ev(`document.getElementById('focus-title').textContent + ' ' + document.getElementById('focus-digits').textContent`));
  await sleep(1300);
  const d1 = await ev(`document.getElementById('focus-digits').textContent`);
  check('專注中：倒數有在走', d1 !== '25:00', d1);
  check('專注中：分頁標題顯示倒數', /^\d\d:\d\d/.test(await ev(`document.title`)), await ev(`document.title`));
  await key(' ', 'Space', 32);
  const p1 = await ev(`document.getElementById('focus-digits').textContent`);
  await sleep(1400);
  check('Space：暫停後不再走', (await ev(`document.getElementById('focus-digits').textContent`)) === p1, p1);
  await key('Escape', 'Escape', 27);
  check('Esc：專注中切回俯瞰', (await ev(`document.body.dataset.view`)) === 'overview');
  await sleep(1200);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SP}/shots/after-keys.png`, Buffer.from(shot2.data, 'base64'));

  // 7. 新增待辦
  await ev(`(()=>{const i=document.getElementById('cmd-input');i.focus();i.value='測試新增 ×3!';i.dispatchEvent(new Event('input'));})()`);
  const hint = await ev(`document.getElementById('cmd-hint').textContent`);
  await key('Enter', 'Enter', 13);
  await sleep(300);
  const a7 = await order();
  check('新增：×3 與 ! 生效', a7[0] === '測試新增' && a7.length === a3.length + 1, hint);

  check('整段操作沒有執行期錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));
  ws.close();
} catch (e) {
  results.push('ERROR  ' + (e?.stack ?? e));
} finally {
  chrome.kill();
  console.log(results.join('\n'));
}
