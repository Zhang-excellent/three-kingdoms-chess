import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'docs', '验收截图');
const baseUrl = process.env.THREE_CHESS_ACCEPTANCE_URL ?? 'http://localhost:5173/';
const stage = message => console.error(`[Pikafish acceptance] ${message}`);
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error('找不到可用的 Chrome 或 Edge。');

await mkdir(screenshotDir, { recursive: true });
const profileDir = await mkdtemp(join(tmpdir(), 'three-chess-pikafish-acceptance-'));

class DevTools {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.once('open', resolveOpen);
      this.socket.once('error', rejectOpen);
    });
    this.socket.on('message', data => {
      const payload = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      const message = JSON.parse(payload);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.events.get(message.method) ?? []) listener(message.params, message.sessionId);
    });
    this.socket.on('close', (code, reason) => {
      const error = new Error(`Chrome DevTools 已关闭（${code}${reason?.length ? `: ${reason}` : ''}）。`);
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
    child.once('exit', code => {
      clearTimeout(timer);
      rejectEndpoint(new Error(`Chrome 提前退出，状态码 ${code}。${stderr}`));
    });
  });
  const devtools = new DevTools(endpoint);
  await devtools.connect();
  return { child, devtools };
}

async function createPage(devtools, size, mode = 'chinese-chess') {
  const { browserContextId } = await devtools.send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await devtools.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
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
  const url = new URL(baseUrl);
  url.searchParams.set('mode', mode);
  await devtools.send('Page.navigate', { url: url.href }, sessionId);
  return { browserContextId, sessionId, size };
}

async function evaluate(devtools, page, expression) {
  const response = await devtools.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, page.sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description
      ?? response.exceptionDetails.text
      ?? '浏览器脚本执行失败。');
  }
  return response.result.value;
}

async function waitFor(devtools, page, expression, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (await evaluate(devtools, page, expression)) return;
    } catch (error) {
      lastError = error.message;
    }
    await delay(80);
  }
  throw new Error(`等待“${label}”超时。${lastError ? ` ${lastError}` : ''}`);
}

async function elementRect(devtools, page, selector, index = 0) {
  return evaluate(devtools, page, `(() => {
    const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
}

async function buttonRect(devtools, page, text) {
  return evaluate(devtools, page, `(() => {
    const element = [...document.querySelectorAll('button')].find(button =>
      button.textContent.trim() === ${JSON.stringify(text)} && button.getClientRects().length);
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
}

async function clickRect(devtools, page, rect, label) {
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

async function clickSelector(devtools, page, selector, label = selector, index = 0) {
  await clickRect(devtools, page, await elementRect(devtools, page, selector, index), label);
}

async function clickButton(devtools, page, text) {
  await clickRect(devtools, page, await buttonRect(devtools, page, text), text);
}

async function fillGuestSeat(devtools, page, nickname) {
  await waitFor(devtools, page, `document.querySelector('.chinese-seat-dialog')?.open === true`, '游客昵称弹窗');
  await clickSelector(devtools, page, '.chinese-seat-dialog input', '游客昵称输入框');
  await devtools.send('Input.insertText', { text: nickname }, page.sessionId);
  await clickButton(devtools, page, '入座');
  await waitFor(devtools, page, `document.querySelectorAll('.chinese-piece').length === 32
    && document.body.textContent.includes(${JSON.stringify(nickname)})`, '游客进入棋桌');
}

async function selectPikafish(devtools, page) {
  await clickSelector(devtools, page, '.opponent-seat', '空对手席');
  await waitFor(devtools, page, `document.querySelector('.engine-seat-dialog')?.open === true`, '切换软件弹窗');
  await clickSelector(devtools, page, '.engine-seat-dialog .engine-choice', '皮卡鱼');
  await waitFor(devtools, page, `document.querySelector('.opponent-seat')?.textContent.includes('皮卡鱼 · 软件对手')`, '皮卡鱼入座');
}

async function capture(devtools, page, fileName, fullPage = false) {
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
  const shot = await devtools.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: fullPage,
    ...(clip ? { clip } : {}),
  }, page.sessionId);
  const target = join(screenshotDir, fileName);
  await writeFile(target, Buffer.from(shot.data, 'base64'));
  return target;
}

async function leaveByNavigation(devtools, page) {
  await clickSelector(devtools, page, '.chinese-page-nav button', '返回其他玩法');
  await waitFor(devtools, page, `new URL(location.href).searchParams.get('mode') === 'other'`, '返回其他玩法页面');
}

async function main() {
  const { child, devtools } = await launchChrome();
  const screens = {};
  const metrics = {};
  try {
    stage('真人执红，皮卡鱼执黑');
    const red = await createPage(devtools, { width: 1440, height: 1000 });
    await waitFor(devtools, red, `document.querySelector('.chinese-page[data-connection="online"]') !== null`, '桌面中国象棋连接');
    await clickSelector(devtools, red, '.game-table-seat.red', '红方空席');
    await fillGuestSeat(devtools, red, '皮卡鱼验收红');
    await clickSelector(devtools, red, '.opponent-seat', '空对手席');
    await waitFor(devtools, red, `document.querySelector('.engine-seat-dialog')?.open === true`, '切换软件弹窗');
    screens.chooser = await capture(devtools, red, '皮卡鱼-桌面-选择软件.png');
    await clickSelector(devtools, red, '.engine-seat-dialog .engine-choice', '皮卡鱼');
    await waitFor(devtools, red, `document.querySelector('.opponent-seat')?.textContent.includes('皮卡鱼 · 软件对手')`, '皮卡鱼入座');
    await clickButton(devtools, red, '开始');
    await waitFor(devtools, red, `!document.querySelector('.game-board-waiting-card')
      && document.querySelector('.chinese-board-heading h2')?.textContent.includes('轮到 皮卡鱼验收红 行棋')`, '真人红方开局');
    await clickSelector(devtools, red, '.chinese-piece[aria-label="红方兵，1 路第 7 线"]', '红方一路兵');
    await waitFor(devtools, red, `document.querySelector('.chinese-target[aria-label="走到第1路第6线"]') !== null`, '红方兵合法落点');
    await clickSelector(devtools, red, '.chinese-target[aria-label="走到第1路第6线"]', '红方一路兵落点');
    await waitFor(devtools, red, `document.querySelectorAll('.move-list li').length === 2
      && document.querySelector('.chinese-board-heading h2')?.textContent.includes('轮到 皮卡鱼验收红 行棋')
      && !document.querySelector('.engine-error-bar')`, '皮卡鱼黑方回应');
    screens.desktop = await capture(devtools, red, '皮卡鱼-桌面-真人红方对局.png', true);
    metrics.redTurn = await evaluate(devtools, red, `(() => ({
      moves: document.querySelectorAll('.move-list li').length,
      lastActor: document.querySelector('.move-list li strong')?.textContent.trim(),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
    }))()`);
    await leaveByNavigation(devtools, red);

    stage('真人执黑，皮卡鱼执红自动首步');
    const black = await createPage(devtools, { width: 1440, height: 1000 });
    await waitFor(devtools, black, `document.querySelector('.chinese-page[data-connection="online"]') !== null`, '黑方页面连接');
    await clickSelector(devtools, black, '.game-table-seat.black', '黑方空席');
    await fillGuestSeat(devtools, black, '皮卡鱼验收黑');
    await selectPikafish(devtools, black);
    await clickButton(devtools, black, '开始');
    await waitFor(devtools, black, `document.querySelectorAll('.move-list li').length === 1
      && document.querySelector('.chinese-board-heading h2')?.textContent.includes('轮到 皮卡鱼验收黑 行棋')`, '皮卡鱼红方自动首步');
    await clickSelector(devtools, black, '.chinese-piece[aria-label="黑方卒，1 路第 4 线"]', '黑方一路卒');
    await waitFor(devtools, black, `document.querySelector('.chinese-target[aria-label="走到第1路第5线"]') !== null`, '黑方卒合法落点');
    await clickSelector(devtools, black, '.chinese-target[aria-label="走到第1路第5线"]', '黑方一路卒落点');
    await waitFor(devtools, black, `document.querySelectorAll('.move-list li').length === 3
      && !document.querySelector('.engine-error-bar')`, '皮卡鱼红方再次回应');
    await clickSelector(devtools, black, '.game-action-menu-toggle', '对局菜单');
    const drawDisabled = await evaluate(devtools, black, `(() => {
      const button = [...document.querySelectorAll('.game-action-menu-list button')]
        .find(item => item.textContent.trim() === '提和');
      return button?.disabled === true;
    })()`);
    await clickButton(devtools, black, '认输');
    await waitFor(devtools, black, `document.querySelector('.reset-dialog[open]') !== null`, '认输确认弹窗');
    await clickButton(devtools, black, '确认认输');
    await waitFor(devtools, black, `document.querySelector('.result-banner') !== null`, '认输终局');
    await clickButton(devtools, black, '再来一局');
    await waitFor(devtools, black, `document.querySelector('.game-board-waiting-card') !== null
      && document.querySelector('.opponent-seat')?.textContent.includes('皮卡鱼 · 软件对手')`, '再来一局保留皮卡鱼');
    await clickButton(devtools, black, '开始');
    await waitFor(devtools, black, `document.querySelectorAll('.move-list li').length === 1
      && document.querySelector('.chinese-board-heading h2')?.textContent.includes('轮到 皮卡鱼验收黑 行棋')`, '第二局皮卡鱼自动首步');
    screens.rematch = await capture(devtools, black, '皮卡鱼-桌面-再来一局.png', true);
    metrics.rematch = await evaluate(devtools, black, `(() => ({
      moves: document.querySelectorAll('.move-list li').length,
      engineSeat: document.querySelector('.opponent-seat .chinese-seat-copy strong')?.textContent.trim(),
      drawDisabled: ${JSON.stringify(drawDisabled)},
    }))()`);
    await leaveByNavigation(devtools, black);

    stage('手机空席切换与切回真人');
    const mobile = await createPage(devtools, { width: 390, height: 844, mobile: true });
    await waitFor(devtools, mobile, `document.querySelector('.chinese-page[data-connection="online"]') !== null`, '手机页面连接');
    await clickSelector(devtools, mobile, '.game-table-seat.black', '手机黑方空席');
    await fillGuestSeat(devtools, mobile, '皮卡鱼手机验收');
    await clickSelector(devtools, mobile, '.opponent-seat', '手机对手空席');
    await waitFor(devtools, mobile, `document.querySelector('.engine-seat-dialog')?.open === true`, '手机切换软件弹窗');
    await clickSelector(devtools, mobile, '.engine-choice', '手机选择皮卡鱼');
    await waitFor(devtools, mobile, `document.querySelector('.opponent-seat')?.textContent.includes('皮卡鱼 · 软件对手')`, '手机皮卡鱼入座');
    screens.mobile = await capture(devtools, mobile, '皮卡鱼-手机-软件席位.png', true);
    metrics.mobile = await evaluate(devtools, mobile, `(() => {
      const board = document.querySelector('.chinese-board-frame').getBoundingClientRect();
      const seat = document.querySelector('.opponent-seat').getBoundingClientRect();
      return {
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        boardWidth: board.width,
        seatWidth: seat.width,
        seatText: document.querySelector('.opponent-seat').textContent.trim(),
      };
    })()`);
    await clickSelector(devtools, mobile, '.opponent-seat', '手机皮卡鱼席位');
    await clickButton(devtools, mobile, '切回等待棋友');
    await waitFor(devtools, mobile, `document.querySelector('.opponent-seat')?.textContent.includes('等待棋友')`, '手机切回真人');
    metrics.mobile.switchedBack = true;
    await leaveByNavigation(devtools, mobile);

    stage('其他玩法入口与中国象棋真人回归');
    const regression = await createPage(devtools, { width: 1280, height: 900 }, 'other');
    await waitFor(devtools, regression, `document.querySelector('.variant-entry[aria-label="进入中国象棋"]') !== null`, '其他玩法中国象棋入口');
    metrics.regression = await evaluate(devtools, regression, `(() => ({
      entries: [...document.querySelectorAll('.variant-entry')].map(card => card.textContent.trim()),
      mode: new URL(location.href).searchParams.get('mode'),
    }))()`);
    await clickSelector(devtools, regression, '.variant-entry[aria-label="进入中国象棋"]', '其他玩法中国象棋入口');
    await waitFor(devtools, regression, `new URL(location.href).searchParams.get('mode') === 'chinese-chess'
      && document.querySelector('.chinese-page[data-connection="online"]') !== null
      && document.querySelector('.game-table-center') !== null`, '从其他玩法进入中国象棋');

    const audit = {
      sources: {
        engineExecutable: process.env.PIKAFISH_PATH || null,
        evalFile: process.env.PIKAFISH_EVAL_FILE || null,
      },
      metrics,
      screenshots: screens,
    };
    for (const [label, value] of Object.entries(metrics)) {
      if (value?.scrollWidth > value?.innerWidth) throw new Error(`${label} 出现横向溢出。`);
    }
    if (metrics.mobile.seatWidth > metrics.mobile.innerWidth) throw new Error('手机对手席位超出视口。');
    if (metrics.redTurn.lastActor !== '黑方') throw new Error('皮卡鱼黑方回应未进入行棋记录。');
    if (metrics.rematch.engineSeat !== '皮卡鱼 · 软件对手' || metrics.rematch.moves !== 1) {
      throw new Error('再来一局没有保留皮卡鱼或自动首步。');
    }
    if (!metrics.rematch.drawDisabled) throw new Error('人机对局仍允许提和。');
    if (!metrics.regression.entries.some(entry => entry.includes('中国象棋')))
      throw new Error('其他玩法入口回归失败。');
    console.log(JSON.stringify(audit, null, 2));
  } finally {
    devtools.close();
    child.kill();
    await delay(200);
    const resolvedProfile = resolve(profileDir);
    if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('three-chess-pikafish-acceptance-')) {
      try {
        await rm(resolvedProfile, { recursive: true, force: true });
      } catch {
        // The operating system can clean up the temporary Chrome profile later.
      }
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
