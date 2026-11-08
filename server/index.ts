import { createOnlineServer } from './create-server.ts';

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const { httpServer } = createOnlineServer();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

httpServer.listen(port, host, () => console.log(`三国象棋联机服务已启动：http://${host}:${port}/three-chess/`));
