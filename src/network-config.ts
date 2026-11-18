import { Capacitor } from '@capacitor/core';

export const WEB_BACKEND_ORIGIN = 'https://47.95.251.153';
export const ANDROID_WEBVIEW_ORIGIN = 'https://localhost';
export const APP_BASE_PATH = '/three-chess';
export const API_BASE_PATH = `${APP_BASE_PATH}/api`;
export const SOCKET_IO_PATH = `${APP_BASE_PATH}/socket.io`;

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function apiUrl(path: string, native = isNativeApp()): string {
  const normalizedPath = path.replace(/^\/+/, '');
  const base = native ? `${WEB_BACKEND_ORIGIN}${API_BASE_PATH}` : API_BASE_PATH;
  return `${base}/${normalizedPath}`;
}

export function backendAssetUrl(path: string | null | undefined, native = isNativeApp()): string | null {
  if (!path) return null;
  if (!native || !path.startsWith(`${APP_BASE_PATH}/`)) return path;
  return `${WEB_BACKEND_ORIGIN}${path}`;
}

export function apiRequestCredentials(native = isNativeApp()): RequestCredentials {
  return native ? 'include' : 'same-origin';
}

export function socketIoConfig(native = isNativeApp()): {
  origin: string | null;
  options: { path: string; withCredentials: true };
} {
  return {
    origin: native ? WEB_BACKEND_ORIGIN : null,
    options: { path: SOCKET_IO_PATH, withCredentials: true },
  };
}
