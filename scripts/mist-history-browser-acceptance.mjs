import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'docs', '验收截图');
const origin = process.env.THREE_CHESS_ACCEPTANCE_ORIGIN ?? 'http://localhost:5173';
const stage = message => console.error(`[Mist history acceptance] ${message}`);
const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!chromePath) throw new Error('找不到可用的 Chrome 或 Edge。');

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const profileDir = await mkdtemp(join(tmpdir(), 'mist-history-acceptance-'));
await mkdir(screenshotDir, { recursive: true });

class DevTools {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
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
  const child = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
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

async function createPage(devtools, width = 1440, height = 1000) {
  const { browserContextId } = await devtools.send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  await Promise.all([devtools.send('Page.enable', {}, sessionId), devtools.send('Runtime.enable', {}, sessionId)]);
  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await devtools.send('Page.navigate', { url: `${origin}/three-chess/` }, sessionId);
  return { sessionId, size: { width, height } };
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
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  }, page.sessionId);
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  }, page.sessionId);
}

async function capture(devtools, page, fileName) {
  const metrics = await devtools.send('Page.getLayoutMetrics', {}, page.sessionId);
  const content = metrics.cssContentSize ?? metrics.contentSize;
  const clip = {
    x: 0, y: 0, width: page.size.width,
    height: Math.min(1800, Math.max(page.size.height, Math.ceil(content.height))), scale: 1,
  };
  const candidate = await devtools.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true, clip,
  }, page.sessionId);
  const bytes = Buffer.from(candidate.data, 'base64');
  const target = join(screenshotDir, fileName);
  await writeFile(target, bytes);
  return target;
}

function emitAck(socket, event, payload) {
  return new Promise((resolveAck, rejectAck) => {
    const timer = setTimeout(() => rejectAck(new Error(`${event} timeout`)), 6_000);
    socket.emit(event, payload, ack => {
      clearTimeout(timer);
      if (!ack?.ok) rejectAck(new Error(`${event}: ${ack?.code} ${ack?.error}`));
      else resolveAck(ack.data);
    });
  });
}

async function connectClient(cookie) {
  const socket = io(origin, {
    path: '/three-chess/socket.io', forceNew: true, reconnection: false,
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
  });
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once('connect', resolveConnect);
    socket.once('connect_error', rejectConnect);
  });
  return socket;
}

async function seedSixMistGames(username, password) {
  const registration = await fetch(`${origin}/three-chess/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, remember: true }),
  });
  if (!registration.ok) throw new Error(`账号注册失败：${registration.status}`);
  const cookie = registration.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('账号注册后没有取得 Session Cookie。');
  const redSocket = await connectClient(cookie);
  const blackSocket = await connectClient();
  const red = await emitAck(redSocket, 'mist:join', { nickname: '', side: 'red' });
  const black = await emitAck(blackSocket, 'mist:join', { nickname: '战绩游客黑', side: 'black' });
  for (let game = 0; game < 6; game++) {
    await emitAck(redSocket, 'mist:ready', { reconnectToken: red.reconnectToken, ready: true });
    const started = (await emitAck(blackSocket, 'mist:ready', {
      reconnectToken: black.reconnectToken, ready: true,
    })).state;
    await emitAck(redSocket, 'mist:move', {
      reconnectToken: red.reconnectToken,
      intent: {
        requestId: `mist-history-acceptance-${game}`,
        version: started.version,
        pieceId: 'red-pawn-4-6',
        to: { x: 4, y: 5 },
      },
    });
    await emitAck(blackSocket, 'mist:resign', { reconnectToken: black.reconnectToken });
    if (game < 5) await emitAck(redSocket, 'mist:rematch', { reconnectToken: red.reconnectToken });
  }
  await emitAck(redSocket, 'mist:leave', { reconnectToken: red.reconnectToken });
  await emitAck(blackSocket, 'mist:leave', { reconnectToken: black.reconnectToken });
  redSocket.disconnect();
  blackSocket.disconnect();
}

async function main() {
  const username = `迷雾战绩${Date.now().toString().slice(-6)}`;
  stage('写入 6 盘迷雾象棋');
  await seedSixMistGames(username, '1234');
  const { child, devtools } = await launchChrome();
  let result;
  try {
    const page = await createPage(devtools);
    await waitFor(devtools, page, `document.querySelector('.home-page') !== null`, '首页');
    await clickSelector(devtools, page, '.header-actions .account-button', '登录入口');
    await waitFor(devtools, page, `document.querySelector('.auth-dialog')?.open === true`, '登录弹窗');
    await clickSelector(devtools, page, '.auth-dialog input[autocomplete="username"]', '用户名');
    await devtools.send('Input.insertText', { text: username }, page.sessionId);
    await clickSelector(devtools, page, '.auth-dialog input[autocomplete="current-password"]', '密码');
    await devtools.send('Input.insertText', { text: '1234' }, page.sessionId);
    const submit = await evaluate(devtools, page, `(() => {
      const element = [...document.querySelectorAll('.auth-dialog button')].find(button => button.textContent.trim() === '登录' && button.classList.contains('auth-submit'));
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
    if (!submit) throw new Error('找不到登录按钮。');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await devtools.send('Input.dispatchMouseEvent', {
        type, x: submit.x + submit.width / 2, y: submit.y + submit.height / 2,
        button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
      }, page.sessionId);
    }
    await waitFor(devtools, page, `document.querySelector('.header-actions .account-button')?.textContent.includes(${JSON.stringify(username)})`, '登录成功');
    await clickSelector(devtools, page, '.header-actions .account-button', '我的账号');
    await waitFor(devtools, page, `document.querySelectorAll('.history-directory').length === 2`, '两个棋谱目录');
    const directoryScreenshot = await capture(devtools, page, '账号-棋谱目录.png');
    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    }, page.sessionId);
    page.size = { width: 390, height: 844 };
    await waitFor(devtools, page, `innerWidth === 390`, '手机棋谱目录');
    const mobileDirectoryScreenshot = await capture(devtools, page, '账号-棋谱目录手机.png');
    await clickSelector(devtools, page, '.history-directory.mist-chess', '迷雾象棋目录');
    await waitFor(devtools, page, `document.querySelectorAll('.recent-list li').length === 5`, '迷雾最近5盘');
    const mobileListScreenshot = await capture(devtools, page, '账号-迷雾象棋-最近5盘手机.png');
    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    }, page.sessionId);
    page.size = { width: 1440, height: 1000 };
    await waitFor(devtools, page, `innerWidth === 1440`, '恢复桌面视口');
    const listScreenshot = await capture(devtools, page, '账号-迷雾象棋-最近5盘.png');
    await clickSelector(devtools, page, '.recent-list li .replay-history', '最新一盘复盘');
    await waitFor(devtools, page, `document.querySelector('.mist-replay-panel') !== null`, '迷雾复盘面板');
    await clickSelector(devtools, page, '.mist-replay-controls button:nth-last-child(2)', '最后一步');
    const replayScreenshot = await capture(devtools, page, '账号-迷雾象棋-复盘.png');
    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    }, page.sessionId);
    page.size = { width: 390, height: 844 };
    await waitFor(devtools, page, `innerWidth === 390`, '手机视口');
    const mobileMetrics = await evaluate(devtools, page, `({
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      dialogWidth: document.querySelector('.auth-dialog').getBoundingClientRect().width,
    })`);
    const mobileScreenshot = await capture(devtools, page, '账号-迷雾象棋-复盘手机.png');
    result = {
      username,
      listedGames: 5,
      mobileMetrics,
      screenshots: {
        directoryScreenshot,
        listScreenshot,
        replayScreenshot,
        mobileDirectoryScreenshot,
        mobileListScreenshot,
        mobileScreenshot,
      },
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    devtools.close();
    child.kill();
    await delay(200);
    const resolvedProfile = resolve(profileDir);
    if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('mist-history-acceptance-')) {
      try { await rm(resolvedProfile, { recursive: true, force: true }); } catch { /* System cleanup may finish later. */ }
    }
  }
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
