import { v4 as uuidv4 } from "uuid";
import type { WebSocket } from "ws";
import {
  type Room,
  type Player,
  type Slip,
  type ServerMessage,
  type ClientMessage,
  GamePhase,
  Team,
  RoundType,
  ServerMessageType,
  ClientMessageType,
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
    const clientEntry = this.findClientByWs(ws);
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

  /**
   * Handle an incoming client message on an established connection.
   * Returns an error string if the message is invalid, or null on success.
   */
  handleMessage(ws: WebSocket, message: ClientMessage): string | null {
    const client = this.findClientByWs(ws);
    if (!client) return "Not connected to a room";

    const room = this.rooms.get(client.roomCode);
    if (!room) return "Room not found";

    const player = room.players.find((p) => p.id === client.playerId);
    if (!player) return "Player not found in room";

    switch (message.type) {
      case ClientMessageType.AssignTeam:
        return this.handleAssignTeam(room, player, message.playerId, message.team);
      case ClientMessageType.RandomizeTeams:
        return this.handleRandomizeTeams(room, player);
      case ClientMessageType.SubmitSlips:
        return this.handleSubmitSlips(room, player, message.texts);
      default:
        return `Unhandled message type: ${message.type}`;
    }
  }

  private handleAssignTeam(room: Room, sender: Player, targetPlayerId: string, team: Team): string | null {
    if (!sender.isHost) return "Only the host can assign teams";

    const target = room.players.find((p) => p.id === targetPlayerId);
    if (!target) return "Player not found";

    target.team = team;
    room.lastActivityAt = Date.now();

    this.broadcastTeamsUpdated(room);
    return null;
  }

  private handleRandomizeTeams(room: Room, sender: Player): string | null {
    if (!sender.isHost) return "Only the host can randomize teams";

    // Shuffle players array copy using Fisher-Yates
    const shuffled = [...room.players];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Split evenly: first half Team A, second half Team B
    const half = Math.ceil(shuffled.length / 2);
    for (let i = 0; i < shuffled.length; i++) {
      shuffled[i].team = i < half ? Team.A : Team.B;
    }

    room.lastActivityAt = Date.now();
    this.broadcastTeamsUpdated(room);
    return null;
  }

  private handleSubmitSlips(room: Room, player: Player, texts: string[]): string | null {
    if (room.phase !== GamePhase.Submitting) return "Not in submitting phase";

    if (!Array.isArray(texts) || texts.length !== 4) {
      return "Must submit exactly 4 slips";
    }

    // Validate each slip text is non-empty
    const trimmed = texts.map((t) => (typeof t === "string" ? t.trim() : ""));
    if (trimmed.some((t) => !t)) {
      return "All slips must be non-empty";
    }

    // Create slip objects
    const slips: Slip[] = trimmed.map((text) => ({
      id: uuidv4(),
      text,
      submittedBy: player.id,
    }));

    player.slips = slips;
    room.lastActivityAt = Date.now();

    // Broadcast updated room state so all clients see slip submission progress
    this.broadcastRoomState(room.code);

    // Check if all players have submitted — transition to playing
    const allSubmitted = room.players.every((p) => p.slips.length === 4);
    if (allSubmitted) {
      room.phase = GamePhase.Playing;

      // Collect all slips into the pool
      room.slipPool = room.players.flatMap((p) => [...p.slips]);

      this.broadcastPhaseChanged(room);
      this.broadcastRoomState(room.code);
    }

    return null;
  }

  private broadcastTeamsUpdated(room: Room): void {
    const message: ServerMessage = {
      type: ServerMessageType.TeamsUpdated,
      players: room.players,
    };
    for (const client of this.getClientsInRoom(room.code)) {
      this.send(client.ws, message);
    }
  }

  private broadcastPhaseChanged(room: Room): void {
    const message: ServerMessage = {
      type: ServerMessageType.PhaseChanged,
      phase: room.phase,
      round: room.round,
      roundNumber: room.roundNumber,
    };
    for (const client of this.getClientsInRoom(room.code)) {
      this.send(client.ws, message);
    }
  }

  /** Find a connected client by WebSocket reference */
  private findClientByWs(ws: WebSocket): ConnectedClient | undefined {
    for (const [, client] of this.clients) {
      if (client.ws === ws) return client;
    }
    return undefined;
  }

  /** Get a room by code (for testing) */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** Find a client by player ID (for testing) */
  getClient(playerId: string): ConnectedClient | undefined {
    return this.clients.get(playerId);
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
