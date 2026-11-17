import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = join(root, 'docs', '验收截图');
const appUrl = process.env.THREE_CHESS_ACCEPTANCE_URL ?? 'http://localhost:5173/?mode=chinese-chess';
const stage = message => console.error(`[Chinese acceptance] ${message}`);
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error('找不到可用的 Chrome 或 Edge。');

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const profileDir = await mkdtemp(join(tmpdir(), 'three-chess-chinese-acceptance-'));
await mkdir(screenshotDir, { recursive: true });

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
      const listeners = this.events.get(message.method) ?? [];
      for (const listener of listeners) listener(message.params, message.sessionId);
    });
    this.socket.on('close', (code, reason) => {
      const error = new Error(`Chrome DevTools 连接已关闭（${code}${reason?.length ? `: ${reason}` : ''}）。`);
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
  stage('启动独立 Chrome 配置');
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
  stage(`连接 DevTools：${endpoint.replace(/^ws:\/\/([^/]+).*$/, '$1')}`);
  const devtools = new DevTools(endpoint);
  await devtools.connect();
  return { child, devtools };
}

async function createPage(devtools, size) {
  stage('创建独立浏览器上下文');
  const { browserContextId } = await devtools.send('Target.createBrowserContext', { disposeOnDetach: false });
  stage('创建页面目标');
  const { targetId } = await devtools.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  stage('附加页面调试会话');
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
  stage('加载中国象棋页面');
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
    const description = response.exceptionDetails.exception?.description
      ?? response.exceptionDetails.text
      ?? '浏览器脚本执行失败。';
    throw new Error(description);
  }
  return response.result.value;
}

async function waitFor(devtools, page, expression, label, timeoutMs = 10_000) {
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
    const element = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
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
  const rect = await elementRect(devtools, page, selector, index);
  await clickRect(devtools, page, rect, label);
}

async function clickButton(devtools, page, text) {
  const rect = await buttonRect(devtools, page, text);
  await clickRect(devtools, page, rect, text);
}

async function fillSeatDialog(devtools, page, nickname) {
  await waitFor(devtools, page, `document.querySelector('.chinese-seat-dialog')?.open === true`, '昵称入座弹窗');
  await clickSelector(devtools, page, '.chinese-seat-dialog input', '昵称输入框');
  await devtools.send('Input.insertText', { text: nickname }, page.sessionId);
  await clickButton(devtools, page, '入座');
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
  const variants = fullPage
    ? [
        { captureBeyondViewport: true, clip },
        { captureBeyondViewport: false, clip },
        { captureBeyondViewport: false },
      ]
    : [{ captureBeyondViewport: false }];
  let shot;
  for (const variant of variants) {
    const candidate = await devtools.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      ...variant,
    }, page.sessionId);
    const bytes = Buffer.from(candidate.data, 'base64');
    shot = { ...candidate, bytes };
    if (bytes.readUInt32BE(16) === page.size.width) break;
  }
  if (!shot || shot.bytes.readUInt32BE(16) !== page.size.width) {
    throw new Error(`截图宽度与目标视口 ${page.size.width}px 不一致。`);
  }
  const target = join(screenshotDir, fileName);
  await writeFile(target, shot.bytes);
  return target;
}

async function main() {
  const { child, devtools } = await launchChrome();
  let result;
  try {
    const red = await createPage(devtools, { width: 1440, height: 1000 });
    stage('检查桌面空桌');
    await waitFor(devtools, red, `document.querySelector('.chinese-page[data-connection="online"]') !== null`, '红方页面连接');
    await waitFor(devtools, red, `document.querySelector('.game-table-seat.red') && !document.querySelector('.game-table-seat.red').disabled`, '红方棋桌席位');

    const emptyScreenshot = await capture(devtools, red, '中国象棋-棋桌-空桌.png');
    const desktopMetrics = await evaluate(devtools, red, `(() => {
      const table = document.querySelector('.game-table-center').getBoundingClientRect();
      return {
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        tableWidth: table.width,
        tableLeft: table.left,
        seats: [...document.querySelectorAll('.game-table-seat')].map(element => element.getBoundingClientRect().width),
      };
    })()`);

    const accountName = `头像验收${Date.now().toString().slice(-6)}`;
    const registration = await evaluate(devtools, red, `fetch('/three-chess/api/auth/register', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(accountName)}, password: '1234', remember: true }),
    }).then(response => response.json())`);
    if (!registration.ok) throw new Error(`头像验收账号注册失败：${registration.error}`);
    await devtools.send('Page.reload', {}, red.sessionId);
    await waitFor(devtools, red, `document.querySelector('.account-button')?.textContent.includes(${JSON.stringify(accountName)})`, '账号登录状态');
    await clickSelector(devtools, red, '.account-button', '个人中心');
    await waitFor(devtools, red, `document.querySelector('.auth-dialog')?.open === true`, '个人中心弹窗');
    await devtools.send('DOM.enable', {}, red.sessionId);
    const documentRoot = await devtools.send('DOM.getDocument', {}, red.sessionId);
    const avatarInput = await devtools.send('DOM.querySelector', {
      nodeId: documentRoot.root.nodeId, selector: '.avatar-file-input',
    }, red.sessionId);
    await devtools.send('DOM.setFileInputFiles', {
      nodeId: avatarInput.nodeId, files: [join(root, 'tests', 'fixtures', 'account-avatar.png')],
    }, red.sessionId);
    await waitFor(devtools, red, `document.querySelector('.profile-avatar img')?.src.includes('/three-chess/api/avatar/')`, '头像上传完成');
    const avatarScreenshot = await capture(devtools, red, '账号-上传头像.png');
    await clickSelector(devtools, red, '.profile-close', '关闭个人中心');

    await clickSelector(devtools, red, '.game-table-seat.red', '红方棋桌头像');
    stage('红方通过头像入座');
    await waitFor(devtools, red, `document.querySelectorAll('.chinese-piece').length === 32 && document.querySelector('.self-seat .chinese-seat-copy strong')?.textContent.includes(${JSON.stringify(accountName)})`, '红方入座');
    await waitFor(devtools, red, `document.querySelector('.self-seat img')?.src.includes('/three-chess/api/avatar/')`, '对局头像使用上传图片');
    await clickButton(devtools, red, '开始');
    await waitFor(devtools, red, `document.querySelector('.self-seat')?.classList.contains('ready')`, '红方准备');
    const waitingScreenshot = await capture(devtools, red, '中国象棋-等待开局.png');

    const black = await createPage(devtools, { width: 1440, height: 1000 });
    stage('黑方打开同一棋桌');
    await waitFor(devtools, black, `document.querySelector('.chinese-page[data-connection="online"]') !== null`, '黑方页面连接');
    await waitFor(devtools, black, `document.querySelector('.game-table-seat.red')?.textContent.includes(${JSON.stringify(accountName)})`, '黑方看到红方席位');
    await clickSelector(devtools, black, '.game-table-seat.black', '黑方棋桌头像');
    await fillSeatDialog(devtools, black, '中国象棋黑游客');
    await waitFor(devtools, black, `document.querySelector('.self-seat.black .chinese-seat-copy strong')?.textContent.includes('中国象棋黑游客')`, '黑方入座');
    await clickButton(devtools, black, '开始');
    stage('双方准备并开始对局');
    await waitFor(devtools, red, `document.querySelector('.chinese-board-heading h2')?.textContent.includes(${JSON.stringify(`轮到 ${accountName} 行棋`)})`, '双方准备后开局');

    await clickSelector(devtools, red, '.chinese-piece[aria-label="红方兵，1 路第 7 线"]', '红方一路兵');
    await waitFor(devtools, red, `document.querySelector('.chinese-target') !== null`, '红方合法落点');
    await clickSelector(devtools, red, '.chinese-target[aria-label="走到第1路第6线"]', '红方一路兵落点');
    await waitFor(devtools, black, `document.querySelector('.chinese-history')?.textContent.includes('(1, 6)')`, '黑方收到实时走子');
    const playingScreenshot = await capture(devtools, red, '中国象棋-桌面-对局.png');

    const visitor = await createPage(devtools, { width: 1440, height: 1000 });
    stage('访客只读验收');
    await waitFor(devtools, visitor, `document.querySelector('.chinese-page[data-connection="online"]') !== null`, '访客页面连接');
    await waitFor(devtools, visitor, `document.querySelector('.game-table-center')?.classList.contains('active')`, '访客棋桌状态');
    const activeTableScreenshot = await capture(devtools, visitor, '中国象棋-棋桌-进行中.png');
    await clickSelector(devtools, visitor, '.game-table-center', '中间棋桌观战');
    await waitFor(devtools, visitor, `document.querySelector('.chinese-history')?.textContent.includes('(1, 6)')`, '访客只读局面');
    const visitorAudit = await evaluate(devtools, visitor, `(() => ({
      pieces: document.querySelectorAll('.chinese-piece').length,
      history: document.querySelector('.chinese-history')?.textContent.includes('(1, 6)') ?? false,
      playerActions: [...document.querySelectorAll('button')]
        .map(button => button.textContent.trim())
        .filter(text => ['准备', '认输', '再来一局', '退出房间'].includes(text)),
    }))()`);
    const visitorScreenshot = await capture(devtools, visitor, '中国象棋-桌面-观战.png');

    await clickSelector(devtools, red, '.game-action-menu-toggle', '左侧对局菜单');
    const menuScreenshot = await capture(devtools, red, '中国象棋-对局菜单.png');
    await clickButton(devtools, red, '提和');
    await waitFor(devtools, black, `document.querySelector('.draw-offer-bar') !== null`, '黑方收到提和');
    await clickButton(devtools, black, '同意');
    stage('和棋终局与再来一局');
    await waitFor(devtools, black, `document.querySelector('.result-banner')?.textContent.includes('双方同意和棋')`, '和棋终局结果');
    const finishedScreenshot = await capture(devtools, black, '中国象棋-桌面-终局.png');

    await clickButton(devtools, black, '再来一局');
    await waitFor(devtools, black, `!document.querySelector('.result-banner') && document.querySelector('.game-board-waiting-card') !== null`, '同房间再来一局');
    const rematchAudit = await evaluate(devtools, black, `(() => ({
      pieces: document.querySelectorAll('.chinese-piece').length,
      players: [...document.querySelectorAll('.chinese-seat-copy strong')].map(element => element.textContent.trim()),
      readySeats: document.querySelectorAll('.chinese-table-seat.ready').length,
      prepareButtons: [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === '开始').length,
    }))()`);
    await clickButton(devtools, red, '开始');
    await clickButton(devtools, black, '开始');
    await waitFor(devtools, black, `document.querySelector('.chinese-board-heading h2')?.textContent.includes(${JSON.stringify(`轮到 ${accountName} 行棋`)})`, '第二局开局');

    await clickSelector(devtools, red, '.chinese-page-nav button', '返回其他玩法');
    stage('验证主动导航释放席位');
    await waitFor(devtools, red, `new URL(location.href).searchParams.get('mode') === 'other'`, '返回其他玩法');
    await waitFor(devtools, black, `document.querySelector('.result-banner') !== null && document.querySelector('.opponent-seat')?.textContent.includes('等待棋友')`, '主动离开释放席位');

    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    }, visitor.sessionId);
    visitor.size = { width: 390, height: 844, mobile: true };
    await waitFor(devtools, visitor, `innerWidth === 390`, '手机视口');
    const mobileMetrics = await evaluate(devtools, visitor, `(() => {
      const board = document.querySelector('.chinese-board-frame').getBoundingClientRect();
      return {
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        boardWidth: board.width,
        seatWidths: [...document.querySelectorAll('.chinese-table-seat')].map(element => element.getBoundingClientRect().width),
        actionWidths: [...document.querySelectorAll('.chinese-table-actions button')].map(element => element.getBoundingClientRect().width),
      };
    })()`);
    const mobileScreenshot = await capture(devtools, visitor, '中国象棋-手机-观战.png');
    stage('手机视口验收');

    result = {
      desktopMetrics,
      mobileMetrics,
      visitorAudit,
      rematchAudit,
      screenshots: {
        emptyScreenshot,
        avatarScreenshot,
        waitingScreenshot,
        menuScreenshot,
        activeTableScreenshot,
        playingScreenshot,
        visitorScreenshot,
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
    if (resolvedProfile.startsWith(resolve(tmpdir()) + '\\') && resolvedProfile.includes('three-chess-chinese-acceptance-')) {
      try {
        await rm(resolvedProfile, { recursive: true, force: true });
      } catch (error) {
        stage(`临时浏览器目录稍后由系统清理：${error.code ?? error.message}`);
      }
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
