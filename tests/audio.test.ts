import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS, GameAudio, MoveSoundTracker, loadAudioSettings } from '../src/audio.ts';
import { MUSIC_PLAYLISTS, MUSIC_TRACKS, availablePlaylists, resolveMusicSelection, tracksInPlaylist } from '../src/music-catalog.ts';
import { newGame, playMove } from '../src/game.ts';

test('sound settings default off, persist independent levels and reject malformed values', () => {
  GlobalRegistrator.register({ url: 'http://localhost:5173' });
  try {
    localStorage.clear();
    assert.deepEqual(loadAudioSettings(), DEFAULT_AUDIO_SETTINGS);
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ musicEnabled: true, musicVolume: 0.2, effectsEnabled: false, effectsVolume: 0.8 }));
    assert.deepEqual(loadAudioSettings(), { musicEnabled: true, musicVolume: 0.2, musicPlaylistId: 'default', musicTrackId: 'liushang-qushui', effectsEnabled: false, effectsVolume: 0.8 });
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ musicEnabled: true, musicVolume: 30, effectsEnabled: true, effectsVolume: -5 }));
    assert.deepEqual(loadAudioSettings(), { musicEnabled: true, musicVolume: 1, musicPlaylistId: 'default', musicTrackId: 'liushang-qushui', effectsEnabled: true, effectsVolume: 0 });
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ musicPlaylistId: 'guitar', musicTrackId: 'lebang-zhanshi-guitar' }));
    assert.equal(loadAudioSettings().musicTrackId, 'lebang-zhanshi-guitar');
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ musicPlaylistId: 'guitar', musicTrackId: 'removed-song' }));
    assert.equal(loadAudioSettings().musicTrackId, 'lebang-zhanshi-guitar');
  } finally { GlobalRegistrator.unregister(); }
});

test('catalogue supports several playlists and songs and falls back from deleted IDs', () => {
  assert.deepEqual(MUSIC_PLAYLISTS.map(item => item.id), ['default', 'guitar']);
  assert.deepEqual(MUSIC_TRACKS.map(item => item.name), ['流觞曲水', '乐邦詹士（吉他）']);
  const tracks = [...MUSIC_TRACKS, { id: 'another', name: '另一首', file: 'another.mp3', cacheVersion: 'abc', playlistId: 'guitar' }];
  assert.deepEqual(tracksInPlaylist('guitar', tracks).map(item => item.id), ['lebang-zhanshi-guitar', 'another']);
  assert.equal(availablePlaylists(MUSIC_PLAYLISTS, tracks).length, 2);
  assert.deepEqual(resolveMusicSelection('default', 'another', MUSIC_PLAYLISTS, tracks), { playlistId: 'guitar', trackId: 'another' });
  assert.deepEqual(resolveMusicSelection('guitar', 'removed', MUSIC_PLAYLISTS, tracks), { playlistId: 'guitar', trackId: 'lebang-zhanshi-guitar' });
  assert.deepEqual(resolveMusicSelection('removed', 'removed', MUSIC_PLAYLISTS, tracks), { playlistId: 'default', trackId: 'liushang-qushui' });
});

test('sound tracker plays only one new authoritative move per live round', () => {
  const tracker = new MoveSoundTracker(), initial = newGame();
  assert.equal(tracker.observe(initial, 'room:1', true), null);
  const moved = playMove(initial, 'wei-pawn-0-6', { x: 0, y: 5 });
  assert.equal(moved.ok, true); if (!moved.ok) return;
  assert.equal(tracker.observe(moved.game, 'room:1', true), 'move');
  assert.equal(tracker.observe(moved.game, 'room:1', true), null); // ack and broadcast
  assert.equal(tracker.observe(initial, 'room:1', true), null); // undo
  assert.equal(tracker.observe(moved.game, 'room:1', false), null); // offline update
  assert.equal(tracker.observe(moved.game, 'room:1', true), null); // reconnect snapshot
  assert.equal(tracker.observe(moved.game, 'room:2', true), null); // next round or new room
  const capture = structuredClone(moved.game);
  capture.history.push({ ...capture.history[0], number: 2, captured: { id: 'other', faction: 'shu', kind: 'pawn', x: 0, y: 4 } });
  capture.lastMove = capture.history[1];
  assert.equal(tracker.observe(capture, 'room:2', true), 'capture');
  assert.equal(tracker.observe(capture, 'room:2', true), null);
  assert.equal(tracker.observe(initial, 'local', true), null); // entering local mode
});

test('music uses one looping player, independent volume and a path relative to the site', async () => {
  GlobalRegistrator.register({ url: 'https://example.test/three-chess/' });
  const original = globalThis.Audio;
  const created: FakeAudio[] = [];
  class FakeAudio {
    src = '';
    loop = false;
    volume = 1;
    paused = true;
    plays = 0;
    pauses = 0;
    constructor(src = '') { this.src = src; created.push(this); }
    load() {}
    async play() { this.plays++; this.paused = false; }
    pause() { this.pauses++; this.paused = true; }
  }
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: FakeAudio });
  try {
    const sound = new GameAudio();
    assert.match(sound.musicUrl(), /^https:\/\/example\.test\/three-chess\/audio\/background\.mp3\?v=e1ad20273c92$/);
    const settings = { ...DEFAULT_AUDIO_SETTINGS, musicEnabled: true, musicVolume: 0.22 };
    await sound.setMusic(settings); // no autoplay before a gesture
    assert.equal(created.length, 0);
    assert.equal(await sound.setMusic(settings, true), null);
    assert.equal(created.length, 1);
    assert.equal(created[0].loop, true);
    assert.equal(created[0].volume, 0.22);
    sound.setMusicVolume(0.6);
    assert.equal(created[0].volume, 0.6);
    await sound.setMusic(settings, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].plays, 1); // room and turn changes do not restart the current song
    await sound.setMusic({ ...settings, musicEnabled: false });
    assert.ok(created[0].pauses >= 1);
    sound.dispose();
  } finally {
    Object.defineProperty(globalThis, 'Audio', { configurable: true, value: original });
    GlobalRegistrator.unregister();
  }
});

test('rapid track changes reuse one player and ignore a late error from the old song', async () => {
  GlobalRegistrator.register({ url: 'https://example.test/three-chess/' });
  const original = globalThis.Audio;
  const pending: { resolve: () => void; reject: (reason: Error) => void }[] = [];
  const created: FakeAudio[] = [];
  class FakeAudio {
    src = '';
    loop = false;
    volume = 1;
    paused = true;
    plays = 0;
    constructor() { created.push(this); }
    load() {}
    pause() { this.paused = true; }
    play() {
      this.plays++;
      return new Promise<void>((resolve, reject) => pending.push({ resolve: () => { this.paused = false; resolve(); }, reject }));
    }
  }
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: FakeAudio });
  try {
    const sound = new GameAudio();
    const first = { ...DEFAULT_AUDIO_SETTINGS, musicEnabled: true };
    const oldRequest = sound.chooseMusic(first);
    const latest = { ...first, musicPlaylistId: 'guitar', musicTrackId: 'lebang-zhanshi-guitar' };
    const newRequest = sound.chooseMusic(latest);
    assert.equal(created.length, 1);
    assert.match(created[0].src, /lebang-zhanshi-guitar\.mp3\?v=bb95cbf27ff1$/);
    pending[1].resolve();
    pending[0].reject(new Error('old playback aborted'));
    assert.equal(await newRequest, null);
    assert.equal(await oldRequest, null);
    assert.equal(created[0].plays, 2);
    await sound.setMusic({ ...latest, musicEnabled: false });
    assert.equal(created[0].paused, true);
    sound.dispose();
  } finally {
    Object.defineProperty(globalThis, 'Audio', { configurable: true, value: original });
    GlobalRegistrator.unregister();
  }
});

test('failed music load reports once and does not affect legal moves', async () => {
  GlobalRegistrator.register({ url: 'https://example.test/three-chess/' });
  const original = globalThis.Audio;
  let attempts = 0;
  class FailedAudio {
    src = '';
    loop = false;
    volume = 1;
    paused = true;
    load() {}
    async play() { attempts++; throw new Error('missing file'); }
    pause() {}
  }
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: FailedAudio });
  try {
    const sound = new GameAudio(), settings = { ...DEFAULT_AUDIO_SETTINGS, musicEnabled: true };
    assert.match(await sound.setMusic(settings, true) ?? '', /无法播放/);
    assert.equal(await sound.setMusic(settings, true), null);
    assert.equal(attempts, 1);
    assert.equal(playMove(newGame(), 'wei-pawn-0-6', { x: 0, y: 5 }).ok, true);
    sound.dispose();
  } finally {
    Object.defineProperty(globalThis, 'Audio', { configurable: true, value: original });
    GlobalRegistrator.unregister();
  }
});

test('recorded move and capture sounds play separately at the chosen level while music stays constant', async () => {
  GlobalRegistrator.register({ url: 'https://example.test/three-chess/' });
  const originalAudio = globalThis.Audio;
  const players: FakeAudio[] = [];
  class FakeAudio {
    src: string;
    loop = false;
    volume = 1;
    paused = true;
    currentTime = 0;
    plays = 0;
    constructor(src = '') { this.src = src; players.push(this); }
    load() {}
    async play() { this.paused = false; this.plays++; }
    pause() { this.paused = true; }
  }
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: FakeAudio });
  try {
    const sound = new GameAudio();
    const settings = { ...DEFAULT_AUDIO_SETTINGS, musicEnabled: true, musicVolume: 0.8, effectsEnabled: true };
    assert.equal(await sound.setMusic(settings, true), null);
    const music = players[0];
    sound.playEffect('move', settings);
    assert.equal(players.length, 2);
    assert.equal(players[1].src, sound.moveUrl);
    assert.equal(players[1].plays, 1);
    assert.equal(players[1].volume, settings.effectsVolume);
    assert.equal(music.volume, 0.8);
    sound.playEffect('capture', settings);
    assert.equal(players.length, 3);
    assert.equal(players[2].src, sound.captureUrl);
    assert.equal(players[2].plays, 1);
    assert.equal(players[1].plays, 1); // capture does not also play the normal move
    assert.equal(music.volume, 0.8); // no music ducking or interruption
    assert.equal(music.plays, 1);
    sound.setMusicVolume(0.6);
    assert.equal(music.volume, 0.6);
    sound.playEffect('move', settings);
    assert.equal(players.length, 3); // reuses the same short sample
    assert.equal(players[1].plays, 2);
    assert.equal(music.volume, 0.6);
    sound.playEffect('move', { ...settings, effectsEnabled: false });
    assert.equal(players[1].plays, 2);
    sound.playEffect('move', { ...settings, effectsVolume: 0 });
    assert.equal(players[1].plays, 2);
    sound.dispose();
  } finally {
    Object.defineProperty(globalThis, 'Audio', { configurable: true, value: originalAudio });
    GlobalRegistrator.unregister();
  }
});
