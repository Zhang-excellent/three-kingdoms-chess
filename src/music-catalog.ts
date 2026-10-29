/** Add a supplied MP3 to public/audio/ and one entry here. IDs stay stable across releases. */
export interface MusicPlaylist { id: string; name: string }
export interface MusicTrack { id: string; name: string; file: string; cacheVersion: string; playlistId?: string }

export const DEFAULT_PLAYLIST_ID = 'default';
export const MUSIC_PLAYLISTS: MusicPlaylist[] = [
  { id: DEFAULT_PLAYLIST_ID, name: '默认歌单' },
  { id: 'guitar', name: '吉他' },
  { id: 'classical', name: '古典' },
];
export const MUSIC_TRACKS: MusicTrack[] = [
  { id: 'liushang-qushui', name: '流觞曲水', file: 'background.mp3', cacheVersion: 'e1ad20273c92' },
  { id: 'lebang-zhanshi-guitar', name: '乐邦詹士（吉他）', file: 'lebang-zhanshi-guitar.mp3', cacheVersion: 'bb95cbf27ff1', playlistId: 'guitar' },
  { id: 'mozart-symphony-40', name: '莫扎特《G小调第40交响曲》', file: 'mozart-symphony-40.mp3', cacheVersion: '1bcc472eee7c', playlistId: 'classical' },
];

export function trackPlaylistId(track: MusicTrack): string { return track.playlistId ?? DEFAULT_PLAYLIST_ID; }
export function tracksInPlaylist(playlistId: string, tracks: readonly MusicTrack[] = MUSIC_TRACKS): MusicTrack[] {
  return tracks.filter(track => trackPlaylistId(track) === playlistId);
}
export function availablePlaylists(playlists: readonly MusicPlaylist[] = MUSIC_PLAYLISTS, tracks: readonly MusicTrack[] = MUSIC_TRACKS): MusicPlaylist[] {
  return playlists.filter(playlist => tracksInPlaylist(playlist.id, tracks).length > 0);
}
export function resolveMusicSelection(
  playlistId: unknown, trackId: unknown,
  playlists: readonly MusicPlaylist[] = MUSIC_PLAYLISTS, tracks: readonly MusicTrack[] = MUSIC_TRACKS,
): { playlistId: string; trackId: string } {
  const available = availablePlaylists(playlists, tracks);
  const track = tracks.find(item => item.id === trackId && available.some(playlist => playlist.id === trackPlaylistId(item)));
  if (track) return { playlistId: trackPlaylistId(track), trackId: track.id };
  const playlist = available.find(item => item.id === playlistId) ?? available[0];
  return { playlistId: playlist?.id ?? DEFAULT_PLAYLIST_ID, trackId: playlist ? tracksInPlaylist(playlist.id, tracks)[0].id : '' };
}
export function musicTrack(trackId: string): MusicTrack | undefined { return MUSIC_TRACKS.find(track => track.id === trackId); }
