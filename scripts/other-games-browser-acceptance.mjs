import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'docs', '验收截图');
const origin = process.env.THREE_CHESS_ACCEPTANCE_ORIGIN ?? 'http://localhost:5173';
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error('找不到可用的 Chrome 或 Edge。');

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const profileDir = await mkdtemp(join(tmpdir(), 'three-chess-other-games-acceptance-'));
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
      const message = JSON.parse(Buffer.from(data).toString('utf8'));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    this.socket.on('close', () => {
      const error = new Error('Chrome DevTools 连接已关闭。');
      for (const pending of this.pending.values()) pending.reject(error);
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

async function createPage(devtools, url, size) {
  const { browserContextId } = await devtools.send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  await Promise.all([
    devtools.send('Page.enable', {}, sessionId),
    devtools.send('Runtime.enable', {}, sessionId),
  ]);
  const page = { browserContextId, targetId, sessionId, size: { ...size } };
  await setViewport(devtools, page, size);
  await devtools.send('Page.navigate', { url }, sessionId);
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
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, page.sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result.value;
}

async function waitFor(devtools, page, expression, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(devtools, page, expression)) return;
    } catch { /* Page may still be navigating. */ }
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

async function buttonRect(devtools, page, text) {
  return evaluate(devtools, page, `(() => {
    const element = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
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
}

async function clickSelector(devtools, page, selector, label = selector) {
  await clickBox(devtools, page, await rect(devtools, page, selector), label);
}

async function clickButton(devtools, page, text) {
  await clickBox(devtools, page, await buttonRect(devtools, page, text), text);
}

async function enterGuest(devtools, page, seatSelector, dialogSelector, nickname) {
  await waitFor(devtools, page, `document.querySelector(${JSON.stringify(seatSelector)}) && !document.querySelector(${JSON.stringify(seatSelector)}).disabled`, '空席位');
  await clickSelector(devtools, page, seatSelector, '空头像');
  await waitFor(devtools, page, `document.querySelector(${JSON.stringify(dialogSelector)})?.open === true`, '昵称弹窗');
  await clickSelector(devtools, page, `${dialogSelector} input`, '昵称输入框');
  await devtools.send('Input.insertText', { text: nickname }, page.sessionId);
  await clickButton(devtools, page, '入座');
  await waitFor(devtools, page, `document.body.textContent.includes(${JSON.stringify(nickname)})`, '入座完成');
}

async function screenshot(devtools, page, fileName) {
  const metrics = await devtools.send('Page.getLayoutMetrics', {}, page.sessionId);
  const content = metrics.cssContentSize ?? metrics.contentSize;
  const clip = {
    x: 0, y: 0, width: page.size.width,
    height: Math.min(1800, Math.max(page.size.height, Math.ceil(content.height))),
    scale: 1,
  };
  let bytes;
  for (const captureBeyondViewport of [true, false]) {
    const result = await devtools.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport, clip,
    }, page.sessionId);
    bytes = Buffer.from(result.data, 'base64');
    if (bytes.readUInt32BE(16) === page.size.width) break;
  }
  if (!bytes || bytes.readUInt32BE(16) !== page.size.width)
    throw new Error(`截图宽度与目标视口 ${page.size.width}px 不一致。`);
  const target = join(screenshotDir, fileName);
  await writeFile(target, bytes);
  return target;
}

const games = [
  {
    key: 'five',
    name: '五兵联盟',
    url: `${origin}/?mode=five-soldiers`,
    root: '.five-page',
    seat: '.five-table-seat',
    tableSeat: '.game-table-seat',
    tableCenter: '.game-table-center',
    dialog: '.five-seat-dialog',
    board: '.five-board-frame',
    history: '.five-history',
    actions: '.five-table-actions',
    pieces: '.five-piece',
    pieceCount: 26,
    moves: [
      ['红方兵，1 路第 7 线', '走到第1路第6线', '(1, 6)'],
      ['红方兵，3 路第 7 线', '走到第3路第6线', '(3, 6)'],
    ],
    finalTurn: '黑游客',
  },
  {
    key: 'horse',
    name: '马棋',
    url: `${origin}/?mode=horse-chess`,
    root: '.horse-page',
    seat: '.horse-table-seat',
    tableSeat: '.game-table-seat',
    tableCenter: '.game-table-center',
    dialog: '.horse-seat-dialog',
    board: '.horse-board-frame',
    history: '.horse-history',
    actions: '.horse-table-actions',
    pieces: '.horse-piece',
    pieceCount: 18,
    moves: [
      ['红方马，2 路第 10 线', '走到第3路第8线', '(3, 8)'],
    ],
    finalTurn: '黑游客',
  },
];

async function runGame(devtools, game) {
  const pages = [];
  const create = async size => {
    const page = await createPage(devtools, game.url, size);
    pages.push(page);
    return page;
  };
  try {
    const red = await create({ width: 1440, height: 1000 });
    await waitFor(devtools, red, `document.querySelector('${game.root}[data-connection="online"]') !== null`, `${game.name}连接`);
    await waitFor(devtools, red, `document.querySelectorAll('${game.tableSeat}').length === 2`, `${game.name}棋桌`);
    await waitFor(devtools, red, `document.querySelectorAll('${game.pieces}').length === 0`, `${game.name}初始棋桌`);
    const empty = await screenshot(devtools, red, `${game.name}-棋桌-桌面.png`);
    const desktop = await evaluate(devtools, red, `(() => ({
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      tableWidth: document.querySelector('${game.tableCenter}').getBoundingClientRect().width,
      seats: [...document.querySelectorAll('${game.tableSeat}')].map(element => element.getBoundingClientRect().width),
    }))()`);

    await enterGuest(devtools, red, '.game-table-seat.red', game.dialog, `${game.name}红游客`);
    await waitFor(devtools, red, `document.querySelectorAll('${game.pieces}').length === ${game.pieceCount}`, `${game.name}入座后棋盘`);
    await clickButton(devtools, red, '开始');
    await waitFor(devtools, red, `document.querySelector('.self-seat')?.classList.contains('ready')`, `${game.name}红方准备`);

    const black = await create({ width: 1440, height: 1000 });
    await waitFor(devtools, black, `document.querySelector('${game.root}[data-connection="online"]') !== null`, `${game.name}黑方连接`);
    await waitFor(devtools, black, `document.querySelector('.game-table-seat.red')?.textContent.includes(${JSON.stringify(`${game.name}红游客`)})`, `${game.name}红方席位同步`);
    await enterGuest(devtools, black, '.game-table-seat.black', game.dialog, `${game.name}黑游客`);
    await clickButton(devtools, black, '开始');
    await waitFor(devtools, red, `document.querySelector('.${game.key}-board-heading h2')?.textContent.includes('轮到 ${game.name}红游客 行棋')`, `${game.name}开局`);

    for (const [pieceLabel, targetLabel, coordinate] of game.moves) {
      await clickSelector(devtools, red, `${game.pieces}[aria-label="${pieceLabel}"]`, pieceLabel);
      await waitFor(devtools, red, `document.querySelector('.${game.key}-target[aria-label="${targetLabel}"]') !== null`, `${game.name}合法落点`);
      await clickSelector(devtools, red, `.${game.key}-target[aria-label="${targetLabel}"]`, targetLabel);
      await waitFor(devtools, black, `document.querySelector('${game.history}')?.textContent.includes(${JSON.stringify(coordinate)})`, `${game.name}实时走子 ${coordinate}`);
    }
    const playing = await screenshot(devtools, red, `${game.name}-桌面-对局.png`);

    const visitor = await create({ width: 1440, height: 1000 });
    await waitFor(devtools, visitor, `document.querySelector('${game.root}[data-connection="online"]') !== null`, `${game.name}访客连接`);
    await waitFor(devtools, visitor, `document.querySelector('${game.tableCenter}')?.classList.contains('active')`, `${game.name}访客棋桌状态`);
    const activeTable = await screenshot(devtools, visitor, `${game.name}-棋桌-进行中.png`);
    await clickSelector(devtools, visitor, game.tableCenter, '中间棋桌观战');
    await waitFor(devtools, visitor, `document.querySelector('${game.history}')?.textContent.includes(${JSON.stringify(game.moves.at(-1)[2])})`, `${game.name}访客盘面`);
    const audit = await evaluate(devtools, visitor, `(() => ({
      pieces: document.querySelectorAll('${game.pieces}').length,
      history: document.querySelector('${game.history}')?.textContent,
      playerActions: [...document.querySelectorAll('button')]
        .map(button => button.textContent.trim())
        .filter(text => ['准备', '认输', '再来一局', '退出房间'].includes(text)),
    }))()`);
    const spectator = await screenshot(devtools, visitor, `${game.name}-桌面-观战.png`);

    await setViewport(devtools, visitor, { width: 390, height: 844, mobile: true });
    await waitFor(devtools, visitor, 'innerWidth === 390', `${game.name}手机视口`);
    const mobile = await evaluate(devtools, visitor, `(() => ({
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      boardWidth: document.querySelector('${game.board}').getBoundingClientRect().width,
      seatWidths: [...document.querySelectorAll('${game.seat}')].map(element => element.getBoundingClientRect().width),
      actionWidths: [...document.querySelectorAll('${game.actions} button')].map(element => element.getBoundingClientRect().width),
    }))()`);
    const mobileShot = await screenshot(devtools, visitor, `${game.name}-手机-观战.png`);

    await clickSelector(devtools, red, '.page-nav button, .five-page-nav button, .horse-page-nav button', '返回其他玩法');
    await waitFor(devtools, red, `new URL(location.href).searchParams.get('mode') === 'other'`, `${game.name}返回其他玩法`);
    await waitFor(devtools, black, `document.querySelector('.opponent-seat')?.textContent.includes('等待棋友')`, `${game.name}主动离席释放`);

    return { desktop, mobile, audit, screenshots: { empty, activeTable, playing, spectator, mobileShot } };
  } finally {
    for (const page of pages) {
      await devtools.send('Target.disposeBrowserContext', { browserContextId: page.browserContextId }).catch(() => undefined);
    }
  }
}

const { child, devtools } = await launchChrome();
try {
  const results = {};
  for (const game of games) results[game.key] = await runGame(devtools, game);
  console.log(JSON.stringify(results, null, 2));
} finally {
  devtools.close();
  child.kill();
  await delay(200);
  const resolvedProfile = resolve(profileDir);
  if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('three-chess-other-games-acceptance-')) {
    await rm(resolvedProfile, { recursive: true, force: true }).catch(() => undefined);
  }
}
