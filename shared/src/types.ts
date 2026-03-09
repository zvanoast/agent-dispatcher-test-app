/** Which team a player belongs to */
export enum Team {
  A = "A",
  B = "B",
}

/** The three round types in Fishbowl */
export enum RoundType {
  Describe = "describe",
  Charades = "charades",
  OneWord = "one-word",
}

/** Phases of the game lifecycle */
export enum GamePhase {
  /** Room created, waiting for players to join */
  Lobby = "lobby",
  /** Players are submitting slips */
  Submitting = "submitting",
  /** Active gameplay */
  Playing = "playing",
  /** A turn is in progress */
  TurnActive = "turn-active",
  /** Between turns */
  TurnEnd = "turn-end",
  /** Between rounds */
  RoundEnd = "round-end",
  /** Game over, showing final scores */
  GameOver = "game-over",
}

/** A slip of paper with a name on it */
export interface Slip {
  id: string;
  text: string;
  submittedBy: string; // player ID
}

/** A player in the game */
export interface Player {
  id: string;
  name: string;
  team: Team | null;
  isHost: boolean;
  connected: boolean;
  slips: Slip[];
}

/** Full room state (server-authoritative) */
export interface Room {
  id: string;
  code: string;
  phase: GamePhase;
  players: Player[];
  round: RoundType;
  roundNumber: number; // 1, 2, or 3
  scores: Record<Team, number>;
  /** Which team is currently taking a turn */
  activeTeam: Team;
  /** Index into the team's player list for the current clue-giver */
  clueGiverIndex: Record<Team, number>;
  /** Current clue-giver player ID (null when no turn active) */
  activeClueGiverId: string | null;
  /** Slips remaining in the current round's pool */
  slipPool: Slip[];
  /** The slip currently being clued (null between turns) */
  currentSlip: Slip | null;
  /** Seconds remaining in the current turn */
  turnTimeRemaining: number;
  /** Slips guessed during the current turn */
  turnGuessed: Slip[];
  /** Slip IDs skipped during the current turn (cannot re-skip) */
  turnSkipped: string[];
  createdAt: number;
  lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// WebSocket Messages: Client → Server
// ---------------------------------------------------------------------------

export enum ClientMessageType {
  /** Join a room by code */
  JoinRoom = "join-room",
  /** Submit slips during the submitting phase */
  SubmitSlips = "submit-slips",
  /** Host: assign a player to a team */
  AssignTeam = "assign-team",
  /** Host: randomize teams */
  RandomizeTeams = "randomize-teams",
  /** Host: start the game (move from lobby → submitting) */
  StartGame = "start-game",
  /** Host: begin a turn */
  StartTurn = "start-turn",
  /** Clue-giver: mark current slip as guessed */
  GotIt = "got-it",
  /** Clue-giver: skip current slip */
  Skip = "skip",
  /** Host: start a new game with the same players */
  NewGame = "new-game",
}

export interface JoinRoomMessage {
  type: ClientMessageType.JoinRoom;
  roomCode: string;
  playerName: string;
}

export interface SubmitSlipsMessage {
  type: ClientMessageType.SubmitSlips;
  texts: string[];
}

export interface AssignTeamMessage {
  type: ClientMessageType.AssignTeam;
  playerId: string;
  team: Team;
}

export interface RandomizeTeamsMessage {
  type: ClientMessageType.RandomizeTeams;
}

export interface StartGameMessage {
  type: ClientMessageType.StartGame;
}

export interface StartTurnMessage {
  type: ClientMessageType.StartTurn;
}

export interface GotItMessage {
  type: ClientMessageType.GotIt;
}

export interface SkipMessage {
  type: ClientMessageType.Skip;
}

export interface NewGameMessage {
  type: ClientMessageType.NewGame;
}

export type ClientMessage =
  | JoinRoomMessage
  | SubmitSlipsMessage
  | AssignTeamMessage
  | RandomizeTeamsMessage
  | StartGameMessage
  | StartTurnMessage
  | GotItMessage
  | SkipMessage
  | NewGameMessage;

// ---------------------------------------------------------------------------
// WebSocket Messages: Server → Client
// ---------------------------------------------------------------------------

export enum ServerMessageType {
  /** Full room state sync (sent on join and after major transitions) */
  RoomState = "room-state",
  /** An error occurred */
  Error = "error",
  /** A player joined the room */
  PlayerJoined = "player-joined",
  /** A player left / disconnected */
  PlayerLeft = "player-left",
  /** Team assignments changed */
  TeamsUpdated = "teams-updated",
  /** Game phase changed */
  PhaseChanged = "phase-changed",
  /** A turn has started */
  TurnStarted = "turn-started",
  /** Timer tick (sent every second during a turn) */
  TimerTick = "timer-tick",
  /** A slip was guessed */
  SlipGuessed = "slip-guessed",
  /** A slip was skipped */
  SlipSkipped = "slip-skipped",
  /** The current turn ended */
  TurnEnded = "turn-ended",
  /** A round ended (all slips guessed) */
  RoundEnded = "round-ended",
  /** Game over */
  GameOver = "game-over",
  /** Room was created (sent to the host) */
  RoomCreated = "room-created",
}

/** Sanitized room state sent to clients (hides slip text when appropriate) */
export interface RoomStateMessage {
  type: ServerMessageType.RoomState;
  room: Room;
}

export interface ErrorMessage {
  type: ServerMessageType.Error;
  message: string;
}

export interface PlayerJoinedMessage {
  type: ServerMessageType.PlayerJoined;
  player: Player;
}

export interface PlayerLeftMessage {
  type: ServerMessageType.PlayerLeft;
  playerId: string;
}

export interface TeamsUpdatedMessage {
  type: ServerMessageType.TeamsUpdated;
  players: Player[];
}

export interface PhaseChangedMessage {
  type: ServerMessageType.PhaseChanged;
  phase: GamePhase;
  round?: RoundType;
  roundNumber?: number;
}

export interface TurnStartedMessage {
  type: ServerMessageType.TurnStarted;
  clueGiverId: string;
  team: Team;
  timeRemaining: number;
  /** The current slip — only sent to the active clue-giver */
  currentSlip?: Slip;
}

export interface TimerTickMessage {
  type: ServerMessageType.TimerTick;
  timeRemaining: number;
}

export interface SlipGuessedMessage {
  type: ServerMessageType.SlipGuessed;
  slip: Slip;
  team: Team;
}

export interface SlipSkippedMessage {
  type: ServerMessageType.SlipSkipped;
}

export interface TurnEndedMessage {
  type: ServerMessageType.TurnEnded;
  guessedCount: number;
  scores: Record<Team, number>;
  /** Carryover time if the round ended mid-turn */
  carryoverTime?: number;
}

export interface RoundEndedMessage {
  type: ServerMessageType.RoundEnded;
  completedRound: RoundType;
  scores: Record<Team, number>;
  nextRound?: RoundType;
}

export interface GameOverMessage {
  type: ServerMessageType.GameOver;
  scores: Record<Team, number>;
  winner: Team | "tie";
}

export interface RoomCreatedMessage {
  type: ServerMessageType.RoomCreated;
  roomCode: string;
  roomId: string;
}

export type ServerMessage =
  | RoomStateMessage
  | ErrorMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | TeamsUpdatedMessage
  | PhaseChangedMessage
  | TurnStartedMessage
  | TimerTickMessage
  | SlipGuessedMessage
  | SlipSkippedMessage
  | TurnEndedMessage
  | RoundEndedMessage
  | GameOverMessage
  | RoomCreatedMessage;
