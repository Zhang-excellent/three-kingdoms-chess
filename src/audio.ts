import type { Game } from './game.ts';
import { musicTrack, resolveMusicSelection } from './music-catalog.ts';

export interface AudioSettings {
  musicEnabled: boolean;
  musicVolume: number;
  musicPlaylistId: string;
  musicTrackId: string;
  effectsEnabled: boolean;
  effectsVolume: number;
}

export const AUDIO_SETTINGS_KEY = 'three-kingdoms-chess:audio-v1';
export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  musicEnabled: false, musicVolume: 0.35, musicPlaylistId: 'default', musicTrackId: 'liushang-qushui',
  effectsEnabled: false, effectsVolume: 0.7,
};

const volume = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

export function loadAudioSettings(): AudioSettings {
  try {
    const value = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return { ...DEFAULT_AUDIO_SETTINGS };
    const selection = resolveMusicSelection(value.musicPlaylistId, value.musicTrackId);
    return {
      musicEnabled: value.musicEnabled === true,
      musicVolume: volume(value.musicVolume, DEFAULT_AUDIO_SETTINGS.musicVolume),
      musicPlaylistId: selection.playlistId,
      musicTrackId: selection.trackId,
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
  private musicRequest = 0;
  private loadedTrackId: string | null = null;
  private playPending: Promise<void> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly audioBase = new URL(`${import.meta.env?.BASE_URL ?? './'}audio/`, window.location.href);
  musicUrl(trackId = DEFAULT_AUDIO_SETTINGS.musicTrackId): string {
    const track = musicTrack(trackId);
    if (!track) return '';
    const url = new URL(track.file, this.audioBase);
    url.searchParams.set('v', track.cacheVersion);
    return url.href;
  }
  readonly moveUrl = new URL('move.mp3', this.audioBase).href;
  readonly captureUrl = new URL('capture.mp3', this.audioBase).href;

  async setMusic(settings: AudioSettings, fromGesture = false): Promise<string | null> {
    if (this.previewTimer) { clearTimeout(this.previewTimer); this.previewTimer = null; }
    const request = ++this.musicRequest;
    if (!settings.musicEnabled) { this.music?.pause(); this.playPending = null; this.blocked = false; return null; }
    if (!fromGesture || this.blocked) return null;
    const url = this.musicUrl(settings.musicTrackId);
    if (!url) return '所选歌曲不可用，请重新选择。';
    try {
      this.music ??= new Audio();
      if (this.loadedTrackId !== settings.musicTrackId) {
        this.music.pause();
        this.playPending = null;
        this.music.src = url;
        this.music.load();
        this.loadedTrackId = settings.musicTrackId;
        this.blocked = false;
      }
      this.music.loop = true;
      this.music.volume = settings.musicVolume;
      if (this.music.paused) {
        const pending = this.playPending ?? this.music.play();
        this.playPending = pending;
        try { await pending; } finally { if (this.playPending === pending) this.playPending = null; }
      }
      return null;
    } catch {
      if (request !== this.musicRequest) return null;
      this.blocked = true;
      return '歌曲无法播放，请换一首或关闭后重试。';
    }
  }

  async chooseMusic(settings: AudioSettings): Promise<string | null> {
    this.blocked = false;
    if (!settings.musicEnabled) return this.setMusic(settings);
    return this.setMusic(settings, true);
  }

  async previewMusic(settings: AudioSettings): Promise<string | null> {
    const operation = this.chooseMusic({ ...settings, musicEnabled: true });
    const request = this.musicRequest;
    const problem = await operation;
    if (request !== this.musicRequest || problem || settings.musicEnabled) return problem;
    this.previewTimer = setTimeout(() => {
      if (request !== this.musicRequest) return;
      this.music?.pause();
      if (this.music && this.music.readyState > 0) this.music.currentTime = 0;
      this.previewTimer = null;
    }, 10000);
    return null;
  }

  setMusicVolume(value: number) { if (this.music) this.music.volume = value; }

  dispose(): void {
    this.musicRequest++;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.music?.pause();
    this.playPending = null;
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
