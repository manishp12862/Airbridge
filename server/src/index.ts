import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 9000;
const wss = new WebSocketServer({ port: PORT });

// Map of roomId -> Set of connected WebSockets
const rooms = new Map<string, Set<WebSocket>>();
// Map of WebSocket -> roomId
const socketRoomMap = new Map<WebSocket, string>();

console.log(`[AirBridge Signaling Server] Running on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  console.log('[AirBridge] New peer connected');

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const { type, roomId, payload } = message;

      switch (type) {
        case 'join': {
          if (!roomId) return;
          
          let room = rooms.get(roomId);
          if (!room) {
            room = new Set();
            rooms.set(roomId, room);
          }

          if (room.size >= 2) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 2 devices)' }));
            return;
          }

          room.add(ws);
          socketRoomMap.set(ws, roomId);

          const isInitiator = room.size === 1;
          ws.send(JSON.stringify({ 
            type: 'joined', 
            roomId, 
            isInitiator,
            peersCount: room.size 
          }));

          // Notify the other peer if already in room
          if (room.size === 2) {
            for (const peer of room) {
              if (peer !== ws && peer.readyState === WebSocket.OPEN) {
                peer.send(JSON.stringify({ type: 'peer_joined' }));
              }
            }
          }
          break;
        }

        // WebRTC Signaling: relay offer, answer, ice-candidate
        case 'signal': {
          const currentRoomId = socketRoomMap.get(ws) || roomId;
          if (!currentRoomId) return;

          const room = rooms.get(currentRoomId);
          if (room) {
            for (const peer of room) {
              if (peer !== ws && peer.readyState === WebSocket.OPEN) {
                peer.send(JSON.stringify({ type: 'signal', payload }));
              }
            }
          }
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[AirBridge] Error processing message:', err);
    }
  });

  ws.on('close', () => {
    const roomId = socketRoomMap.get(ws);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) {
          rooms.delete(roomId);
        } else {
          for (const peer of room) {
            if (peer.readyState === WebSocket.OPEN) {
              peer.send(JSON.stringify({ type: 'peer_disconnected' }));
            }
          }
        }
      }
      socketRoomMap.delete(ws);
    }
    console.log('[AirBridge] Peer disconnected');
  });
});
