import express from 'express';
import http from 'http';
import path from 'path';
import { initDb } from './db';
import { initWebSocket } from './ws';
import { startCameraLoop } from './camera';
import { startAggregator, stopAggregator } from './aggregator';
import { startSentryFlow, stopSentryFlow } from './sentryflow';
import camerasRouter from './routes/cameras';
import zonesRouter from './routes/zones';
import countsRouter from './routes/counts';
import flowRouter from './routes/flow';
import alertsRouter from './routes/alerts';
import eventRouter from './routes/event';
import historyRouter from './routes/history';
import heatmapRouter from './routes/heatmap';
import gatesRouter from './routes/gates';
import occupancyRouter from './routes/occupancy';
import externalRouter from './routes/external';
import lorawanRouter from './routes/lorawan';
import predictionsRouter from './routes/predictions';
import templatesRouter from './routes/templates';
import meshmapRouter from './routes/meshmap';

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
  app.use('/api/event', eventRouter);
  app.use('/api/history', historyRouter);
  app.use('/api/heatmap', heatmapRouter);
  app.use('/api/gates', gatesRouter);
  app.use('/api/v1', occupancyRouter);
  app.use('/api/external-count', externalRouter);
  app.use('/api/lorawan', lorawanRouter);
  app.use('/api/predictions', predictionsRouter);
  app.use('/api/templates', templatesRouter);
  app.use('/api/meshmap', meshmapRouter);

  // Per-instance dashboard
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  // Event-wide aggregated dashboard
  app.get('/event', (_req, res) => {
    res.sendFile(path.join(__dirname, 'event-dashboard.html'));
  });

  // Analytics page
  app.get('/analytics', (_req, res) => {
    res.sendFile(path.join(__dirname, 'analytics.html'));
  });

  // Heatmap page
  app.get('/heatmap', (_req, res) => {
    res.sendFile(path.join(__dirname, 'heatmap.html'));
  });

  // Mobile dashboard
  app.get('/mobile', (_req, res) => {
    res.sendFile(path.join(__dirname, 'mobile.html'));
  });

  // VR Dashboard (Quest 3)
  app.get('/vr', (_req, res) => {
    res.sendFile(path.join(__dirname, 'vr.html'));
  });

  // LoRaWAN dashboard
  app.get('/lorawan', (_req, res) => {
    res.sendFile(path.join(__dirname, 'lorawan.html'));
  });

  // Airspace / Mesh-Mapper dashboard
  app.get('/meshmap', (_req, res) => {
    res.sendFile(path.join(__dirname, 'meshmap.html'));
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

  // Start event aggregator (only if HERD_SOURCES is set)
  startAggregator();

  // Start SentryFlow integration (only if SENTRYFLOW_URL is set)
  startSentryFlow();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[herd] SIGTERM received, shutting down...');
    stopAggregator();
    stopSentryFlow();
    server.close(() => process.exit(0));
  });
}

main().catch(err => {
  console.error('[herd] Fatal error:', err);
  process.exit(1);
});
