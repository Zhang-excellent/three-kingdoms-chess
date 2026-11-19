import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'docs', '验收截图');
const appOrigin = process.env.THREE_CHESS_HOME_ACCEPTANCE_ORIGIN ?? 'http://127.0.0.1:3100';
const appUrl = `${appOrigin}/three-chess/`;
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error('找不到可用的 Chrome 或 Edge。');
const profileDir = await mkdtemp(join(tmpdir(), 'three-chess-home-acceptance-'));
await mkdir(screenshotDir, { recursive: true });
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

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
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
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
  await Promise.all([
    devtools.send('Page.enable', {}, sessionId),
    devtools.send('Runtime.enable', {}, sessionId),
  ]);
  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await devtools.send('Page.navigate', { url: appUrl }, sessionId);
  return { sessionId, width, height };
}

async function evaluate(devtools, page, expression) {
  const response = await devtools.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, page.sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(devtools, page, expression, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(devtools, page, expression)) return;
    } catch { /* navigation */ }
    await delay(80);
  }
  throw new Error(`等待“${label}”超时`);
}

async function clickButton(devtools, page, label) {
  const clicked = await evaluate(devtools, page, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find(item => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到按钮：${label}`);
  await delay(100);
}

async function clickHomeCard(devtools, page, label) {
  const clicked = await evaluate(devtools, page, `(() => {
    const card = [...document.querySelectorAll('.home-action-card')]
      .find(item => item.querySelector('strong')?.textContent.trim() === ${JSON.stringify(label)});
    if (!card) return false;
    card.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到首页入口：${label}`);
  await delay(100);
}

async function capture(devtools, page, fileName) {
  const result = await devtools.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  }, page.sessionId);
  const target = join(screenshotDir, fileName);
  await writeFile(target, Buffer.from(result.data, 'base64'));
  return target;
}

async function registerAcceptanceAccount() {
  const username = `首页验收${Date.now().toString().slice(-8)}`;
  const response = await fetch(`${appOrigin}/three-chess/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: appOrigin },
    body: JSON.stringify({ username, password: '1234', remember: false }),
  });
  if (!response.ok) throw new Error(`验收账号注册失败：${response.status}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const token = setCookie.match(/three_chess_session=([^;]+)/)?.[1];
  if (!token) throw new Error('验收账号 Cookie 缺失');
  return { username, token };
}

const { child, devtools } = await launch();
try {
  const page = await createPage(devtools, 1366, 768);
  await waitFor(devtools, page, `!!document.querySelector('.home-page')`, '首页');

  const initial = await evaluate(devtools, page, `(() => ({
    cards: [...document.querySelectorAll('.home-action-card strong')].map(item => item.textContent.trim()),
    nav: [...document.querySelectorAll('.header-actions button')].map(item => item.textContent.trim()),
    footer: !!document.querySelector('.site-footer'),
    tagline: document.querySelector('.home-tagline')?.textContent.trim(),
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    cardTops: [...document.querySelectorAll('.home-action-card')].map(item => Math.round(item.getBoundingClientRect().top)),
    cardHeights: [...document.querySelectorAll('.home-action-card')].map(item => Math.round(item.getBoundingClientRect().height)),
  }))()`);
  if (JSON.stringify(initial.cards) !== JSON.stringify(['公开大厅', '好友对战', '其他玩法', '本地试玩']))
    throw new Error(`首页入口顺序错误：${JSON.stringify(initial.cards)}`);
  if (initial.nav.includes('观战') || initial.nav.includes('好友组局'))
    throw new Error(`顶部导航仍含旧入口：${JSON.stringify(initial.nav)}`);
  if (initial.nav.filter(label => label === '好友对战').length !== 1)
    throw new Error('顶部“好友对战”入口数量不正确');
  if (initial.footer || initial.tagline !== '一局棋，三方博弈')
    throw new Error('首页底部清理不完整');
  if (new Set(initial.cardTops).size !== 1)
    throw new Error(`桌面四张入口未在同一行：${JSON.stringify(initial.cardTops)}`);

  await clickHomeCard(devtools, page, '其他玩法');
  await waitFor(devtools, page, `!!document.querySelector('.other-games-page')`, '其他玩法页');
  await clickButton(devtools, page, '首页');
  await waitFor(devtools, page, `!!document.querySelector('.home-page')`, '返回首页');

  await clickHomeCard(devtools, page, '好友对战');
  await waitFor(devtools, page, `!!document.querySelector('.lobby-page')`, '好友对战页');
  await waitFor(devtools, page, `(() => {
    const button = document.querySelector('.friend-secondary-action');
    return button && !button.disabled && button.textContent.trim() === '观战';
  })()`, '好友页观战入口');
  await evaluate(devtools, page, `document.querySelector('.friend-secondary-action').click()`);
  await waitFor(devtools, page, `!!document.querySelector('.watch-entry')`, '观战入口');
  await clickButton(devtools, page, '首页');
  await waitFor(devtools, page, `!!document.querySelector('.home-page')`, '好友页返回首页');

  await clickHomeCard(devtools, page, '公开大厅');
  await waitFor(devtools, page, `!!document.querySelector('.lobby-page')`, '公开大厅');
  await clickButton(devtools, page, '首页');
  await waitFor(devtools, page, `!!document.querySelector('.home-page')`, '大厅返回首页');

  await clickHomeCard(devtools, page, '本地试玩');
  await waitFor(devtools, page, `!!document.querySelector('.board-panel')`, '本地试玩');
  await clickButton(devtools, page, '首页');
  await waitFor(devtools, page, `!!document.querySelector('.home-page')`, '本地试玩返回首页');

  const account = await registerAcceptanceAccount();
  await devtools.send('Network.setCookie', {
    name: 'three_chess_session', value: account.token, domain: '127.0.0.1',
    path: '/three-chess', httpOnly: true, sameSite: 'Lax', url: appOrigin,
  }, page.sessionId);
  await devtools.send('Page.reload', {}, page.sessionId);
  await waitFor(devtools, page, `!!document.querySelector('.home-page')`, '登录后首页');
  await waitFor(devtools, page, `[...document.querySelectorAll('.header-actions button')]
    .some(item => item.textContent.trim() === ${JSON.stringify(account.username)})`, '登录昵称入口');
  const desktopScreenshot = await capture(devtools, page, '2026-11-19-home-desktop.png');

  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844,
  }, page.sessionId);
  page.width = 390; page.height = 844;
  await devtools.send('Page.reload', {}, page.sessionId);
  await waitFor(devtools, page, `innerWidth === 390 && !!document.querySelector('.home-page')`, '手机首页');
  const mobile = await evaluate(devtools, page, `(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    cardRects: [...document.querySelectorAll('.home-action-card')].map(item => {
      const rect = item.getBoundingClientRect();
      return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
    }),
    accountVisible: [...document.querySelectorAll('.header-actions button')]
      .some(item => item.textContent.trim() === ${JSON.stringify(account.username)} && item.getBoundingClientRect().width > 0),
  }))()`);
  if (mobile.scrollWidth !== mobile.innerWidth) throw new Error(`手机首页横向溢出：${JSON.stringify(mobile)}`);
  if (new Set(mobile.cardRects.map(item => item.left)).size !== 2 || new Set(mobile.cardRects.map(item => item.top)).size !== 2)
    throw new Error(`手机入口不是两列两行：${JSON.stringify(mobile.cardRects)}`);
  if (!mobile.accountVisible) throw new Error('手机顶部账号昵称入口被隐藏');
  const mobileScreenshot = await capture(devtools, page, '2026-11-19-home-mobile.png');

  console.log(JSON.stringify({
    appOrigin,
    account: account.username,
    initial,
    mobile,
    screenshots: { desktopScreenshot, mobileScreenshot },
  }, null, 2));
} finally {
  devtools.close();
  child.kill();
  await delay(200);
  const resolvedProfile = resolve(profileDir);
  if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('three-chess-home-acceptance-')) {
    await rm(resolvedProfile, { recursive: true, force: true }).catch(() => undefined);
  }
}
