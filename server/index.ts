import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, pruneOldEvents } from './db.js';
import { initWebSocket, broadcastEvent, broadcastPermission } from './websocket.js';
import { registerHookRoutes } from './hooks.js';
import { registerApiRoutes } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001');
const HOST = process.env.HOST || '0.0.0.0';

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'claude-web-ui.db');
initDb(dbPath);

const maxAgeDays = parseInt(process.env.MAX_EVENT_AGE_DAYS || '30', 10);
pruneOldEvents(maxAgeDays);
setInterval(() => {
  pruneOldEvents(maxAgeDays);
}, 60 * 60 * 1000);

const app = express();
app.use(express.json({ limit: '10mb' }));

registerHookRoutes(app, { broadcastEvent, broadcastPermission });
registerApiRoutes(app);

const clientDir = path.join(__dirname, '..', 'dist', 'client');
app.use(express.static(clientDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

const server = createServer(app);
initWebSocket(server);

server.listen(PORT, HOST, () => {
  console.log(`Claude Web UI server listening on http://${HOST}:${PORT}`);
});
