import express from 'express';
import http from 'http';
import path from 'path';
import { initDb } from './db';
import { initWebSocket } from './ws';
import { startCameraLoop } from './camera';
import camerasRouter from './routes/cameras';
import zonesRouter from './routes/zones';
import countsRouter from './routes/counts';
import flowRouter from './routes/flow';
import alertsRouter from './routes/alerts';

const PORT = parseInt(process.env.PORT || '3070', 10);

async function main() {
  // Init DB
  initDb();

  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'herd', ts: Date.now() });
  });

  // API routes
  app.use('/api/cameras', camerasRouter);
  app.use('/api/zones', zonesRouter);
  app.use('/api/counts', countsRouter);
  app.use('/api/flow', flowRouter);
  app.use('/api/alerts', alertsRouter);

  // Dashboard
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  // Catch-all for unknown routes
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // HTTP server (shared with WebSocket)
  const server = http.createServer(app);
  initWebSocket(server);

  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════╗
║  🐂  HERD  — Crowd Analytics  ║
║  Port: ${PORT}                    ║
║  Mode: ${(process.env.HAILO_MODE || 'auto').padEnd(24)} ║
╚═══════════════════════════════╝
    `);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`API:       http://localhost:${PORT}/api`);
  });

  // Start camera processing loop (2s interval)
  startCameraLoop(2000);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[herd] SIGTERM received, shutting down...');
    server.close(() => process.exit(0));
  });
}

main().catch(err => {
  console.error('[herd] Fatal error:', err);
  process.exit(1);
});
