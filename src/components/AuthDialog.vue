<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { passwordError, usernameError } from '../auth.ts';
import type { AuthUser } from '../auth.ts';

const props = defineProps<{
  user: AuthUser | null;
  busy: boolean;
  error: string;
  recoveryCode: string;
  notice: string;
  logoutBlocked: boolean;
}>();
const emit = defineEmits<{
  login: [username: string, password: string, remember: boolean];
  register: [username: string, password: string, remember: boolean];
  reset: [username: string, recoveryCode: string, newPassword: string, remember: boolean];
  changePassword: [currentPassword: string, newPassword: string];
  regenerateRecovery: [password: string];
  logout: [];
  clearError: [];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const mode = ref<'login' | 'register' | 'recover'>('login');
const loginUsername = ref(''), loginPassword = ref(''), remember = ref(true);
const registerUsername = ref(''), registerPassword = ref('');
const recoveryUsername = ref(''), recoveryCodeInput = ref(''), recoveryPassword = ref('');
const currentPassword = ref(''), nextPassword = ref(''), recoveryPasswordCheck = ref('');
const showLoginPassword = ref(false), showRegisterPassword = ref(false);
const showRecoveryPassword = ref(false), showCurrentPassword = ref(false), showNextPassword = ref(false);
const showRecoveryCheck = ref(false);
const savedFeedback = ref('');
const title = computed(() => props.user ? '我的账号' : mode.value === 'register' ? '注册账号' : mode.value === 'recover' ? '找回密码' : '登录');
const registrationUsernameError = computed(() => registerUsername.value ? usernameError(registerUsername.value) ?? '' : '');
const registrationPasswordError = computed(() => registerPassword.value ? passwordError(registerPassword.value) ?? '' : '');
const recoveryPasswordError = computed(() => recoveryPassword.value ? passwordError(recoveryPassword.value) ?? '' : '');
const nextPasswordValidationError = computed(() => nextPassword.value ? passwordError(nextPassword.value) ?? '' : '');

watch(() => props.user?.id, () => {
  loginPassword.value = ''; registerPassword.value = ''; recoveryCodeInput.value = ''; recoveryPassword.value = '';
  currentPassword.value = ''; nextPassword.value = ''; recoveryPasswordCheck.value = '';
});

function open() {
  emit('clearError');
  if (!dialog.value?.open) dialog.value?.showModal();
}
function close() {
  dialog.value?.close();
}
function switchMode(next: 'login' | 'register' | 'recover') {
  mode.value = next;
  emit('clearError');
}
function submitLogin() {
  emit('login', loginUsername.value, loginPassword.value, remember.value);
}
function submitRegister() {
  emit('register', registerUsername.value, registerPassword.value, remember.value);
}
function submitRecovery() {
  emit('reset', recoveryUsername.value, recoveryCodeInput.value, recoveryPassword.value, remember.value);
}
function submitPasswordChange() {
  emit('changePassword', currentPassword.value, nextPassword.value);
}
function submitRecoveryRegeneration() {
  emit('regenerateRecovery', recoveryPasswordCheck.value);
}
async function copyRecovery() {
  if (!props.recoveryCode) return;
  try {
    await navigator.clipboard.writeText(props.recoveryCode);
    savedFeedback.value = '恢复码已复制。';
  } catch {
    const input = document.createElement('textarea');
    input.value = props.recoveryCode; input.style.position = 'fixed'; input.style.left = '-9999px';
    document.body.append(input); input.select();
    const copied = document.execCommand('copy');
    input.remove();
    savedFeedback.value = copied ? '恢复码已复制。' : '浏览器无法自动复制，请手动选择恢复码。';
  }
}
function downloadRecovery() {
  if (!props.recoveryCode || !props.user) return;
  const content = [
    '三国象棋账号恢复码', '',
    `昵称：${props.user.username}`,
    `恢复码：${props.recoveryCode}`, '',
    '请离线妥善保存。恢复码使用一次后立即失效，并会生成新的恢复码。',
    '',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `三国象棋恢复码-${props.user.username}.txt`; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  savedFeedback.value = '恢复码文件已生成。';
}
defineExpose({ open, close });
</script>

<template>
  <dialog ref="dialog" class="auth-dialog" @close="savedFeedback = ''">
    <div class="auth-dialog-head">
      <div><span>{{ user ? '账号' : '三国象棋' }}</span><h2>{{ title }}</h2></div>
      <button type="button" class="dialog-close" aria-label="关闭账号窗口" @click="close">×</button>
    </div>

    <template v-if="!user">
      <div class="auth-tabs" role="tablist" aria-label="账号入口">
        <button type="button" :class="{ active: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button type="button" :class="{ active: mode === 'register' }" @click="switchMode('register')">注册</button>
        <button type="button" :class="{ active: mode === 'recover' }" @click="switchMode('recover')">找回密码</button>
      </div>

      <form v-if="mode === 'login'" class="auth-form" @submit.prevent="submitLogin">
        <label>用户名<input v-model="loginUsername" maxlength="16" autocomplete="username" required></label>
        <label>密码<span class="password-field"><input v-model="loginPassword" :type="showLoginPassword ? 'text' : 'password'" minlength="4" maxlength="64" autocomplete="current-password" required><button type="button" @click="showLoginPassword = !showLoginPassword">{{ showLoginPassword ? '隐藏' : '显示' }}</button></span></label>
        <label class="remember-option"><input v-model="remember" type="checkbox"><span>7 天免登录</span></label>
        <button class="primary-button auth-submit" type="submit" :disabled="busy || !loginUsername.trim() || !loginPassword">登录</button>
        <p class="auth-note">不勾选时登录状态最长 12 小时，关闭浏览器后会结束。</p>
      </form>

      <form v-else-if="mode === 'register'" class="auth-form" @submit.prevent="submitRegister">
        <label>用户名<input v-model="registerUsername" maxlength="16" autocomplete="username" required></label>
        <p class="auth-field-note" :class="{ invalid: registrationUsernameError }">{{ registrationUsernameError || '2～16 个字符，可使用中文、英文字母、数字和下划线。' }}</p>
        <label>密码<span class="password-field"><input v-model="registerPassword" :type="showRegisterPassword ? 'text' : 'password'" minlength="4" maxlength="64" autocomplete="new-password" required><button type="button" @click="showRegisterPassword = !showRegisterPassword">{{ showRegisterPassword ? '隐藏' : '显示' }}</button></span></label>
        <p class="auth-field-note" :class="{ invalid: registrationPasswordError }">{{ registrationPasswordError || '4～64 个字符。' }}</p>
        <label class="remember-option"><input v-model="remember" type="checkbox"><span>7 天免登录</span></label>
        <button class="primary-button auth-submit" type="submit" :disabled="busy || !registerUsername.trim() || !registerPassword || !!registrationUsernameError || !!registrationPasswordError">注册并登录</button>
      </form>

      <form v-else class="auth-form" @submit.prevent="submitRecovery">
        <label>用户名<input v-model="recoveryUsername" maxlength="16" autocomplete="username" required></label>
        <label>恢复码<input v-model="recoveryCodeInput" autocomplete="off" spellcheck="false" placeholder="TK-XXXX-XXXX-…" required></label>
        <label>新密码<span class="password-field"><input v-model="recoveryPassword" :type="showRecoveryPassword ? 'text' : 'password'" minlength="4" maxlength="64" autocomplete="new-password" required><button type="button" @click="showRecoveryPassword = !showRecoveryPassword">{{ showRecoveryPassword ? '隐藏' : '显示' }}</button></span></label>
        <p v-if="recoveryPasswordError" class="auth-field-note invalid">{{ recoveryPasswordError }}</p>
        <label class="remember-option"><input v-model="remember" type="checkbox"><span>7 天免登录</span></label>
        <button class="primary-button auth-submit" type="submit" :disabled="busy || !recoveryUsername.trim() || !recoveryCodeInput.trim() || !recoveryPassword || !!recoveryPasswordError">重设密码</button>
      </form>
    </template>

    <template v-else>
      <section class="account-summary">
        <span class="account-seal">{{ Array.from(user.username)[0] }}</span>
        <div><span>当前账号</span><strong>{{ user.username }}</strong><small>固定用户 ID：{{ user.id }}</small></div>
      </section>

      <section v-if="recoveryCode" class="recovery-card" aria-live="polite">
        <div><span>新的账号恢复码</span><strong>{{ recoveryCode }}</strong><p>请现在复制或下载保存。旧恢复码已经失效，新的恢复码只会完整显示这一次。</p></div>
        <div class="recovery-actions"><button type="button" class="tool-button" @click="copyRecovery">复制</button><button type="button" class="tool-button" @click="downloadRecovery">下载保存</button></div>
      </section>
      <p v-if="savedFeedback" class="auth-success" role="status">{{ savedFeedback }}</p>

      <section class="account-section">
        <h3>修改密码</h3>
        <form class="auth-form compact" @submit.prevent="submitPasswordChange">
          <label>当前密码<span class="password-field"><input v-model="currentPassword" :type="showCurrentPassword ? 'text' : 'password'" maxlength="64" autocomplete="current-password" required><button type="button" @click="showCurrentPassword = !showCurrentPassword">{{ showCurrentPassword ? '隐藏' : '显示' }}</button></span></label>
          <label>新密码<span class="password-field"><input v-model="nextPassword" :type="showNextPassword ? 'text' : 'password'" minlength="4" maxlength="64" autocomplete="new-password" required><button type="button" @click="showNextPassword = !showNextPassword">{{ showNextPassword ? '隐藏' : '显示' }}</button></span></label>
          <p v-if="nextPasswordValidationError" class="auth-field-note invalid">{{ nextPasswordValidationError }}</p>
          <button class="tool-button account-action" type="submit" :disabled="busy || !currentPassword || !nextPassword || !!nextPasswordValidationError">保存新密码</button>
        </form>
      </section>

      <section class="account-section">
        <h3>恢复码管理</h3>
        <form class="auth-form compact" @submit.prevent="submitRecoveryRegeneration">
          <label>当前密码<span class="password-field"><input v-model="recoveryPasswordCheck" :type="showRecoveryCheck ? 'text' : 'password'" maxlength="64" autocomplete="current-password" required><button type="button" @click="showRecoveryCheck = !showRecoveryCheck">{{ showRecoveryCheck ? '隐藏' : '显示' }}</button></span></label>
          <button class="tool-button account-action" type="submit" :disabled="busy || !recoveryPasswordCheck">重新生成恢复码</button>
        </form>
      </section>

      <p v-if="logoutBlocked" class="auth-warning">你正以账号身份坐在房间中。请先退出房间，再退出账号。</p>
      <p v-if="notice" class="auth-success" role="status">{{ notice }}</p>
      <button type="button" class="tool-button logout-button" :disabled="busy || logoutBlocked" @click="emit('logout')">退出登录</button>
    </template>

    <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
  </dialog>
</template>

<style scoped>
.auth-dialog{width:min(500px,calc(100vw - 28px));max-height:calc(100dvh - 28px);padding:0;border:1px solid #d4c3a8;border-radius:16px;background:linear-gradient(155deg,#fffef9,#faf5eb);box-shadow:0 28px 100px #2e24183d;overflow:auto;color:#43382d}
.auth-dialog::before{content:"";display:block;height:5px;background:linear-gradient(90deg,#a64b3c,#c28e55 55%,transparent)}
.auth-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:23px 24px 15px}.auth-dialog-head>div{display:grid;gap:4px}.auth-dialog-head span{font-size:10px;font-weight:700;letter-spacing:.18em;color:#9a7844}.auth-dialog-head h2{margin:0;font:700 27px/1.2 "Songti SC","SimSun",serif}.dialog-close{display:grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid transparent;border-radius:50%;background:transparent;color:#8f806c;font-size:24px;line-height:1}.dialog-close:hover{background:#f2e9db;border-color:#d9c7ac}
.auth-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:0 24px 18px;padding:4px;border:1px solid #ddcfba;border-radius:10px;background:#eee6d8}.auth-tabs button{min-height:34px;border:0;border-radius:7px;background:transparent;color:#7a6b57;font:600 12px/1 inherit}.auth-tabs button.active{background:#fffdf8;color:#914537;box-shadow:0 1px 5px #59432318}
.auth-form{display:grid;gap:13px;padding:0 24px 24px}.auth-form.compact{gap:10px;padding:0}.auth-form label{display:grid;gap:7px;font-size:12px;font-weight:600;color:#645646}.auth-form input:not([type="checkbox"]){width:100%;height:44px;border:1px solid #d7c8b3;border-radius:8px;background:#fffefb;padding:0 12px;outline:none;color:#43382d;font:500 14px/1.2 inherit}.auth-form input:not([type="checkbox"]):focus{border-color:#a68550;box-shadow:0 0 0 3px #a7814719}.password-field{position:relative;display:block}.password-field input{padding-right:58px!important}.password-field button{position:absolute;right:5px;top:5px;height:34px;border:0;background:transparent;color:#8b6d3d;font-size:11px}
.remember-option{display:flex!important;grid-template-columns:auto 1fr;align-items:center;gap:8px!important;font-weight:500!important}.remember-option input{width:16px;height:16px;accent-color:#a64b3c}.auth-submit{min-height:44px}.auth-note,.auth-field-note{margin:-4px 0 0;font-size:10px;line-height:1.6;color:#8b7b67}.auth-field-note{margin-top:-7px}.auth-field-note.invalid{color:#a34438;font-weight:600}
.account-summary{display:flex;align-items:center;gap:13px;margin:0 24px 20px;padding:15px;border:1px solid #ded0bb;border-radius:11px;background:#fffdf8}.account-seal{display:grid;place-items:center;width:44px;height:48px;border-radius:5px;background:#a64b3c;color:#fff7e7;font:700 24px/1 "STKaiti","KaiTi",serif;transform:rotate(-2deg)}.account-summary>div{display:grid;gap:2px;min-width:0}.account-summary span{font-size:10px;color:#917c60}.account-summary strong{font:700 21px/1.25 "Songti SC","SimSun",serif}.account-summary small{overflow:hidden;text-overflow:ellipsis;color:#988a77;font-size:9px}
.recovery-card{display:grid;gap:12px;margin:0 24px 18px;padding:14px;border:1px solid #d7bd8d;border-radius:10px;background:#fbf1df}.recovery-card div:first-child{display:grid;gap:5px}.recovery-card span{font-size:10px;color:#846c49}.recovery-card strong{word-break:break-all;font:700 14px/1.55 ui-monospace,Consolas,monospace;color:#704d2c}.recovery-card p{margin:0;font-size:10px;line-height:1.6;color:#806d54}.recovery-actions{display:flex;gap:7px}.recovery-actions button{flex:1}
.account-section{margin:0 24px;padding:17px 0;border-top:1px solid #e4d8c7}.account-section h3{margin:0 0 11px;font:700 16px/1.3 "Songti SC","SimSun",serif}.account-action{justify-content:center;width:100%;min-height:40px;border-color:#d1bea2;background:#f7f0e3}.logout-button{width:calc(100% - 48px);justify-content:center;margin:18px 24px 24px;border-color:#d8b8ad;color:#914537}.auth-warning{margin:14px 24px 0;padding:10px 11px;border-left:3px solid #b37a43;border-radius:0 7px 7px 0;background:#f8edda;color:#795a36;font-size:11px;line-height:1.65}.auth-success{margin:0 24px 14px;color:#42705a;font-size:11px}.auth-error{margin:0 24px 18px;padding:10px 11px;border-left:3px solid #a34438;border-radius:0 7px 7px 0;background:#f9eae5;color:#8f4237;font-size:11px;line-height:1.6}
@media(max-width:560px){.auth-dialog{width:calc(100vw - 20px);max-height:calc(100dvh - 16px)}.auth-dialog-head{padding:20px 18px 13px}.auth-tabs{margin:0 18px 16px}.auth-form{padding:0 18px 20px}.account-summary,.recovery-card{margin-left:18px;margin-right:18px}.account-section{margin-left:18px;margin-right:18px}.logout-button{width:calc(100% - 36px);margin-left:18px;margin-right:18px}.auth-warning,.auth-success,.auth-error{margin-left:18px;margin-right:18px}}
</style>
