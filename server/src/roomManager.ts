import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  type Room,
  type Player,
  GamePhase,
  RoundType,
  Team,
  ServerMessageType,
  type ServerMessage,
} from "../../shared/dist/types.js";

const ROOM_CODE_LENGTH = 4;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O to avoid confusion

/** Map of room code → Room */
const rooms = new Map<string, Room>();

/** Map of player ID → WebSocket */
const playerSockets = new Map<string, WebSocket>();

/** Map of player ID → room code */
const playerRooms = new Map<string, string>();

function generateRoomCode(): string {
  let code: string;
  do {
    code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createEmptyRoom(code: string): Room {
  return {
    id: randomUUID(),
    code,
    phase: GamePhase.Lobby,
    players: [],
    round: RoundType.Describe,
    roundNumber: 1,
    scores: { [Team.A]: 0, [Team.B]: 0 },
    activeTeam: Team.A,
    clueGiverIndex: { [Team.A]: 0, [Team.B]: 0 },
    activeClueGiverId: null,
    slipPool: [],
    currentSlip: null,
    turnTimeRemaining: 0,
    turnGuessed: [],
    turnSkipped: [],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

function createPlayer(name: string, isHost: boolean): Player {
  return {
    id: randomUUID(),
    name,
    team: null,
    isHost,
    connected: true,
    slips: [],
  };
}

/** Send a message to a single player's WebSocket */
function sendToPlayer(playerId: string, message: ServerMessage): void {
  const ws = playerSockets.get(playerId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/** Broadcast a message to all connected players in a room */
function broadcastToRoom(room: Room, message: ServerMessage): void {
  for (const player of room.players) {
    sendToPlayer(player.id, message);
  }
}

/** Send the full room state to all players in the room */
function broadcastRoomState(room: Room): void {
  broadcastToRoom(room, {
    type: ServerMessageType.RoomState,
    room,
  });
}

/** Create a new room, add the host player, and return the room + player */
export function createRoom(playerName: string, ws: WebSocket): { room: Room; player: Player } {
  const code = generateRoomCode();
  const room = createEmptyRoom(code);
  const player = createPlayer(playerName, true);

  room.players.push(player);
  rooms.set(code, room);
  playerSockets.set(player.id, ws);
  playerRooms.set(player.id, code);

  return { room, player };
}

/** Join an existing room by code. Returns the room and new player, or an error string. */
export function joinRoom(
  roomCode: string,
  playerName: string,
  ws: WebSocket,
): { room: Room; player: Player } | { error: string } {
  const code = roomCode.toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    return { error: `Room "${code}" not found` };
  }

  if (room.phase !== GamePhase.Lobby) {
    return { error: "Game has already started" };
  }

  if (room.players.length >= 8) {
    return { error: "Room is full (max 8 players)" };
  }

  const player = createPlayer(playerName, false);
  room.players.push(player);
  room.lastActivityAt = Date.now();
  playerSockets.set(player.id, ws);
  playerRooms.set(player.id, code);

  // Notify existing players that someone joined
  broadcastToRoom(room, {
    type: ServerMessageType.PlayerJoined,
    player,
  });

  return { room, player };
}

/** Handle a player disconnecting */
export function disconnectPlayer(playerId: string): void {
  const roomCode = playerRooms.get(playerId);
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  const player = room.players.find((p) => p.id === playerId);
  if (!player) return;

  // Remove the player from the room
  room.players = room.players.filter((p) => p.id !== playerId);
  room.lastActivityAt = Date.now();
  playerSockets.delete(playerId);
  playerRooms.delete(playerId);

  // If the room is empty, delete it
  if (room.players.length === 0) {
    rooms.delete(roomCode);
    return;
  }

  // If the host left, promote the next player
  if (player.isHost && room.players.length > 0) {
    room.players[0].isHost = true;
  }

  // Notify remaining players
  broadcastToRoom(room, {
    type: ServerMessageType.PlayerLeft,
    playerId,
  });

  // Send updated full state so clients stay in sync
  broadcastRoomState(room);
}

/** Get a room by code */
export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

/** Get the room code a player belongs to */
export function getPlayerRoomCode(playerId: string): string | undefined {
  return playerRooms.get(playerId);
}

/** Register a WebSocket for a player (used on reconnect) */
export function registerSocket(playerId: string, ws: WebSocket): void {
  playerSockets.set(playerId, ws);
}

export { sendToPlayer, broadcastToRoom, broadcastRoomState };
