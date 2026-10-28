import type { Game } from './game.ts';

export interface AudioSettings {
  musicEnabled: boolean;
  musicVolume: number;
  effectsEnabled: boolean;
  effectsVolume: number;
}

export const AUDIO_SETTINGS_KEY = 'three-kingdoms-chess:audio-v1';
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  musicEnabled: false, musicVolume: 0.35, effectsEnabled: false, effectsVolume: 0.7,
};

const volume = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

export function loadAudioSettings(): AudioSettings {
  try {
    const value = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return { ...DEFAULT_AUDIO_SETTINGS };
    return {
      musicEnabled: value.musicEnabled === true,
      musicVolume: volume(value.musicVolume, DEFAULT_AUDIO_SETTINGS.musicVolume),
      effectsEnabled: value.effectsEnabled === true,
      effectsVolume: volume(value.effectsVolume, DEFAULT_AUDIO_SETTINGS.effectsVolume),
    };
  } catch { return { ...DEFAULT_AUDIO_SETTINGS }; }
}

/** Observe authoritative history only; initial snapshots, reconnects, undo and new rounds stay silent. */
export class MoveSoundTracker {
  private scope = '';
  private count = 0;
  private live = false;
  observe(game: Game, scope: string, live: boolean): 'move' | 'capture' | null {
    const previousCount = this.count, previousLive = this.live, sameScope = this.scope === scope;
    this.scope = scope; this.count = game.history.length; this.live = live;
    if (!sameScope || !previousLive || !live || game.history.length !== previousCount + 1) return null;
    const last = game.lastMove;
    return last?.number === game.history.length ? (last.captured ? 'capture' : 'move') : null;
  }
}

export class GameAudio {
  private music: HTMLAudioElement | null = null;
  private moveSound: HTMLAudioElement | null = null;
  private captureSound: HTMLAudioElement | null = null;
  private blocked = false;
  private readonly audioBase = new URL(`${import.meta.env?.BASE_URL ?? './'}audio/`, window.location.href);
  readonly musicUrl = new URL('background.mp3', this.audioBase).href;
  readonly moveUrl = new URL('move.mp3', this.audioBase).href;
  readonly captureUrl = new URL('capture.mp3', this.audioBase).href;

  async setMusic(settings: AudioSettings, fromGesture = false): Promise<string | null> {
    if (!settings.musicEnabled) { this.music?.pause(); this.blocked = false; return null; }
    if (!fromGesture || this.blocked) return null;
    try {
      this.music ??= new Audio(this.musicUrl);
      this.music.loop = true;
      this.music.volume = settings.musicVolume;
      await this.music.play();
      return null;
    } catch {
      this.blocked = true;
      return '背景音乐无法播放。请检查音频文件，或稍后在设置中重试。';
    }
  }

  setMusicVolume(value: number) { if (this.music) this.music.volume = value; }

  dispose(): void {
    this.music?.pause();
    this.moveSound?.pause();
    this.captureSound?.pause();
    this.music = null;
    this.moveSound = null;
    this.captureSound = null;
  }

  playEffect(kind: 'move' | 'capture', settings: AudioSettings): void {
    if (!settings.effectsEnabled || settings.effectsVolume <= 0) return;
    try {
      const effect = kind === 'move'
        ? (this.moveSound ??= new Audio(this.moveUrl))
        : (this.captureSound ??= new Audio(this.captureUrl));
      effect.volume = settings.effectsVolume;
      if (effect.readyState > 0) effect.currentTime = 0;
      void effect.play().catch(() => {});
    } catch { /* Audio failures never block a move. */ }
  }
}
