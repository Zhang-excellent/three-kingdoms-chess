import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connect } from 'socket.io-client';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'docs', '验收截图');
const appOrigin = process.env.THREE_CHESS_ACCEPTANCE_ORIGIN ?? 'http://localhost:5173';
const socketOrigin = process.env.THREE_CHESS_ACCEPTANCE_SOCKET_ORIGIN ?? 'http://127.0.0.1:3000';
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error('找不到可用的 Chrome 或 Edge。');
const profileDir = await mkdtemp(join(tmpdir(), 'three-chess-main-acceptance-'));
await mkdir(screenshotDir, { recursive: true });
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

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
      const message = JSON.parse(Buffer.from(data).toString('utf8'));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('DevTools connection closed'));
      this.pending.clear();
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

async function launch() {
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

async function createPage(devtools, width, height) {
  const { browserContextId } = await devtools.send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  await Promise.all([devtools.send('Page.enable', {}, sessionId), devtools.send('Runtime.enable', {}, sessionId)]);
  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await devtools.send('Page.navigate', { url: `${appOrigin}/?mode=online` }, sessionId);
  return { sessionId, width, height, browserContextId };
}

async function evaluate(devtools, page, expression) {
  const response = await devtools.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, page.sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(devtools, page, expression, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(devtools, page, expression)) return;
    } catch { /* navigation */ }
    await delay(80);
  }
  throw new Error(`等待“${label}”超时`);
}

async function rect(devtools, page, selector, text = null) {
  return evaluate(devtools, page, `(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = ${text ? `candidates.find(item => item.textContent.trim() === ${JSON.stringify(text)})` : 'candidates[0]'};
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  })()`);
}

async function click(devtools, page, selector, text = null, label = text || selector) {
  const box = await rect(devtools, page, selector, text);
  if (!box?.width || !box?.height) throw new Error(`找不到可点击的“${label}”`);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  }, page.sessionId);
  await devtools.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  }, page.sessionId);
}

async function fill(devtools, page, selector, text) {
  await click(devtools, page, selector, null, selector);
  await devtools.send('Input.insertText', { text }, page.sessionId);
}

async function capture(devtools, page, fileName) {
  const metrics = await devtools.send('Page.getLayoutMetrics', {}, page.sessionId);
  const content = metrics.cssContentSize ?? metrics.contentSize;
  const clip = { x: 0, y: 0, width: page.width, height: Math.min(1800, Math.max(page.height, Math.ceil(content.height))), scale: 1 };
  let bytes;
  for (const captureBeyondViewport of [true, false]) {
    const result = await devtools.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport, clip,
    }, page.sessionId);
    bytes = Buffer.from(result.data, 'base64');
    if (bytes.readUInt32BE(16) === page.width) break;
  }
  if (!bytes || bytes.readUInt32BE(16) !== page.width) throw new Error('截图宽度不正确');
  const target = join(screenshotDir, fileName);
  await writeFile(target, bytes);
  return target;
}

const sockets = [];
const emit = (socket, event, payload) => new Promise(resolveEmit => socket.emit(event, payload, resolveEmit));
async function socketClient() {
  const socket = connect(socketOrigin, {
    path: '/three-chess/socket.io', forceNew: true, reconnection: false,
  });
  sockets.push(socket);
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once('connect', resolveConnect);
    socket.once('connect_error', rejectConnect);
  });
  return socket;
}

const { child, devtools } = await launch();
try {
  const roomCode = String(370000 + Math.floor(Math.random() * 90000)).padStart(6, '0');
  const page = await createPage(devtools, 1440, 1000);
  await waitFor(devtools, page, `document.querySelector('.friend-create-card') !== null`, '好友对弈页');
  await fill(devtools, page, '.friend-create-card input[autocomplete="nickname"]', '三国棋盘房主');
  await fill(devtools, page, 'input[aria-label="创建房间号"]', roomCode);
  await click(devtools, page, 'button', '创建房间', '创建房间');
  await waitFor(devtools, page, `new URL(location.href).searchParams.get('room') === ${JSON.stringify(roomCode)}`, '进入三人房间');
  await waitFor(devtools, page, `document.querySelector('.room-lobby') && document.querySelectorAll('g.piece').length === 29`, '棋盘等待界面');
  const waitingOne = await capture(devtools, page, '三国象棋-棋盘等待-单人.png');

  await click(devtools, page, '.player-card.wei.selectable', null, '曹操阵营');
  await waitFor(devtools, page, `document.querySelector('.player-card.wei')?.textContent.includes('三国棋盘房主')`, '选择魏方');
  await click(devtools, page, 'button', '开始', '开始');

  const shuSocket = await socketClient(), wuSocket = await socketClient();
  const shu = await emit(shuSocket, 'room:join', { roomCode, nickname: '棋盘刘备' });
  const wu = await emit(wuSocket, 'room:join', { roomCode, nickname: '棋盘孙权' });
  if (!shu.ok || !wu.ok) throw new Error('其他阵营入房失败');
  if (!(await emit(shuSocket, 'room:choose-faction', {
    roomCode, reconnectToken: shu.data.reconnectToken, faction: 'shu', round: 1,
  })).ok) throw new Error('刘备选阵营失败');
  if (!(await emit(wuSocket, 'room:choose-faction', {
    roomCode, reconnectToken: wu.data.reconnectToken, faction: 'wu', round: 1,
  })).ok) throw new Error('孙权选阵营失败');
  await waitFor(devtools, page, `document.querySelector('.room-lobby')?.textContent.includes('3/3 人')`, '三人入座');
  const waitingThree = await capture(devtools, page, '三国象棋-棋盘等待-三人.png');

  if (!(await emit(shuSocket, 'room:ready', {
    roomCode, reconnectToken: shu.data.reconnectToken, ready: true, round: 1,
  })).ok) throw new Error('刘备准备失败');
  if (!(await emit(wuSocket, 'room:ready', {
    roomCode, reconnectToken: wu.data.reconnectToken, ready: true, round: 1,
  })).ok) throw new Error('孙权准备失败');
  await waitFor(devtools, page, `!document.querySelector('.room-lobby') && document.querySelector('.board-heading')?.textContent.includes('轮到 三国棋盘房主 行棋')`, '三人开局');
  const playing = await capture(devtools, page, '三国象棋-桌面-对局.png');

  await click(devtools, page, '.kingdom-board-toolbar .game-action-menu-toggle', null, '左侧菜单');
  await waitFor(devtools, page, `document.querySelector('.game-action-menu-list') !== null`, '菜单展开');
  const menu = await capture(devtools, page, '三国象棋-对局菜单.png');
  await click(devtools, page, '.kingdom-board-toolbar .game-action-menu-toggle', null, '关闭左侧菜单');
  await waitFor(devtools, page, `document.querySelector('.game-action-menu-list') === null`, '菜单关闭');

  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  }, page.sessionId);
  page.width = 390; page.height = 844;
  await waitFor(devtools, page, 'innerWidth === 390', '手机视口');
  const mobileMetrics = await evaluate(devtools, page, `(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    playerCardWidths: [...document.querySelectorAll('.player-card')].map(element => element.getBoundingClientRect().width),
    boardWidth: document.querySelector('.board-frame').getBoundingClientRect().width,
  }))()`);
  const mobile = await capture(devtools, page, '三国象棋-手机-对局.png');

  console.log(JSON.stringify({ roomCode, mobileMetrics, screenshots: { waitingOne, waitingThree, playing, menu, mobile } }, null, 2));
} finally {
  for (const socket of sockets) socket.disconnect();
  devtools.close();
  child.kill();
  await delay(200);
  const resolvedProfile = resolve(profileDir);
  if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('three-chess-main-acceptance-')) {
    await rm(resolvedProfile, { recursive: true, force: true }).catch(() => undefined);
  }
}
