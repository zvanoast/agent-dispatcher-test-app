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

/** Maximum number of players allowed in a room */
export const MAX_PLAYERS = 8;
/** Minimum number of players required to start a game (configurable for dev/testing) */
export const MIN_PLAYERS = parseInt(process.env.MIN_PLAYERS ?? "4", 10);

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
    allSlips: [],
    carryoverTime: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

export class RoomManager {
  /** room code → Room */
  private rooms = new Map<string, Room>();
  /** player ID → ConnectedClient */
  private clients = new Map<string, ConnectedClient>();
  /** room code → active turn timer interval */
  private turnTimers = new Map<string, ReturnType<typeof setInterval>>();

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

    // Check if room is full
    if (!isNewRoom && room!.players.filter((p) => p.connected).length >= MAX_PLAYERS) {
      return "Room is full (maximum 8 players)";
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
      case ClientMessageType.StartGame:
        return this.handleStartGame(room, player);
      case ClientMessageType.SubmitSlips:
        return this.handleSubmitSlips(room, player, message.texts);
      case ClientMessageType.StartTurn:
        return this.handleStartTurn(room, player);
      case ClientMessageType.GotIt:
        return this.handleGotIt(room, player);
      case ClientMessageType.Skip:
        return this.handleSkip(room, player);
      case ClientMessageType.NewGame:
        return this.handleNewGame(room, player);
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

  private handleStartGame(room: Room, player: Player): string | null {
    if (room.phase !== GamePhase.Lobby) return "Game can only be started from the lobby";
    if (!player.isHost) return "Only the host can start the game";

    const connectedPlayers = room.players.filter((p) => p.connected);

    if (connectedPlayers.length < MIN_PLAYERS) {
      return `Need at least ${MIN_PLAYERS} players to start (currently ${connectedPlayers.length})`;
    }

    // All players must be assigned to a team
    const unassigned = connectedPlayers.filter((p) => p.team === null);
    if (unassigned.length > 0) {
      return "All players must be assigned to a team before starting";
    }

    // Both teams must have at least one player
    const teamACount = connectedPlayers.filter((p) => p.team === Team.A).length;
    const teamBCount = connectedPlayers.filter((p) => p.team === Team.B).length;
    if (teamACount === 0 || teamBCount === 0) {
      return "Both teams must have at least one player";
    }

    room.phase = GamePhase.Submitting;
    room.lastActivityAt = Date.now();
    this.broadcastPhaseChanged(room);
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

      // Collect all slips into the pool and save master list for reshuffling
      room.allSlips = room.players.flatMap((p) => [...p.slips]);
      room.slipPool = [...room.allSlips];

      this.broadcastPhaseChanged(room);
      this.broadcastRoomState(room.code);
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Turn Engine
  // ---------------------------------------------------------------------------

  private handleStartTurn(room: Room, player: Player): string | null {
    if (!player.isHost) return "Only the host can start a turn";
    if (
      room.phase !== GamePhase.Playing &&
      room.phase !== GamePhase.TurnEnd &&
      room.phase !== GamePhase.RoundEnd
    ) {
      return "Cannot start a turn in current phase";
    }
    if (room.slipPool.length === 0) return "No slips in the pool";

    // Determine clue-giver from the active team
    const teamPlayers = room.players.filter((p) => p.team === room.activeTeam);
    if (teamPlayers.length === 0) return "No players on the active team";

    const clueGiverIdx = room.clueGiverIndex[room.activeTeam] % teamPlayers.length;
    const clueGiver = teamPlayers[clueGiverIdx];

    room.activeClueGiverId = clueGiver.id;
    room.phase = GamePhase.TurnActive;

    // Apply carryover time if available, otherwise 30 seconds
    room.turnTimeRemaining = room.carryoverTime > 0 ? room.carryoverTime : 30;
    room.carryoverTime = 0;
    room.turnGuessed = [];
    room.turnSkipped = [];

    // Draw first slip
    this.drawNextSlip(room);

    // Send turn-started: with currentSlip only to the clue-giver
    for (const client of this.getClientsInRoom(room.code)) {
      const msg: ServerMessage = {
        type: ServerMessageType.TurnStarted,
        clueGiverId: clueGiver.id,
        team: room.activeTeam,
        timeRemaining: room.turnTimeRemaining,
        ...(client.playerId === clueGiver.id && room.currentSlip
          ? { currentSlip: room.currentSlip }
          : {}),
      };
      this.send(client.ws, msg);
    }

    room.lastActivityAt = Date.now();
    this.startTurnTimer(room);
    return null;
  }

  private handleGotIt(room: Room, player: Player): string | null {
    if (room.phase !== GamePhase.TurnActive) return "No active turn";
    if (player.id !== room.activeClueGiverId) return "Only the clue-giver can do this";
    if (!room.currentSlip) return "No current slip";

    // Score +1 for the active team
    room.scores[room.activeTeam] += 1;
    room.turnGuessed.push(room.currentSlip);

    // Remove from pool
    const guessedId = room.currentSlip.id;
    room.slipPool = room.slipPool.filter((s) => s.id !== guessedId);

    // Broadcast slip-guessed to all
    this.broadcastToRoom(room.code, {
      type: ServerMessageType.SlipGuessed,
      slip: room.currentSlip,
      team: room.activeTeam,
    });

    room.lastActivityAt = Date.now();

    // If pool is empty, the round is over — end turn
    if (room.slipPool.length === 0) {
      this.endTurn(room);
      return null;
    }

    // Draw next slip and send to clue-giver
    this.drawNextSlip(room);
    this.sendCurrentSlipToClueGiver(room);
    return null;
  }

  private handleSkip(room: Room, player: Player): string | null {
    if (room.phase !== GamePhase.TurnActive) return "No active turn";
    if (player.id !== room.activeClueGiverId) return "Only the clue-giver can do this";
    if (!room.currentSlip) return "No current slip";

    // Mark as skipped this turn (prevents re-draw)
    room.turnSkipped.push(room.currentSlip.id);

    // Deduct 5 seconds penalty
    room.turnTimeRemaining = Math.max(0, room.turnTimeRemaining - 5);

    // Broadcast skip to all
    this.broadcastToRoom(room.code, {
      type: ServerMessageType.SlipSkipped,
    });

    // Broadcast updated time after penalty
    this.broadcastToRoom(room.code, {
      type: ServerMessageType.TimerTick,
      timeRemaining: room.turnTimeRemaining,
    });

    room.lastActivityAt = Date.now();

    // Check if time ran out due to penalty
    if (room.turnTimeRemaining <= 0) {
      this.endTurn(room);
      return null;
    }

    // Draw next unskipped slip
    this.drawNextSlip(room);

    if (!room.currentSlip) {
      // All remaining slips have been skipped this turn
      this.endTurn(room);
      return null;
    }

    this.sendCurrentSlipToClueGiver(room);
    return null;
  }

  private handleNewGame(room: Room, player: Player): string | null {
    if (!player.isHost) return "Only the host can start a new game";
    if (room.phase !== GamePhase.GameOver) {
      return "Can only start a new game after game over";
    }

    // Reset game state, keep players and teams
    room.phase = GamePhase.Submitting;
    room.round = RoundType.Describe;
    room.roundNumber = 1;
    room.scores = { [Team.A]: 0, [Team.B]: 0 };
    room.activeTeam = Team.A;
    room.clueGiverIndex = { [Team.A]: 0, [Team.B]: 0 };
    room.activeClueGiverId = null;
    room.slipPool = [];
    room.allSlips = [];
    room.currentSlip = null;
    room.turnTimeRemaining = 0;
    room.turnGuessed = [];
    room.turnSkipped = [];
    room.carryoverTime = 0;

    // Clear player slips so they can submit new ones
    for (const p of room.players) {
      p.slips = [];
    }

    room.lastActivityAt = Date.now();
    this.broadcastPhaseChanged(room);
    this.broadcastRoomState(room.code);
    return null;
  }

  /** Draw the next unskipped slip from the pool */
  private drawNextSlip(room: Room): void {
    const available = room.slipPool.filter(
      (s) => !room.turnSkipped.includes(s.id)
    );
    room.currentSlip = available.length > 0 ? available[0] : null;
  }

  /** Send the current slip to the clue-giver only */
  private sendCurrentSlipToClueGiver(room: Room): void {
    if (!room.currentSlip || !room.activeClueGiverId) return;
    const client = this.clients.get(room.activeClueGiverId);
    if (!client) return;
    this.send(client.ws, {
      type: ServerMessageType.TurnStarted,
      clueGiverId: room.activeClueGiverId,
      team: room.activeTeam,
      timeRemaining: room.turnTimeRemaining,
      currentSlip: room.currentSlip,
    });
  }

  /** Start the server-authoritative turn timer */
  private startTurnTimer(room: Room): void {
    this.clearTurnTimer(room.code);
    const interval = setInterval(() => {
      room.turnTimeRemaining -= 1;

      this.broadcastToRoom(room.code, {
        type: ServerMessageType.TimerTick,
        timeRemaining: room.turnTimeRemaining,
      });

      if (room.turnTimeRemaining <= 0) {
        this.endTurn(room);
      }
    }, 1000);
    this.turnTimers.set(room.code, interval);
  }

  /** Clear an active turn timer */
  private clearTurnTimer(roomCode: string): void {
    const timer = this.turnTimers.get(roomCode);
    if (timer) {
      clearInterval(timer);
      this.turnTimers.delete(roomCode);
    }
  }

  /** End the current turn, handling round transitions and game over */
  private endTurn(room: Room): void {
    this.clearTurnTimer(room.code);
    room.currentSlip = null;

    const poolEmpty = room.slipPool.length === 0;
    const carryover = poolEmpty ? room.turnTimeRemaining : 0;

    // Broadcast turn-ended
    this.broadcastToRoom(room.code, {
      type: ServerMessageType.TurnEnded,
      guessedCount: room.turnGuessed.length,
      scores: { ...room.scores },
      ...(carryover > 0 ? { carryoverTime: carryover } : {}),
    });

    room.turnGuessed = [];
    room.turnSkipped = [];
    room.lastActivityAt = Date.now();

    if (poolEmpty) {
      // Round ended — all slips guessed
      const completedRound = room.round;

      if (room.roundNumber >= 3) {
        // Game over
        room.phase = GamePhase.GameOver;
        room.activeClueGiverId = null;
        room.turnTimeRemaining = 0;

        this.broadcastToRoom(room.code, {
          type: ServerMessageType.RoundEnded,
          completedRound,
          scores: { ...room.scores },
        });

        const winner: Team | "tie" =
          room.scores[Team.A] > room.scores[Team.B]
            ? Team.A
            : room.scores[Team.B] > room.scores[Team.A]
              ? Team.B
              : "tie";

        this.broadcastToRoom(room.code, {
          type: ServerMessageType.GameOver,
          scores: { ...room.scores },
          winner,
        });
      } else {
        // Advance to next round
        const nextRound =
          room.roundNumber === 1 ? RoundType.Charades : RoundType.OneWord;
        room.roundNumber += 1;
        room.round = nextRound;
        room.phase = GamePhase.RoundEnd;
        room.carryoverTime = carryover;
        // Don't switch team or advance clue-giver — carryover turn
        room.activeClueGiverId = null;
        room.turnTimeRemaining = 0;

        // Reshuffle all slips back into pool
        room.slipPool = [...room.allSlips].sort(() => Math.random() - 0.5);

        this.broadcastToRoom(room.code, {
          type: ServerMessageType.RoundEnded,
          completedRound,
          scores: { ...room.scores },
          nextRound,
        });
      }
    } else {
      // Normal turn end — pool still has slips
      room.phase = GamePhase.TurnEnd;

      // Advance clue-giver index for the active team
      const teamPlayers = room.players.filter(
        (p) => p.team === room.activeTeam,
      );
      if (teamPlayers.length > 0) {
        room.clueGiverIndex[room.activeTeam] =
          (room.clueGiverIndex[room.activeTeam] + 1) % teamPlayers.length;
      }

      // Switch active team
      room.activeTeam = room.activeTeam === Team.A ? Team.B : Team.A;
      room.activeClueGiverId = null;
      room.turnTimeRemaining = 0;
    }
  }

  /** Broadcast a message to all clients in a room */
  private broadcastToRoom(roomCode: string, message: ServerMessage): void {
    for (const client of this.getClientsInRoom(roomCode)) {
      this.send(client.ws, message);
    }
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
