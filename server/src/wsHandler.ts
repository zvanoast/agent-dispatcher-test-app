import type { WebSocket } from "ws";
import {
  ClientMessageType,
  ServerMessageType,
  type ClientMessage,
} from "../../shared/dist/types.js";
import {
  createRoom,
  joinRoom,
  disconnectPlayer,
  sendToPlayer,
  broadcastRoomState,
} from "./roomManager.js";

/** Per-socket state tracking which player this socket belongs to */
const socketPlayerMap = new WeakMap<WebSocket, string>();

export function handleConnection(ws: WebSocket): void {
  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: ServerMessageType.Error, message: "Invalid JSON" }));
      return;
    }

    handleMessage(ws, msg);
  });

  ws.on("close", () => {
    const playerId = socketPlayerMap.get(ws);
    if (playerId) {
      disconnectPlayer(playerId);
      socketPlayerMap.delete(ws);
    }
  });
}

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  switch (msg.type) {
    case ClientMessageType.CreateRoom:
      handleCreateRoom(ws, msg.playerName);
      break;
    case ClientMessageType.JoinRoom:
      handleJoinRoom(ws, msg.roomCode, msg.playerName);
      break;
    default: {
      // Future message types will be handled here
      const playerId = socketPlayerMap.get(ws);
      if (!playerId) {
        ws.send(
          JSON.stringify({
            type: ServerMessageType.Error,
            message: "You must create or join a room first",
          }),
        );
      }
      break;
    }
  }
}

function handleCreateRoom(ws: WebSocket, playerName: string): void {
  if (!playerName || playerName.trim().length === 0) {
    ws.send(
      JSON.stringify({ type: ServerMessageType.Error, message: "Player name is required" }),
    );
    return;
  }

  const { room, player } = createRoom(playerName.trim(), ws);
  socketPlayerMap.set(ws, player.id);

  // Send room-created confirmation to the host
  sendToPlayer(player.id, {
    type: ServerMessageType.RoomCreated,
    roomCode: room.code,
    roomId: room.id,
  });

  // Send full room state
  sendToPlayer(player.id, {
    type: ServerMessageType.RoomState,
    room,
  });
}

function handleJoinRoom(ws: WebSocket, roomCode: string, playerName: string): void {
  if (!playerName || playerName.trim().length === 0) {
    ws.send(
      JSON.stringify({ type: ServerMessageType.Error, message: "Player name is required" }),
    );
    return;
  }

  if (!roomCode || roomCode.trim().length === 0) {
    ws.send(
      JSON.stringify({ type: ServerMessageType.Error, message: "Room code is required" }),
    );
    return;
  }

  const result = joinRoom(roomCode.trim(), playerName.trim(), ws);

  if ("error" in result) {
    ws.send(JSON.stringify({ type: ServerMessageType.Error, message: result.error }));
    return;
  }

  const { room, player } = result;
  socketPlayerMap.set(ws, player.id);

  // Send full room state to all players (including the new joiner)
  broadcastRoomState(room);
}
