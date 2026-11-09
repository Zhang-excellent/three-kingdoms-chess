<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { passwordError, usernameError } from '../auth.ts';
import type { AuthUser } from '../auth.ts';
import type { RecentGameSummary } from '../game-history.ts';
import { PLAYERS } from '../game.ts';

const props = defineProps<{
  user: AuthUser | null;
  busy: boolean;
  error: string;
  notice: string;
  logoutBlocked: boolean;
  recentGames: RecentGameSummary[];
  recentLoading: boolean;
  recentError: string;
}>();
const emit = defineEmits<{
  login: [username: string, password: string, remember: boolean];
  register: [username: string, password: string, remember: boolean];
  changePassword: [currentPassword: string, newPassword: string];
  logout: [];
  replay: [gameId: string];
  refreshRecent: [];
  clearError: [];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const mode = ref<'login' | 'register'>('login');
const loginUsername = ref(''), loginPassword = ref(''), remember = ref(true);
const registerUsername = ref(''), registerPassword = ref('');
const currentPassword = ref(''), nextPassword = ref('');
const showLoginPassword = ref(false), showRegisterPassword = ref(false);
const showCurrentPassword = ref(false), showNextPassword = ref(false);
const settingsOpen = ref(false);
const title = computed(() => mode.value === 'register' ? '注册账号' : '登录');
const registrationUsernameError = computed(() => registerUsername.value ? usernameError(registerUsername.value) ?? '' : '');
const registrationPasswordError = computed(() => registerPassword.value ? passwordError(registerPassword.value) ?? '' : '');
const nextPasswordError = computed(() => nextPassword.value ? passwordError(nextPassword.value) ?? '' : '');

watch(() => props.user?.id, () => {
  loginPassword.value = '';
  registerPassword.value = '';
  currentPassword.value = '';
  nextPassword.value = '';
  settingsOpen.value = false;
});

function open() {
  emit('clearError');
  settingsOpen.value = false;
  if (!dialog.value?.open) dialog.value?.showModal();
  if (props.user) emit('refreshRecent');
}
function close() {
  dialog.value?.close();
}
function switchMode(next: 'login' | 'register') {
  mode.value = next;
  emit('clearError');
}
function submitLogin() {
  emit('login', loginUsername.value, loginPassword.value, remember.value);
}
function submitRegister() {
  emit('register', registerUsername.value, registerPassword.value, remember.value);
}
function submitPasswordChange() {
  emit('changePassword', currentPassword.value, nextPassword.value);
  currentPassword.value = '';
  nextPassword.value = '';
  settingsOpen.value = false;
}
function formatDate(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
const factionLabel = (faction: RecentGameSummary['faction']) => `${PLAYERS[faction].nation} · ${PLAYERS[faction].name}`;
const resultLabel = (result: RecentGameSummary['result']) =>
  result === 'won' ? '胜利' : result === 'draw' ? '和棋' : '失败';
const resultTone = (result: RecentGameSummary['result']) =>
  result === 'won' ? 'won' : result === 'draw' ? 'draw' : 'lost';
defineExpose({ open, close });
</script>

<template>
  <dialog ref="dialog" class="auth-dialog">
    <template v-if="user">
      <button type="button" class="dialog-close profile-close" aria-label="关闭个人中心" @click="close">×</button>
      <header class="profile-hero">
        <span class="profile-avatar" aria-hidden="true">{{ Array.from(user.username)[0] }}</span>
        <h2>{{ user.username }}</h2>
      </header>

      <section class="recent-section" aria-labelledby="recent-games-title">
        <div class="recent-heading"><h3 id="recent-games-title">最近对局</h3><button type="button" class="plain-button recent-refresh" :disabled="recentLoading" @click="emit('refreshRecent')">刷新</button></div>
        <p v-if="recentLoading" class="recent-state">正在读取最近对局…</p>
        <p v-else-if="recentError" class="recent-state error" role="status">{{ recentError }}</p>
        <p v-else-if="!recentGames.length" class="recent-state">完成一盘联机对局后，会在这里留下记录。</p>
        <ol v-else class="recent-list">
          <li v-for="game in recentGames.slice(0, 5)" :key="game.id">
            <div class="recent-main">
              <span class="recent-date">{{ formatDate(game.endedAt) }}</span>
              <strong>{{ factionLabel(game.faction) }}</strong>
              <span class="recent-opponents">对手：{{ game.opponents.join('、') }}</span>
              <span class="recent-steps">{{ game.moveCount }} 步</span>
            </div>
            <div class="recent-side">
              <b :class="`result-${resultTone(game.result)}`">{{ resultLabel(game.result) }}</b>
              <button type="button" class="tool-button replay-history" @click="emit('replay', game.id)">复盘</button>
            </div>
          </li>
        </ol>
      </section>

      <footer class="profile-footer">
        <p v-if="logoutBlocked" class="auth-warning">请先退出当前房间，再退出账号。</p>
        <p v-if="notice" class="auth-success" role="status">{{ notice }}</p>
        <div class="profile-actions">
          <button type="button" class="tool-button account-settings-toggle" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">{{ settingsOpen ? '收起账号设置' : '账号设置' }}</button>
          <button type="button" class="tool-button logout-button" :disabled="busy || logoutBlocked" @click="emit('logout')">退出登录</button>
        </div>
        <form v-if="settingsOpen" class="auth-form compact settings-form" @submit.prevent="submitPasswordChange">
          <h3>修改密码</h3>
          <label>当前密码<span class="password-field"><input v-model="currentPassword" :type="showCurrentPassword ? 'text' : 'password'" maxlength="64" autocomplete="current-password" required><button type="button" @click="showCurrentPassword = !showCurrentPassword">{{ showCurrentPassword ? '隐藏' : '显示' }}</button></span></label>
          <label>新密码<span class="password-field"><input v-model="nextPassword" :type="showNextPassword ? 'text' : 'password'" minlength="4" maxlength="64" autocomplete="new-password" required><button type="button" @click="showNextPassword = !showNextPassword">{{ showNextPassword ? '隐藏' : '显示' }}</button></span></label>
          <p v-if="nextPasswordError" class="auth-field-note invalid">{{ nextPasswordError }}</p>
          <button class="tool-button account-action" type="submit" :disabled="busy || !currentPassword || !nextPassword || !!nextPasswordError">保存新密码</button>
        </form>
      </footer>
    </template>

    <template v-else>
      <div class="auth-dialog-head">
        <div><span>三国象棋</span><h2>{{ title }}</h2></div>
        <button type="button" class="dialog-close" aria-label="关闭账号窗口" @click="close">×</button>
      </div>
      <div class="auth-tabs" role="tablist" aria-label="账号入口">
        <button type="button" :class="{ active: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button type="button" :class="{ active: mode === 'register' }" @click="switchMode('register')">注册</button>
      </div>

      <form v-if="mode === 'login'" class="auth-form" @submit.prevent="submitLogin">
        <label>用户名<input v-model="loginUsername" maxlength="16" autocomplete="username" required></label>
        <label>密码<span class="password-field"><input v-model="loginPassword" :type="showLoginPassword ? 'text' : 'password'" minlength="4" maxlength="64" autocomplete="current-password" required><button type="button" @click="showLoginPassword = !showLoginPassword">{{ showLoginPassword ? '隐藏' : '显示' }}</button></span></label>
        <label class="remember-option"><input v-model="remember" type="checkbox"><span>7 天免登录</span></label>
        <button class="primary-button auth-submit" type="submit" :disabled="busy || !loginUsername.trim() || !loginPassword">登录</button>
        <p class="auth-note">不勾选时登录状态最长 12 小时，关闭浏览器后会结束。</p>
      </form>

      <form v-else class="auth-form" @submit.prevent="submitRegister">
        <label>用户名<input v-model="registerUsername" maxlength="16" autocomplete="username" required></label>
        <p class="auth-field-note" :class="{ invalid: registrationUsernameError }">{{ registrationUsernameError || '2～16 个字符，可使用中文、英文字母、数字和下划线。' }}</p>
        <label>密码<span class="password-field"><input v-model="registerPassword" :type="showRegisterPassword ? 'text' : 'password'" minlength="4" maxlength="64" autocomplete="new-password" required><button type="button" @click="showRegisterPassword = !showRegisterPassword">{{ showRegisterPassword ? '隐藏' : '显示' }}</button></span></label>
        <p class="auth-field-note" :class="{ invalid: registrationPasswordError }">{{ registrationPasswordError || '4～64 个字符。' }}</p>
        <label class="remember-option"><input v-model="remember" type="checkbox"><span>7 天免登录</span></label>
        <p class="password-reminder">请记住密码，当前暂不提供找回</p>
        <button class="primary-button auth-submit" type="submit" :disabled="busy || !registerUsername.trim() || !registerPassword || !!registrationUsernameError || !!registrationPasswordError">注册并登录</button>
      </form>
    </template>

    <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
  </dialog>
</template>

<style scoped>
.auth-dialog{width:min(620px,calc(100vw - 28px));max-height:calc(100dvh - 24px);padding:0;border:1px solid #d4c3a8;border-radius:18px;background:linear-gradient(155deg,#fffef9,#faf5eb);box-shadow:0 28px 100px #2e24183d;overflow:auto;color:#43382d}
.auth-dialog::before{content:"";display:block;height:5px;background:linear-gradient(90deg,#a64b3c,#c28e55 55%,transparent)}
.auth-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:23px 24px 15px}.auth-dialog-head>div{display:grid;gap:4px}.auth-dialog-head span{font-size:10px;font-weight:700;letter-spacing:.18em;color:#9a7844}.auth-dialog-head h2{margin:0;font:700 27px/1.2 "Songti SC","SimSun",serif}.dialog-close{display:grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid transparent;border-radius:50%;background:transparent;color:#8f806c;font-size:24px;line-height:1}.dialog-close:hover{background:#f2e9db;border-color:#d9c7ac}
.auth-tabs{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin:0 24px 18px;padding:4px;border:1px solid #ddcfba;border-radius:10px;background:#eee6d8}.auth-tabs button{min-height:36px;border:0;border-radius:7px;background:transparent;color:#7a6b57;font:600 13px/1 inherit}.auth-tabs button.active{background:#fffdf8;color:#914537;box-shadow:0 1px 5px #59432318}
.auth-form{display:grid;gap:13px;padding:0 24px 24px}.auth-form.compact{gap:11px;padding:0}.auth-form label{display:grid;gap:7px;font-size:12px;font-weight:600;color:#645646}.auth-form input:not([type="checkbox"]){width:100%;height:44px;border:1px solid #d7c8b3;border-radius:8px;background:#fffefb;padding:0 12px;outline:none;color:#43382d;font:500 14px/1.2 inherit}.auth-form input:not([type="checkbox"]):focus{border-color:#a68550;box-shadow:0 0 0 3px #a7814719}.password-field{position:relative;display:block}.password-field input{padding-right:58px!important}.password-field button{position:absolute;right:5px;top:5px;height:34px;border:0;background:transparent;color:#8b6d3d;font-size:11px}
.remember-option{display:flex!important;grid-template-columns:auto 1fr;align-items:center;gap:8px!important;font-weight:500!important}.remember-option input{width:16px;height:16px;accent-color:#a64b3c}.auth-submit{min-height:44px}.auth-note,.auth-field-note{margin:-4px 0 0;font-size:10px;line-height:1.6;color:#8b7b67}.auth-field-note{margin-top:-7px}.auth-field-note.invalid{color:#a34438;font-weight:600}.password-reminder{margin:-2px 0 0;color:#8d5a42;font-size:11px}
.profile-close{position:absolute;right:18px;top:18px;z-index:2}.profile-hero{display:flex;align-items:center;gap:18px;padding:30px 30px 22px}.profile-avatar{display:grid;place-items:center;width:72px;height:76px;flex:none;border-radius:8px;background:linear-gradient(145deg,#b65747,#963f33);color:#fff8e9;font:700 40px/1 "STKaiti","KaiTi",serif;box-shadow:inset 0 0 0 3px #fff5df33,0 8px 20px #7d3c2c22;transform:rotate(-1.5deg)}.profile-hero h2{margin:0;overflow:hidden;text-overflow:ellipsis;font:700 30px/1.2 "Songti SC","SimSun",serif;color:#392f25;letter-spacing:.03em}
.recent-section{margin:0 24px;padding:18px 6px 4px;border-top:1px solid #dfd1bd}.recent-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}.recent-heading h3{margin:0;font:700 20px/1.3 "Songti SC","SimSun",serif}.recent-refresh{padding:3px;color:#8d7652;font-size:11px}.recent-state{margin:0;padding:24px 12px;border:1px dashed #d8cab7;border-radius:10px;text-align:center;color:#8a7b67;font-size:12px}.recent-state.error{color:#9a493e;background:#fbefeb}.recent-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.recent-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 13px;border:1px solid #e0d3c0;border-radius:10px;background:#fffdf8}.recent-main{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;gap:7px 11px;min-width:0}.recent-date{grid-column:1;color:#97836a;font-size:10px}.recent-main strong{grid-column:2;color:#5e4e3d;font-size:12px}.recent-opponents{grid-column:3;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#756754;font-size:11px}.recent-steps{grid-column:4;color:#958670;font-size:10px}.recent-side{display:flex;align-items:center;gap:8px}.recent-side b{min-width:38px;padding:3px 8px;border-radius:999px;text-align:center;font-size:10px}.result-won{background:#f4e3dc;color:#9b4337}.result-draw{background:#eee8da;color:#75613e}.result-lost{background:#e9ece8;color:#655f55}.replay-history{min-height:32px;padding:5px 10px;border-color:#d0b996;color:#884b36;background:#fbf2e4}
.profile-footer{margin:18px 24px 0;padding:16px 6px 22px;border-top:1px solid #dfd1bd}.profile-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.account-settings-toggle,.logout-button{min-height:38px;padding:8px 14px}.account-settings-toggle{border-color:#d4c3aa;background:#f8f1e5;color:#715c40}.logout-button{border-color:#ddc4ba;color:#914537}.settings-form{margin-top:14px;padding:16px;border:1px solid #dfd1bd;border-radius:11px;background:#fdf8ef}.settings-form h3{margin:0 0 2px;font:700 17px/1.3 "Songti SC","SimSun",serif}.account-action{justify-content:center;width:100%;min-height:40px;border-color:#d1bea2;background:#f6eddd}.auth-warning{margin:0 0 10px;padding:9px 11px;border-left:3px solid #b37a43;border-radius:0 7px 7px 0;background:#f8edda;color:#795a36;font-size:11px;line-height:1.65}.auth-success{margin:0 0 10px;color:#42705a;font-size:11px}.auth-error{margin:0 24px 18px;padding:10px 11px;border-left:3px solid #a34438;border-radius:0 7px 7px 0;background:#f9eae5;color:#8f4237;font-size:11px;line-height:1.6}
@media(max-width:560px){.auth-dialog{width:calc(100vw - 20px);max-height:calc(100dvh - 16px)}.auth-dialog-head{padding:20px 18px 13px}.auth-tabs{margin:0 18px 16px}.auth-form{padding:0 18px 20px}.profile-hero{padding:27px 20px 19px;gap:14px}.profile-avatar{width:62px;height:66px;font-size:34px}.profile-hero h2{font-size:25px}.recent-section{margin:0 16px}.recent-list li{grid-template-columns:1fr;gap:9px;padding:11px}.recent-main{grid-template-columns:auto auto minmax(0,1fr)}.recent-steps{grid-column:1 / -1}.recent-side{justify-content:space-between}.profile-footer{margin:16px 16px 0;padding:14px 0 18px}.profile-actions{display:grid;grid-template-columns:1fr 1fr}.account-settings-toggle,.logout-button{justify-content:center;width:100%}.settings-form{padding:14px}.auth-warning,.auth-success,.auth-error{margin-left:18px;margin-right:18px}}
</style>
