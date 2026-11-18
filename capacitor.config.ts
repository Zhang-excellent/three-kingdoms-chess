import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.threekingdoms.chess',
  appName: '三国象棋',
  webDir: 'dist',
  server: {
    hostname: 'localhost',
    androidScheme: 'https'
  }
};

export default config;
