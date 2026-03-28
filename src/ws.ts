import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server) {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    console.log(`[ws] Client connected from ${req.socket.remoteAddress}`);
    ws.on('close', () => console.log('[ws] Client disconnected'));
    ws.on('error', (err) => console.error('[ws] Error:', err.message));
  });

  console.log('[ws] WebSocket server ready');
}

export function broadcast(data: object) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}
