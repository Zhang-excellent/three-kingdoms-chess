import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'docs', '验收截图');
const origin = process.env.THREE_CHESS_BEAST_ACCEPTANCE_ORIGIN ?? 'http://127.0.0.1:5173';
const appUrl = `${origin}/?mode=beast-chess`;
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error('找不到可用的 Chrome 或 Edge。');

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const profileDir = await mkdtemp(join(tmpdir(), 'three-chess-beast-acceptance-'));
await mkdir(screenshotDir, { recursive: true });

class DevTools {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.runtimeErrors = [];
  }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.once('open', resolveOpen);
      this.socket.once('error', rejectOpen);
    });
    this.socket.on('message', data => {
      const message = JSON.parse(Buffer.from(data).toString('utf8'));
      if (message.method === 'Runtime.exceptionThrown')
        this.runtimeErrors.push(message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text
          ?? 'Runtime exception');
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket?.close(); }
}

async function launchChrome() {
  const child = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
    let stderr = '';
    const timer = setTimeout(() => rejectEndpoint(new Error('Chrome 启动超时')), 15_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveEndpoint(match[1]);
    });
  });
  const devtools = new DevTools(endpoint);
  await devtools.connect();
  return { child, devtools };
}

async function createPage(devtools, url, size) {
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  await Promise.all([
    devtools.send('Page.enable', {}, sessionId),
    devtools.send('Runtime.enable', {}, sessionId),
  ]);
  const page = { targetId, sessionId, size: { ...size } };
  await setViewport(devtools, page, size);
  await devtools.send('Page.navigate', { url }, sessionId);
  return page;
}

async function setViewport(devtools, page, size) {
  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile ?? false,
  }, page.sessionId);
  page.size = { ...size };
}

async function evaluate(devtools, page, expression) {
  const response = await devtools.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, page.sessionId);
  if (response.exceptionDetails)
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(devtools, page, expression, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(devtools, page, expression)) return;
    } catch { /* Navigation may still be in progress. */ }
    await delay(80);
  }
  throw new Error(`等待“${label}”超时。`);
}

async function elementRect(devtools, page, selector) {
  return evaluate(devtools, page, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  })()`);
}

async function buttonRect(devtools, page, text) {
  return evaluate(devtools, page, `(() => {
    const element = [...document.querySelectorAll('button')]
      .find(button => button.textContent.trim() === ${JSON.stringify(text)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  })()`);
}

async function clickBox(devtools, page, box, label) {
  if (!box?.width || !box?.height) throw new Error(`找不到可点击的“${label}”。`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  }, page.sessionId);
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  }, page.sessionId);
  await delay(80);
}

async function clickSelector(devtools, page, selector, label = selector) {
  await clickBox(devtools, page, await elementRect(devtools, page, selector), label);
}

async function clickButton(devtools, page, text) {
  await clickBox(devtools, page, await buttonRect(devtools, page, text), text);
}

async function screenshot(devtools, page, fileName) {
  const metrics = await devtools.send('Page.getLayoutMetrics', {}, page.sessionId);
  const content = metrics.cssContentSize ?? metrics.contentSize;
  const clip = {
    x: 0, y: 0, width: page.size.width,
    height: Math.min(1800, Math.max(page.size.height, Math.ceil(content.height))),
    scale: 1,
  };
  const result = await devtools.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true, clip,
  }, page.sessionId);
  const target = join(screenshotDir, fileName);
  await writeFile(target, Buffer.from(result.data, 'base64'));
  return target;
}

const { child, devtools } = await launchChrome();
try {
  const page = await createPage(devtools, `${origin}/`, { width: 1366, height: 768 });
  await waitFor(devtools, page, `!!document.querySelector('.home-page')`, '首页');
  await evaluate(devtools, page, `(() => {
    const card = [...document.querySelectorAll('.home-action-card')]
      .find(item => item.querySelector('strong')?.textContent.trim() === '其他玩法');
    card?.click();
  })()`);
  await waitFor(devtools, page, `!!document.querySelector('.other-games-page')`, '其他玩法页');
  await waitFor(devtools, page, `document.querySelector('.beast-entry strong')?.textContent.trim() === '斗兽棋'`, '斗兽棋入口');
  await clickSelector(devtools, page, '.beast-entry', '斗兽棋入口');
  await waitFor(devtools, page, `!!document.querySelector('.beast-page')`, '斗兽棋页面');
  await waitFor(devtools, page, `[...document.querySelectorAll('.beast-piece img')].length === 16
    && [...document.querySelectorAll('.beast-piece img')].every(img => img.complete && img.naturalWidth > 0)`, '斗兽棋原图棋子加载');
  await waitFor(devtools, page, `document.querySelector('.beast-board-image')?.complete
    && document.querySelector('.beast-board-image')?.naturalWidth > 0`, '斗兽棋原图棋盘加载');

  const desktopInitial = await evaluate(devtools, page, `(() => {
    const board = document.querySelector('.beast-board-frame').getBoundingClientRect();
    const grid = document.querySelector('.beast-board-grid').getBoundingClientRect();
    const cells = [...document.querySelectorAll('.beast-cell')].map(cell => cell.getBoundingClientRect());
    return {
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      board: { width: Math.round(board.width), height: Math.round(board.height) },
      grid: { left: Math.round(grid.left - board.left), top: Math.round(grid.top - board.top), width: Math.round(grid.width), height: Math.round(grid.height) },
      cells: cells.length,
      pieces: document.querySelectorAll('.beast-piece img').length,
      title: document.querySelector('.beast-heading h1')?.textContent.trim(),
      turn: document.querySelector('.beast-turn')?.textContent.trim(),
      centerCell: (() => {
        const cell = document.querySelector('.beast-cell[data-coordinate="D5"]').getBoundingClientRect();
        return { x: Math.round(cell.x + cell.width / 2), y: Math.round(cell.y + cell.height / 2) };
      })(),
    };
  })()`);
  if (desktopInitial.scrollWidth > desktopInitial.clientWidth + 1)
    throw new Error(`桌面斗兽棋横向溢出：${JSON.stringify(desktopInitial)}`);
  if (desktopInitial.cells !== 63 || desktopInitial.pieces !== 16) throw new Error('斗兽棋初始棋盘数量不正确。');
  if (desktopInitial.title !== '斗兽棋' || !desktopInitial.turn.includes('下方')) throw new Error('斗兽棋标题或先手状态不正确。');
  if (Math.abs(desktopInitial.board.width - desktopInitial.board.height) > 1) throw new Error('斗兽棋棋盘不是正方形。');
  const desktopInitialShot = await screenshot(devtools, page, '斗兽棋-桌面-初始.png');

  await clickSelector(devtools, page, '.beast-cell[data-coordinate="A1"]', 'A1 虎');
  await waitFor(devtools, page, `document.querySelector('.beast-cell[data-coordinate="A1"]').classList.contains('selected')
    && document.querySelectorAll('.beast-cell.target').length === 2`, 'A1 合法落点');
  await clickSelector(devtools, page, '.beast-cell[data-coordinate="B1"]', 'B1');
  await waitFor(devtools, page, `document.querySelector('.beast-turn').textContent.includes('上方')`, '上方回合');
  if (await evaluate(devtools, page, `!document.querySelector('.beast-cell[data-coordinate="B1"] .beast-piece')
    || document.querySelector('.beast-cell[data-coordinate="A1"] .beast-piece')`))
    throw new Error('斗兽棋走子后棋子位置不正确。');
  await clickButton(devtools, page, '悔棋');
  await waitFor(devtools, page, `document.querySelector('.beast-turn').textContent.includes('下方')
    && document.querySelector('.beast-cell[data-coordinate="A1"] .beast-piece')`, '悔棋恢复');

  const turns = [
    ['G3', 'G4', '上方'],
    ['A9', 'B9', '下方'],
    ['G4', 'G5', '上方'],
    ['B9', 'C9', '下方'],
    ['G5', 'G6', '上方'],
    ['C9', 'C8', '下方'],
    ['G6', 'G7', '上方'],
  ];
  for (const [from, to, nextTurn] of turns) {
    await clickSelector(devtools, page, `.beast-cell[data-coordinate="${from}"]`, from);
    await waitFor(devtools, page, `document.querySelector('.beast-cell[data-coordinate="${to}"]')?.classList.contains('target')`, `${from} → ${to} 合法落点`);
    await clickSelector(devtools, page, `.beast-cell[data-coordinate="${to}"]`, to);
    await waitFor(devtools, page, `document.querySelector('.beast-turn')?.textContent.includes('${nextTurn}')`, `${to} 后轮到${nextTurn}`);
  }
  const captureState = await evaluate(devtools, page, `(() => ({
    upperCount: document.querySelector('.beast-side:nth-child(1) header strong')?.textContent.trim(),
    upperLost: document.querySelector('.beast-side:nth-child(1) .beast-lost b')?.textContent.trim(),
    lastMove: document.querySelector('.beast-last-move strong')?.textContent.trim(),
    remainingPieces: document.querySelectorAll('.beast-piece').length,
  }))()`);
  if (captureState.upperCount !== '7' || !captureState.upperLost.includes('象')
    || !captureState.lastMove.includes('吃象') || captureState.remainingPieces !== 15)
    throw new Error(`浏览器吃子状态不正确：${JSON.stringify(captureState)}`);
  const desktopPlayedShot = await screenshot(devtools, page, '斗兽棋-桌面-吃子.png');

  await clickButton(devtools, page, '悔棋');
  await waitFor(devtools, page, `document.querySelectorAll('.beast-piece').length === 16
    && document.querySelector('.beast-cell[data-coordinate="G7"] img[alt="上方象"]')`, '悔棋恢复被吃棋子');
  await clickButton(devtools, page, '重新开始');
  await waitFor(devtools, page, `document.querySelectorAll('.beast-piece').length === 16
    && document.querySelector('.beast-turn')?.textContent.includes('下方')
    && document.querySelector('.beast-board-heading')?.textContent.includes('第 0 手')`, '重新开始');

  await setViewport(devtools, page, { width: 390, height: 844, mobile: true });
  await waitFor(devtools, page, `innerWidth === 390 && !!document.querySelector('.beast-page')`, '手机斗兽棋');
  const mobile = await evaluate(devtools, page, `(() => {
    const board = document.querySelector('.beast-board-frame').getBoundingClientRect();
    const cell = document.querySelector('.beast-cell[data-coordinate="A1"]').getBoundingClientRect();
    const cells = [...document.querySelectorAll('.beast-cell')];
    return {
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      board: { left: Math.round(board.left), right: Math.round(board.right), width: Math.round(board.width) },
      cell: { width: Math.round(cell.width), height: Math.round(cell.height) },
      allInsideBoard: cells.every(item => {
        const rect = item.getBoundingClientRect();
        return rect.left >= board.left - 1 && rect.right <= board.right + 1;
      }),
      actionWidths: [...document.querySelectorAll('.beast-actions button')].map(item => Math.round(item.getBoundingClientRect().width)),
    };
  })()`);
  if (mobile.scrollWidth > mobile.clientWidth + 1) throw new Error(`手机斗兽棋横向溢出：${JSON.stringify(mobile)}`);
  if (mobile.board.left < 0 || mobile.board.right > mobile.innerWidth + 1) throw new Error('手机棋盘超出视口。');
  if (!mobile.allInsideBoard) throw new Error('手机棋格超出棋盘底图。');
  if (mobile.cell.width < 40 || mobile.cell.height < 35) throw new Error(`手机棋格点击区域过小：${JSON.stringify(mobile.cell)}`);
  await clickSelector(devtools, page, '.beast-cell[data-coordinate="A1"]', '手机 A1 虎');
  await waitFor(devtools, page, `document.querySelectorAll('.beast-cell.target').length === 2`, '手机合法落点');
  const mobileShot = await screenshot(devtools, page, '斗兽棋-手机-选中棋子.png');

  await clickButton(devtools, page, '返回其他玩法');
  await waitFor(devtools, page, `new URL(location.href).searchParams.get('mode') === 'other'
    && !!document.querySelector('.other-games-page')`, '返回其他玩法');
  if (devtools.runtimeErrors.length) throw new Error(`浏览器运行时异常：${devtools.runtimeErrors.join('\n')}`);

  console.log(JSON.stringify({
    origin,
    desktopInitial,
    mobile,
    screenshots: { desktopInitialShot, desktopPlayedShot, mobileShot },
  }, null, 2));
} finally {
  devtools.close();
  child.kill();
  await delay(200);
  const resolvedProfile = resolve(profileDir);
  if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('three-chess-beast-acceptance-'))
    await rm(resolvedProfile, { recursive: true, force: true }).catch(() => undefined);
}
