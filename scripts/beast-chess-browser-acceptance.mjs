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
const profileDir = await mkdtemp(join(tmpdir(), 'three-chess-beast-online-acceptance-'));
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
      if (message.method === 'Runtime.exceptionThrown') {
        this.runtimeErrors.push(message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text
          ?? 'Runtime exception');
      }
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

  close() {
    this.socket?.close();
  }
}

async function launchChrome() {
  const child = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
    let stderr = '';
    const timer = setTimeout(() => rejectEndpoint(new Error(`Chrome 启动超时：${stderr}`)), 15_000);
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

async function createPage(devtools, size) {
  const { browserContextId } = await devtools.send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  await Promise.all([
    devtools.send('Page.enable', {}, sessionId),
    devtools.send('Runtime.enable', {}, sessionId),
  ]);
  await devtools.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__beastAudioPlays = [];
      const originalAudioPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.__beastAudioPlays.push(this.src || '');
        return originalAudioPlay.call(this);
      };`,
  }, sessionId);
  const page = { browserContextId, targetId, sessionId, size: { ...size } };
  await setViewport(devtools, page, size);
  await devtools.send('Page.navigate', { url: appUrl }, sessionId);
  return page;
}

async function setViewport(devtools, page, size) {
  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: size.mobile ?? false,
  }, page.sessionId);
  page.size = { ...size };
}

async function evaluate(devtools, page, expression) {
  const response = await devtools.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
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
    } catch { /* Navigation or reconnect may still be in progress. */ }
    await delay(80);
  }
  throw new Error(`等待“${label}”超时。`);
}

async function rect(devtools, page, selector) {
  return evaluate(devtools, page, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  })()`);
}

async function buttonRect(devtools, page, text, rootSelector = '') {
  return evaluate(devtools, page, `(() => {
    const root = ${rootSelector ? `document.querySelector(${JSON.stringify(rootSelector)})` : 'document'};
    const element = root && [...root.querySelectorAll('button')]
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
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  }, page.sessionId);
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  }, page.sessionId);
  await delay(90);
}

async function clickSelector(devtools, page, selector, label = selector) {
  await clickBox(devtools, page, await rect(devtools, page, selector), label);
}

async function clickButton(devtools, page, text, rootSelector = '') {
  await clickBox(devtools, page, await buttonRect(devtools, page, text, rootSelector), text);
}

async function enterGuest(devtools, page, seatSelector, nickname) {
  await waitFor(devtools, page,
    `document.querySelector(${JSON.stringify(seatSelector)}) && !document.querySelector(${JSON.stringify(seatSelector)}).disabled`,
    '空席位');
  await clickSelector(devtools, page, seatSelector, '空席位');
  await waitFor(devtools, page, `document.querySelector('.beast-seat-dialog')?.open === true`, '昵称弹窗');
  await clickSelector(devtools, page, '.beast-seat-dialog input', '昵称输入框');
  await devtools.send('Input.insertText', { text: nickname }, page.sessionId);
  await clickButton(devtools, page, '入座', '.beast-seat-dialog');
  await waitFor(devtools, page, `document.body.textContent.includes(${JSON.stringify(nickname)})
    && document.querySelectorAll('.beast-piece').length === 16`, `${nickname} 入座`);
}

async function screenshot(devtools, page, fileName) {
  const metrics = await devtools.send('Page.getLayoutMetrics', {}, page.sessionId);
  const content = metrics.cssContentSize ?? metrics.contentSize;
  const result = await devtools.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: page.size.width,
      height: Math.min(1800, Math.max(page.size.height, Math.ceil(content.height))),
      scale: 1,
    },
  }, page.sessionId);
  const target = join(screenshotDir, fileName);
  await writeFile(target, Buffer.from(result.data, 'base64'));
  return target;
}

const { child, devtools } = await launchChrome();
try {
  const lower = await createPage(devtools, { width: 1366, height: 768 });
  await waitFor(devtools, lower, `document.querySelector('.beast-page[data-connection="online"]') !== null`, '斗兽棋棋桌连接');
  await waitFor(devtools, lower, `document.querySelectorAll('.game-table-seat').length === 2`, '斗兽棋空桌');
  await evaluate(devtools, lower, `(() => {
    const key = 'three-kingdoms-chess:audio-v1';
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...value, effectsEnabled: true, effectsVolume: 0.85 }));
  })()`);
  await devtools.send('Page.reload', {}, lower.sessionId);
  await waitFor(devtools, lower, `document.querySelector('.beast-page[data-connection="online"]') !== null`, '音效启用后重新连接');
  const emptyTable = await screenshot(devtools, lower, '斗兽棋-联机棋桌-空桌.png');
  await enterGuest(devtools, lower, '.game-table-seat.red', '斗兽下方');
  assertActionRow(await evaluate(devtools, lower, `[...document.querySelectorAll('.beast-action-row button')].map(button => button.textContent.trim())`));
  await clickButton(devtools, lower, '准备');
  await waitFor(devtools, lower, `document.querySelector('.self-seat')?.classList.contains('ready')`, '下方准备');

  const upper = await createPage(devtools, { width: 1366, height: 768 });
  await waitFor(devtools, upper, `document.querySelector('.beast-page[data-connection="online"]') !== null`, '上方连接');
  await evaluate(devtools, upper, `(() => {
    const key = 'three-kingdoms-chess:audio-v1';
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...value, effectsEnabled: true, effectsVolume: 0.85 }));
  })()`);
  await devtools.send('Page.reload', {}, upper.sessionId);
  await waitFor(devtools, upper, `document.querySelector('.beast-page[data-connection="online"]') !== null`, '上方音效启用后重新连接');
  await waitFor(devtools, upper, `document.querySelector('.game-table-seat.red')?.textContent.includes('斗兽下方')`, '上方看到下方席位');
  await enterGuest(devtools, upper, '.game-table-seat.black', '斗兽上方');
  if (await evaluate(devtools, upper, `document.querySelector('.beast-cell')?.dataset.coordinate !== 'G1'
    || !document.querySelector('.beast-board-grid')?.getAttribute('aria-label').includes('上方玩家视角')`))
    throw new Error('上方玩家视角没有自动翻转。');
  if (await evaluate(devtools, upper, `document.querySelector('.beast-table-seat.upper strong')?.textContent.trim() !== '斗兽下方'
    || document.querySelector('.beast-table-seat.lower strong')?.textContent.trim() !== '斗兽上方'`))
    throw new Error('上方玩家视角的上下玩家卡片没有同步翻转。');
  await clickButton(devtools, upper, '准备');
  await waitFor(devtools, lower, `document.querySelector('.beast-turn-badge')?.textContent.includes('轮到 斗兽下方 行棋')`, '双方开局');
  await waitFor(devtools, upper, `document.querySelector('.beast-turn-badge')?.textContent.includes('轮到 斗兽下方 行棋')`, '上方同步开局');

  const desktop = await evaluate(devtools, lower, `(() => {
    const board = document.querySelector('.beast-online-board').getBoundingClientRect();
    const upper = document.querySelector('.beast-table-seat.upper').getBoundingClientRect();
    const lower = document.querySelector('.beast-table-seat.lower').getBoundingClientRect();
    const actions = document.querySelector('.beast-bottom-actions').getBoundingClientRect();
    return {
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      boardWidth: Math.round(board.width),
      boardHeight: Math.round(board.height),
      upperNickname: document.querySelector('.beast-table-seat.upper strong')?.textContent.trim(),
      lowerNickname: document.querySelector('.beast-table-seat.lower strong')?.textContent.trim(),
      gameRegionHeight: Math.round(actions.bottom - upper.top),
      actionButtons: [...document.querySelectorAll('.beast-action-row button')].map(button => button.textContent.trim()),
    };
  })()`);
  assertActionRow(desktop.actionButtons);
  if (desktop.upperNickname !== '斗兽上方' || desktop.lowerNickname !== '斗兽下方')
    throw new Error(`上下玩家信息不正确：${JSON.stringify(desktop)}`);
  if (desktop.boardWidth > 570 || desktop.boardHeight > 570)
    throw new Error(`桌面棋盘仍然过大：${JSON.stringify(desktop)}`);
  if (desktop.gameRegionHeight > lower.size.height)
    throw new Error(`棋盘与上下玩家信息无法容纳在同一屏：${JSON.stringify(desktop)}`);
  if (desktop.scrollWidth > desktop.clientWidth + 1)
    throw new Error(`桌面斗兽棋横向溢出：${JSON.stringify(desktop)}`);

  await evaluate(devtools, lower, `window.__beastAudioPlays = []`);
  await evaluate(devtools, upper, `window.__beastAudioPlays = []`);
  await clickSelector(devtools, lower, '.beast-cell[data-coordinate="A1"]', 'A1 虎');
  await waitFor(devtools, lower, `document.querySelectorAll('.beast-cell.target').length === 2`, 'A1 合法落点');
  await clickSelector(devtools, lower, '.beast-cell[data-coordinate="B1"]', 'B1');
  await waitFor(devtools, upper, `document.querySelector('.beast-history')?.textContent.includes('A1 → B1')`, '实时走子同步');
  await waitFor(devtools, upper, `document.querySelector('.beast-turn-badge')?.textContent.includes('轮到 斗兽上方 行棋')`, '轮到上方');
  await waitFor(devtools, lower, `window.__beastAudioPlays?.filter(src => src.includes('/audio/move.mp3')).length === 1`, '下方落子音效');
  await waitFor(devtools, upper, `window.__beastAudioPlays?.filter(src => src.includes('/audio/move.mp3')).length === 1`, '上方落子音效');
  if (await evaluate(devtools, lower, `document.querySelector('.beast-cell[data-coordinate="B1"]')?.hasAttribute('disabled')
    || document.querySelector('.beast-cell[data-coordinate="B1"]')?.getAttribute('aria-disabled') !== 'true'`))
    throw new Error('非当前回合的棋盘仍使用 disabled 变暗。');
  const playingShot = await screenshot(devtools, lower, '斗兽棋-联机-对局.png');
  const upperPerspectiveShot = await screenshot(devtools, upper, '斗兽棋-联机-上方视角.png');

  const visitor = await createPage(devtools, { width: 1366, height: 768 });
  await waitFor(devtools, visitor, `document.querySelector('.game-table-center')?.classList.contains('active')`, '访客看到进行中棋桌');
  await clickSelector(devtools, visitor, '.game-table-center', '棋桌观战');
  await waitFor(devtools, visitor, `document.querySelector('.beast-history')?.textContent.includes('A1 → B1')
    && document.querySelectorAll('.beast-piece').length === 16`, '访客观战棋盘');
  if (await evaluate(devtools, visitor, `document.querySelectorAll('.beast-action-row').length !== 0`))
    throw new Error('观战者仍看到玩家对局操作。');

  await clickButton(devtools, upper, '提和', '.beast-action-row');
  await waitFor(devtools, lower, `document.querySelector('.beast-draw-bar')?.textContent.includes('上方提出和棋')`, '下方收到提和');
  await clickButton(devtools, lower, '同意', '.beast-draw-bar');
  await waitFor(devtools, lower, `document.querySelector('.result-banner')?.textContent.includes('双方同意和棋')`, '双方和棋');
  const finishedShot = await screenshot(devtools, lower, '斗兽棋-联机-和棋.png');

  await clickButton(devtools, lower, '再来一局');
  await waitFor(devtools, lower, `document.querySelector('.beast-waiting-card')?.textContent.includes('双方已入座')`, '再来一局等待');
  const rematch = await evaluate(devtools, lower, `(() => ({
    upper: document.querySelector('.beast-table-seat.upper strong')?.textContent.trim(),
    lower: document.querySelector('.beast-table-seat.lower strong')?.textContent.trim(),
    roundText: document.querySelector('.beast-bottom-actions')?.textContent,
  }))()`);
  if (rematch.upper !== '斗兽上方' || rematch.lower !== '斗兽下方')
    throw new Error(`再来一局没有保留席位：${JSON.stringify(rematch)}`);

  await clickButton(devtools, lower, '准备');
  await clickButton(devtools, upper, '准备');
  await waitFor(devtools, lower, `document.querySelector('.beast-turn-badge')?.textContent.includes('轮到 斗兽下方 行棋')`, '第二局开始');

  await setViewport(devtools, lower, { width: 390, height: 844, mobile: true });
  await waitFor(devtools, lower, `innerWidth === 390 && document.querySelectorAll('.beast-piece').length === 16`, '手机斗兽棋对局');
  const mobile = await evaluate(devtools, lower, `(() => {
    const board = document.querySelector('.beast-online-board').getBoundingClientRect();
    const upper = document.querySelector('.beast-table-seat.upper').getBoundingClientRect();
    const lower = document.querySelector('.beast-table-seat.lower').getBoundingClientRect();
    const cell = document.querySelector('.beast-cell[data-coordinate="A1"]').getBoundingClientRect();
    return {
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      board: { left: Math.round(board.left), right: Math.round(board.right), width: Math.round(board.width) },
      cell: { width: Math.round(cell.width), height: Math.round(cell.height) },
      upperWidth: Math.round(upper.width),
      lowerWidth: Math.round(lower.width),
      playerActions: [...document.querySelectorAll('.beast-action-row button')].map(button => button.textContent.trim()),
    };
  })()`);
  assertActionRow(mobile.playerActions);
  if (mobile.scrollWidth > mobile.clientWidth + 1)
    throw new Error(`手机斗兽棋横向溢出：${JSON.stringify(mobile)}`);
  if (mobile.board.left < 0 || mobile.board.right > mobile.innerWidth + 1)
    throw new Error(`手机棋盘超出视口：${JSON.stringify(mobile)}`);
  if (mobile.cell.width < 40 || mobile.cell.height < 35)
    throw new Error(`手机棋格点击区域过小：${JSON.stringify(mobile.cell)}`);
  if (mobile.upperWidth < 350 || mobile.lowerWidth < 350)
    throw new Error(`手机上下玩家信息过窄：${JSON.stringify(mobile)}`);
  const mobileShot = await screenshot(devtools, lower, '斗兽棋-手机-联机对局.png');

  await clickButton(devtools, upper, '认输', '.beast-action-row');
  await waitFor(devtools, upper, `document.querySelector('.reset-dialog[open]') !== null`, '认输确认');
  await clickButton(devtools, upper, '确认认输', 'dialog[open]');
  await waitFor(devtools, lower, `document.querySelector('.result-banner')?.textContent.includes('下方因对手认输获胜')`, '下方看到认输胜利');
  await clickButton(devtools, upper, '退出', '.beast-action-row');
  await waitFor(devtools, upper, `document.querySelector('.game-table-seat.black')?.textContent.includes('空位')`, '退出释放席位');

  if (devtools.runtimeErrors.length)
    throw new Error(`浏览器运行时异常：${devtools.runtimeErrors.join('\n')}`);
  console.log(JSON.stringify({
    origin,
    desktop,
    mobile,
    rematch,
    screenshots: { emptyTable, playingShot, upperPerspectiveShot, finishedShot, mobileShot },
  }, null, 2));
} finally {
  devtools.close();
  child.kill();
  await delay(200);
  const resolvedProfile = resolve(profileDir);
  if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('three-chess-beast-online-acceptance-'))
    await rm(resolvedProfile, { recursive: true, force: true }).catch(() => undefined);
}

function assertActionRow(buttons) {
  if (JSON.stringify(buttons) !== JSON.stringify(['提和', '认输', '退出']))
    throw new Error(`对局左上操作按钮不正确：${JSON.stringify(buttons)}`);
}
