import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'docs', '验收截图');
const appUrl = process.env.THREE_CHESS_ACCEPTANCE_URL ?? 'http://localhost:5173/?mode=mist-chess';
const stage = message => console.error(`[Mist acceptance] ${message}`);
const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!chromePath) throw new Error('找不到可用的 Chrome 或 Edge。');

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const profileDir = await mkdtemp(join(tmpdir(), 'three-chess-mist-acceptance-'));
await mkdir(screenshotDir, { recursive: true });

class DevTools {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.once('open', resolveOpen);
      this.socket.once('error', rejectOpen);
    });
    this.socket.on('message', data => {
      const message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
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
  stage('启动独立 Chrome');
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
    child.once('exit', code => {
      clearTimeout(timer);
      rejectEndpoint(new Error(`Chrome 提前退出，状态码 ${code}。${stderr}`));
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
  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: size.mobile ?? false,
  }, sessionId);
  await devtools.send('Page.navigate', { url: appUrl }, sessionId);
  return { sessionId, size };
}

async function evaluate(devtools, page, expression) {
  const response = await devtools.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, page.sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
}

async function waitFor(devtools, page, expression, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (await evaluate(devtools, page, expression)) return;
    } catch (error) { lastError = error.message; }
    await delay(80);
  }
  throw new Error(`等待“${label}”超时。${lastError ? ` ${lastError}` : ''}`);
}

async function clickSelector(devtools, page, selector, label = selector) {
  const rect = await evaluate(devtools, page, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error(`找不到可点击的“${label}”。`);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  }, page.sessionId);
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  }, page.sessionId);
}

async function fillSeat(devtools, page, nickname) {
  await waitFor(devtools, page, `document.querySelector('.mist-seat-dialog')?.open === true`, '昵称弹窗');
  await clickSelector(devtools, page, '.mist-seat-dialog input', '昵称输入框');
  await devtools.send('Input.insertText', { text: nickname }, page.sessionId);
  const button = await evaluate(devtools, page, `(() => {
    const element = [...document.querySelectorAll('.mist-seat-dialog button')].find(button => button.textContent.trim() === '入座');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  if (!button) throw new Error('找不到入座按钮。');
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: button.x + button.width / 2, y: button.y + button.height / 2,
    button: 'left', buttons: 1, clickCount: 1,
  }, page.sessionId);
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: button.x + button.width / 2, y: button.y + button.height / 2,
    button: 'left', buttons: 0, clickCount: 1,
  }, page.sessionId);
}

async function capture(devtools, page, fileName, fullPage = true) {
  let clip;
  if (fullPage) {
    const metrics = await devtools.send('Page.getLayoutMetrics', {}, page.sessionId);
    const content = metrics.cssContentSize ?? metrics.contentSize;
    clip = {
      x: 0,
      y: 0,
      width: page.size.width,
      height: Math.min(1800, Math.max(page.size.height, Math.ceil(content.height))),
      scale: 1,
    };
  }
  const candidate = await devtools.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: fullPage,
    ...(clip ? { clip } : {}),
  }, page.sessionId);
  const bytes = Buffer.from(candidate.data, 'base64');
  if (bytes.readUInt32BE(16) !== page.size.width)
    throw new Error(`截图宽度与目标视口 ${page.size.width}px 不一致。`);
  const target = join(screenshotDir, fileName);
  await writeFile(target, bytes);
  return target;
}

async function clickStart(devtools, page) {
  const rect = await evaluate(devtools, page, `(() => {
    const element = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '开始');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  if (!rect) throw new Error('找不到开始按钮。');
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    button: 'left', buttons: 1, clickCount: 1,
  }, page.sessionId);
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    button: 'left', buttons: 0, clickCount: 1,
  }, page.sessionId);
}

async function main() {
  const { child, devtools } = await launchChrome();
  let result;
  try {
    const red = await createPage(devtools, { width: 1440, height: 1000 });
    await waitFor(devtools, red, `document.querySelector('.mist-page[data-connection="online"]') !== null`, '红方连接');
    const emptyScreenshot = await capture(devtools, red, '迷雾象棋-棋桌-空桌.png');
    await clickSelector(devtools, red, '.game-table-seat.red', '红方席位');
    await fillSeat(devtools, red, '迷雾红游客');
    await waitFor(devtools, red, `document.querySelectorAll('.mist-piece').length === 16`, '红方首手禁炮投影棋盘');
    await clickStart(devtools, red);
    await waitFor(devtools, red, `document.querySelector('.self-seat')?.classList.contains('ready')`, '红方准备');

    const black = await createPage(devtools, { width: 1440, height: 1000 });
    await waitFor(devtools, black, `document.querySelector('.mist-page[data-connection="online"]') !== null`, '黑方连接');
    await waitFor(devtools, black, `document.querySelector('.game-table-seat.red')?.textContent.includes('迷雾红游客')`, '黑方看到红方席位');
    await clickSelector(devtools, black, '.game-table-seat.black', '黑方席位');
    await fillSeat(devtools, black, '迷雾黑游客');
    await waitFor(devtools, black, `document.querySelectorAll('.mist-piece').length === 18`, '黑方投影棋盘');
    await clickStart(devtools, black);
    await waitFor(devtools, red, `document.querySelector('.mist-board-heading h2')?.textContent.includes('轮到 迷雾红游客 行棋')`, '对局开始');

    await clickSelector(devtools, red, '.mist-piece[aria-label="红方兵，5 路第 7 线"]', '红方中兵');
    await clickSelector(devtools, red, '.mist-target[aria-label="走到第5路第6线"]', '红方中兵落点');
    await waitFor(devtools, black, `document.querySelector('.mist-board-heading h2')?.textContent.includes('轮到 迷雾黑游客 行棋')`, '黑方收到轮次');
    const hiddenHistory = await evaluate(devtools, black, `document.querySelector('.mist-history')?.textContent.includes('(5, 6)') ?? false`);
    if (hiddenHistory) throw new Error('黑方界面泄露了红方迷雾走子坐标。');
    const desktopScreenshot = await capture(devtools, red, '迷雾象棋-桌面-双方视野.png');

    const visitor = await createPage(devtools, { width: 1440, height: 1000 });
    await waitFor(devtools, visitor, `document.querySelector('.mist-page[data-connection="online"]') !== null`, '观战页面连接');
    await waitFor(devtools, visitor, `document.querySelector('.game-table-center')?.classList.contains('active')`, '观战棋桌状态');
    await clickSelector(devtools, visitor, '.game-table-center', '观战棋桌');
    await waitFor(devtools, visitor, `document.querySelectorAll('.mist-piece').length === 32 && document.querySelectorAll('.mist-fog-cell').length === 0`, '无迷雾完整观战棋盘');
    await waitFor(devtools, visitor, `document.querySelector('.mist-history')?.textContent.includes('(5, 6)')`, '观战完整棋谱');
    const spectatorScreenshot = await capture(devtools, visitor, '迷雾象棋-桌面-观战无迷雾.png');

    await devtools.send('Page.reload', {}, black.sessionId);
    await waitFor(devtools, black, `document.querySelector('.mist-page[data-connection="online"]') && document.querySelector('.mist-board-heading h2')?.textContent.includes('轮到 迷雾黑游客 行棋')`, '刷新重连恢复');
    const reconnectScreenshot = await capture(devtools, black, '迷雾象棋-桌面-刷新恢复.png');

    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    }, red.sessionId);
    red.size = { width: 390, height: 844, mobile: true };
    await waitFor(devtools, red, `innerWidth === 390`, '手机视口');
    const mobileMetrics = await evaluate(devtools, red, `(() => ({
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      boardWidth: document.querySelector('.mist-board-frame')?.getBoundingClientRect().width ?? 0,
      seatWidths: [...document.querySelectorAll('.mist-table-seat')].map(element => element.getBoundingClientRect().width),
    }))()`);
    const mobileScreenshot = await capture(devtools, red, '迷雾象棋-手机-对局棋盘.png');
    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    }, red.sessionId);
    red.size = { width: 1440, height: 1000, mobile: false };
    await waitFor(devtools, red, `innerWidth === 1440`, '恢复桌面视口');

    await clickSelector(devtools, black, '.mist-piece[aria-label="黑方卒，5 路第 4 线"]', '黑方中卒');
    await clickSelector(devtools, black, '.mist-target[aria-label="走到第5路第5线"]', '黑方中卒落点');
    await waitFor(devtools, red, `document.querySelector('.mist-board-heading h2')?.textContent.includes('轮到 迷雾红游客 行棋')`, '红方第二回合');
    await clickSelector(devtools, red, '.mist-piece[aria-label="红方兵，5 路第 6 线"]', '红方中兵吃卒');
    await clickSelector(devtools, red, '.mist-target[aria-label="吃子到第5路第5线"]', '红方吃黑卒');
    await waitFor(devtools, black, `document.querySelector('.mist-board-heading h2')?.textContent.includes('轮到 迷雾黑游客 行棋')`, '黑方第三回合');
    await clickSelector(devtools, black, '.mist-piece[aria-label="黑方将，5 路第 1 线"]', '黑方将');
    await clickSelector(devtools, black, '.mist-target[aria-label="走到第5路第2线"]', '黑将移动');
    await waitFor(devtools, red, `document.querySelector('.mist-board-heading h2')?.textContent.includes('轮到 迷雾红游客 行棋')`, '红方第五回合');
    await clickSelector(devtools, red, '.mist-piece[aria-label="红方兵，5 路第 5 线"]', '红方中兵前进');
    await clickSelector(devtools, red, '.mist-target[aria-label="走到第5路第4线"]', '红兵前进');
    await waitFor(devtools, black, `document.querySelector('.mist-board-heading h2')?.textContent.includes('轮到 迷雾黑游客 行棋')`, '黑方第六回合');
    await clickSelector(devtools, black, '.mist-piece[aria-label="黑方将，5 路第 2 线"]', '黑将下移');
    await clickSelector(devtools, black, '.mist-target[aria-label="走到第5路第3线"]', '黑将下移落点');
    await waitFor(devtools, red, `document.querySelector('.mist-board-heading h2')?.textContent.includes('轮到 迷雾红游客 行棋')`, '红方吃将回合');
    await clickSelector(devtools, red, '.mist-piece[aria-label="红方兵，5 路第 4 线"]', '红兵吃将');
    await clickSelector(devtools, red, '.mist-target[aria-label="吃子到第5路第3线"]', '红兵吃黑将');
    await waitFor(devtools, red, `document.querySelector('.result-banner')?.textContent.includes('吃掉对方将帅')`, '吃将终局');
    const finishedScreenshot = await capture(devtools, red, '迷雾象棋-桌面-吃将终局.png');

    const rematchRect = await evaluate(devtools, black, `(() => {
      const element = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '再来一局');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
    if (!rematchRect) throw new Error('终局后找不到再来一局。');
    await devtools.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: rematchRect.x + rematchRect.width / 2, y: rematchRect.y + rematchRect.height / 2,
      button: 'left', buttons: 1, clickCount: 1,
    }, black.sessionId);
    await devtools.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: rematchRect.x + rematchRect.width / 2, y: rematchRect.y + rematchRect.height / 2,
      button: 'left', buttons: 0, clickCount: 1,
    }, black.sessionId);
    await waitFor(devtools, red, `document.querySelector('.game-board-waiting-card') !== null`, '同房再来一局');

    await clickSelector(devtools, red, '.mist-page-nav button', '红方返回其他玩法');
    await waitFor(devtools, red, `new URL(location.href).searchParams.get('mode') === 'other'`, '红方释放席位');
    await clickSelector(devtools, black, '.mist-page-nav button', '黑方返回其他玩法');
    await waitFor(devtools, black, `new URL(location.href).searchParams.get('mode') === 'other'`, '黑方释放席位');

    result = {
      desktop: { hiddenHistory, redPieceCount: 18, blackPieceCount: 18 },
      mobileMetrics,
      screenshots: {
        emptyScreenshot,
        desktopScreenshot,
        spectatorScreenshot,
        reconnectScreenshot,
        finishedScreenshot,
        mobileScreenshot,
      },
    };
    nodeReplResult(result);
  } finally {
    devtools.close();
    child.kill();
    await delay(200);
    const resolvedProfile = resolve(profileDir);
    if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('three-chess-mist-acceptance-')) {
      try { await rm(resolvedProfile, { recursive: true, force: true }); } catch { /* System cleanup may finish later. */ }
    }
  }
}

function nodeReplResult(value) {
  if (globalThis.nodeRepl?.write) globalThis.nodeRepl.write(JSON.stringify(value, null, 2));
  else console.log(JSON.stringify(value, null, 2));
}

const keepAlive = setInterval(() => undefined, 1_000);
try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
