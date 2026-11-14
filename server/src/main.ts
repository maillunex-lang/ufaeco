import { createGameServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const server = createGameServer(config);
const { host, port } = await server.start();
console.log(`БАШЭКО Online: сервер запущен на ${host}:${port} (${config.environment}), WebSocket: ${config.websocketUrl}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void server.stop().then(() => process.exit(0));
  });
}
