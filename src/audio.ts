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
const MUSIC_DUCK_FACTOR = 0.22;
const MUSIC_DUCK_MS = 280;

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
  private context: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private blocked = false;
  private musicLevel = DEFAULT_AUDIO_SETTINGS.musicVolume;
  private ducked = false;
  private duckTimer: ReturnType<typeof setTimeout> | null = null;
  readonly musicUrl = new URL(`${import.meta.env?.BASE_URL ?? './'}audio/background.mp3`, window.location.href).href;

  private updateMusicVolume(): void {
    if (this.music) this.music.volume = this.musicLevel * (this.ducked ? MUSIC_DUCK_FACTOR : 1);
  }

  private duckMusic(): void {
    if (!this.music || this.music.paused) return;
    this.ducked = true;
    this.updateMusicVolume();
    if (this.duckTimer) clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => {
      this.duckTimer = null;
      this.ducked = false;
      this.updateMusicVolume();
    }, MUSIC_DUCK_MS);
  }

  private clearDucking(): void {
    if (this.duckTimer) clearTimeout(this.duckTimer);
    this.duckTimer = null;
    this.ducked = false;
    this.updateMusicVolume();
  }

  async setMusic(settings: AudioSettings, fromGesture = false): Promise<string | null> {
    this.musicLevel = settings.musicVolume;
    if (!settings.musicEnabled) { this.music?.pause(); this.clearDucking(); this.blocked = false; return null; }
    if (!fromGesture || this.blocked) return null;
    try {
      this.music ??= new Audio(this.musicUrl);
      this.music.loop = true;
      this.updateMusicVolume();
      await this.music.play();
      return null;
    } catch {
      this.blocked = true;
      return '背景音乐无法播放。请检查音频文件，或稍后在设置中重试。';
    }
  }

  setMusicVolume(value: number) { this.musicLevel = value; this.updateMusicVolume(); }

  dispose(): void {
    this.clearDucking();
    this.music?.pause();
    this.music = null;
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }

  playEffect(kind: 'move' | 'capture', settings: AudioSettings): void {
    if (!settings.effectsEnabled || settings.effectsVolume <= 0) return;
    try {
      this.context ??= new AudioContext();
      const context = this.context;
      void context.resume().catch(() => {});
      if (!this.noise) {
        this.noise = context.createBuffer(1, Math.floor(context.sampleRate * 0.12), context.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      const strike = (delay: number, strength: number, cutoff: number) => {
        const start = context.currentTime + delay;
        const source = context.createBufferSource(); source.buffer = this.noise;
        const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = cutoff;
        const gain = context.createGain();
        gain.gain.setValueAtTime(Math.max(0.0001, strength * settings.effectsVolume), start);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
        source.connect(filter); filter.connect(gain); gain.connect(context.destination);
        source.start(start); source.stop(start + 0.1);
      };
      strike(0, kind === 'capture' ? 0.9 : 0.68, kind === 'capture' ? 1050 : 750);
      if (kind === 'capture') strike(0.045, 0.5, 500);
      this.duckMusic();
    } catch { /* Audio failures never block a move. */ }
  }
}
