import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS, GameAudio, MoveSoundTracker, loadAudioSettings } from '../src/audio.ts';
import { newGame, playMove } from '../src/game.ts';

test('sound settings default off, persist independent levels and reject malformed values', () => {
  GlobalRegistrator.register({ url: 'http://localhost:5173' });
  try {
    localStorage.clear();
    assert.deepEqual(loadAudioSettings(), DEFAULT_AUDIO_SETTINGS);
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ musicEnabled: true, musicVolume: 0.2, effectsEnabled: false, effectsVolume: 0.8 }));
    assert.deepEqual(loadAudioSettings(), { musicEnabled: true, musicVolume: 0.2, effectsEnabled: false, effectsVolume: 0.8 });
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ musicEnabled: true, musicVolume: 30, effectsEnabled: true, effectsVolume: -5 }));
    assert.deepEqual(loadAudioSettings(), { musicEnabled: true, musicVolume: 1, effectsEnabled: true, effectsVolume: 0 });
  } finally { GlobalRegistrator.unregister(); }
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
    src: string;
    loop = false;
    volume = 1;
    plays = 0;
    pauses = 0;
    constructor(src: string) { this.src = src; created.push(this); }
    async play() { this.plays++; }
    pause() { this.pauses++; }
  }
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: FakeAudio });
  try {
    const sound = new GameAudio();
    assert.match(sound.musicUrl, /^https:\/\/example\.test\/three-chess\/audio\/background\.mp3$/);
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
    await sound.setMusic({ ...settings, musicEnabled: false });
    assert.equal(created[0].pauses, 1);
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
    loop = false;
    volume = 1;
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

test('a confirmed move is louder than before and briefly lowers music without changing its saved level', async () => {
  GlobalRegistrator.register({ url: 'https://example.test/three-chess/' });
  const originalAudio = globalThis.Audio, originalContext = globalThis.AudioContext;
  const gains: number[] = [];
  class FakeAudio {
    loop = false;
    volume = 1;
    paused = true;
    constructor(_src: string) {}
    async play() { this.paused = false; }
    pause() { this.paused = true; }
  }
  class FakeContext {
    sampleRate = 1000;
    currentTime = 1;
    destination = {};
    async resume() {}
    async close() {}
    createBuffer() { return { getChannelData: () => new Float32Array(120) }; }
    createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; }
    createBiquadFilter() { return { type: '', frequency: { value: 0 }, connect() {} }; }
    createGain() { return { gain: { setValueAtTime: (value: number) => gains.push(value), exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: FakeAudio });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeContext });
  try {
    const sound = new GameAudio();
    const settings = { ...DEFAULT_AUDIO_SETTINGS, musicEnabled: true, musicVolume: 0.8, effectsEnabled: true };
    assert.equal(await sound.setMusic(settings, true), null);
    const player = (sound as unknown as { music: FakeAudio }).music;
    sound.playEffect('move', settings);
    assert.ok(gains[0] > 0.4);
    assert.equal(player.volume, 0.8 * 0.22);
    sound.setMusicVolume(0.6);
    assert.equal(player.volume, 0.6 * 0.22);
    sound.playEffect('capture', settings);
    assert.ok(gains[1] > gains[0]);
    assert.equal(gains.length, 3); // capture has two layers, not an extra normal move sound
    await new Promise(resolve => setTimeout(resolve, 320));
    assert.equal(player.volume, 0.6);
    sound.playEffect('move', { ...settings, effectsEnabled: false });
    assert.equal(player.volume, 0.6);
    assert.equal(gains.length, 3);
    sound.dispose();
  } finally {
    Object.defineProperty(globalThis, 'Audio', { configurable: true, value: originalAudio });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: originalContext });
    GlobalRegistrator.unregister();
  }
});
