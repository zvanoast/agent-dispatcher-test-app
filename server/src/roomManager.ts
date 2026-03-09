import { v4 as uuidv4 } from "uuid";
import type { WebSocket } from "ws";
import {
  type Room,
  type Player,
  type ServerMessage,
  GamePhase,
  Team,
  RoundType,
  ServerMessageType,
} from "@fishbowl/shared";

/** A connected client: the WebSocket plus player/room identity */
export interface ConnectedClient {
  ws: WebSocket;
  playerId: string;
  roomCode: string;
}

/** Characters used for room codes (no ambiguous chars) */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function makeDefaultRoom(code: string): Room {
  return {
    id: uuidv4(),
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

export class RoomManager {
  /** room code → Room */
  private rooms = new Map<string, Room>();
  /** player ID → ConnectedClient */
  private clients = new Map<string, ConnectedClient>();

  /** Generate a unique room code not already in use */
  private generateUniqueCode(): string {
    let code: string;
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts++;
      if (attempts > 100) {
        throw new Error("Unable to generate unique room code");
      }
    } while (this.rooms.has(code));
    return code;
  }

  /**
   * Handle a new WebSocket connection.
   * If the room code doesn't exist, creates the room and makes the player host.
   * If the room exists, joins the player.
   * Returns an error string if the join fails, or null on success.
   */
  handleConnection(ws: WebSocket, roomCode: string, playerName: string): string | null {
    const trimmedName = playerName.trim();
    if (!trimmedName) {
      return "Player name is required";
    }

    if (!roomCode || !/^[A-Z0-9]{4}$/.test(roomCode)) {
      return "Invalid room code format";
    }

    let room = this.rooms.get(roomCode);
    const isNewRoom = !room;

    if (isNewRoom) {
      room = makeDefaultRoom(roomCode);
      this.rooms.set(roomCode, room);
    }

    // Check for duplicate name in the room
    const nameTaken = room!.players.some(
      (p) => p.name.toLowerCase() === trimmedName.toLowerCase() && p.connected
    );
    if (nameTaken) {
      // Clean up empty room we may have just created
      if (isNewRoom) this.rooms.delete(roomCode);
      return `Name "${trimmedName}" is already taken in this room`;
    }

    const playerId = uuidv4();
    const player: Player = {
      id: playerId,
      name: trimmedName,
      team: null,
      isHost: isNewRoom || room!.players.length === 0,
      connected: true,
      slips: [],
    };

    room!.players.push(player);
    room!.lastActivityAt = Date.now();

    this.clients.set(playerId, { ws, playerId, roomCode });

    // If new room, send room-created to host
    if (isNewRoom) {
      this.send(ws, {
        type: ServerMessageType.RoomCreated,
        roomCode,
        roomId: room!.id,
      });
    }

    // Broadcast room state to all clients in the room
    this.broadcastRoomState(roomCode);

    return null;
  }

  /**
   * Handle a player disconnecting.
   * Removes them from the room, transfers host if needed.
   */
  handleDisconnect(ws: WebSocket): void {
    // Find the client by WebSocket reference
    let clientEntry: ConnectedClient | undefined;
    for (const [, client] of this.clients) {
      if (client.ws === ws) {
        clientEntry = client;
        break;
      }
    }

    if (!clientEntry) return;

    const { playerId, roomCode } = clientEntry;
    const room = this.rooms.get(roomCode);
    if (!room) {
      this.clients.delete(playerId);
      return;
    }

    // Remove the player from the room
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) {
      this.clients.delete(playerId);
      return;
    }

    const wasHost = room.players[playerIndex].isHost;
    room.players.splice(playerIndex, 1);
    this.clients.delete(playerId);
    room.lastActivityAt = Date.now();

    // If room is empty, remove it
    if (room.players.length === 0) {
      this.rooms.delete(roomCode);
      return;
    }

    // Transfer host if the host left
    if (wasHost) {
      room.players[0].isHost = true;
    }

    // Broadcast updated state
    this.broadcastRoomState(roomCode);
  }

  /** Get a room by code (for testing) */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** Get all clients in a room */
  private getClientsInRoom(roomCode: string): ConnectedClient[] {
    const result: ConnectedClient[] = [];
    for (const [, client] of this.clients) {
      if (client.roomCode === roomCode) {
        result.push(client);
      }
    }
    return result;
  }

  /** Broadcast room state to all connected clients in a room */
  private broadcastRoomState(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const message: ServerMessage = {
      type: ServerMessageType.RoomState,
      room,
    };

    for (const client of this.getClientsInRoom(roomCode)) {
      this.send(client.ws, message);
    }
  }

  /** Send a typed message to a single WebSocket */
  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /** Expose room count for testing */
  get roomCount(): number {
    return this.rooms.size;
  }
}
