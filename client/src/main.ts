import {
  type Room,
  type Player,
  type Slip,
  type ServerMessage,
  GamePhase,
  Team,
  RoundType,
  ClientMessageType,
  ServerMessageType,
} from "@fishbowl/shared";
import { WsClient } from "./ws.js";
import "./style.css";

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------

interface AppState {
  screen: "landing" | "room";
  room: Room | null;
  myPlayerId: string | null;
  wsStatus: "connecting" | "connected" | "disconnected";
  currentSlip: Slip | null;       // only set for clue-giver
  timeRemaining: number;
  slipsSubmitted: boolean;
  errorMessage: string | null;
  errorTimeout: ReturnType<typeof setTimeout> | null;
  turnGuessedCount: number | null; // shown between turns
  turnScores: Record<Team, number> | null;
  roundEndInfo: { completedRound: RoundType; scores: Record<Team, number>; nextRound?: RoundType } | null;
  gameOverInfo: { scores: Record<Team, number>; winner: Team | "tie" } | null;
}

const state: AppState = {
  screen: "landing",
  room: null,
  myPlayerId: null,
  wsStatus: "disconnected",
  currentSlip: null,
  timeRemaining: 0,
  slipsSubmitted: false,
  errorMessage: null,
  errorTimeout: null,
  turnGuessedCount: null,
  turnScores: null,
  roundEndInfo: null,
  gameOverInfo: null,
};

const app = document.querySelector<HTMLDivElement>("#app")!;

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const ws = new WsClient(handleServerMessage, (status) => {
  state.wsStatus = status;
  if (status === "disconnected" && state.screen === "room") {
    showError("Disconnected from server");
  }
  render();
});

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case ServerMessageType.RoomState:
      state.room = msg.room;
      state.slipsSubmitted = getMyPlayer()?.slips.length === 4;
      // Clear transient turn state on full state sync
      state.currentSlip = null;
      state.turnGuessedCount = null;
      state.turnScores = null;
      break;

    case ServerMessageType.RoomCreated:
      // myPlayerId is the first player (host) — set from next room-state
      break;

    case ServerMessageType.PlayerJoined:
      if (state.room) {
        // If this is the first player-joined after our connect, detect our ID
        if (!state.myPlayerId) {
          state.myPlayerId = msg.player.id;
        }
        const existing = state.room.players.find(p => p.id === msg.player.id);
        if (!existing) {
          state.room.players.push(msg.player);
        } else {
          Object.assign(existing, msg.player);
        }
      }
      break;

    case ServerMessageType.PlayerLeft:
      if (state.room) {
        state.room.players = state.room.players.filter(p => p.id !== msg.playerId);
      }
      break;

    case ServerMessageType.TeamsUpdated:
      if (state.room) {
        state.room.players = msg.players;
      }
      break;

    case ServerMessageType.PhaseChanged:
      if (state.room) {
        state.room.phase = msg.phase;
        if (msg.round) state.room.round = msg.round;
        if (msg.roundNumber) state.room.roundNumber = msg.roundNumber;
      }
      state.currentSlip = null;
      state.roundEndInfo = null;
      break;

    case ServerMessageType.TurnStarted:
      if (state.room) {
        state.room.activeClueGiverId = msg.clueGiverId;
        state.room.activeTeam = msg.team;
      }
      state.timeRemaining = msg.timeRemaining;
      state.currentSlip = msg.currentSlip ?? null;
      state.turnGuessedCount = null;
      state.turnScores = null;
      state.roundEndInfo = null;
      break;

    case ServerMessageType.TimerTick:
      state.timeRemaining = msg.timeRemaining;
      break;

    case ServerMessageType.SlipGuessed:
      // Update current slip display — clue-giver will get a new turn-started or similar
      // The room-state update will follow
      break;

    case ServerMessageType.SlipSkipped:
      break;

    case ServerMessageType.TurnEnded:
      state.turnGuessedCount = msg.guessedCount;
      state.turnScores = msg.scores;
      state.currentSlip = null;
      if (state.room) {
        state.room.scores = msg.scores;
        state.room.activeClueGiverId = null;
        state.room.phase = GamePhase.TurnEnd;
      }
      break;

    case ServerMessageType.RoundEnded:
      state.roundEndInfo = {
        completedRound: msg.completedRound,
        scores: msg.scores,
        nextRound: msg.nextRound,
      };
      if (state.room) {
        state.room.scores = msg.scores;
        state.room.phase = GamePhase.RoundEnd;
      }
      break;

    case ServerMessageType.GameOver:
      state.gameOverInfo = { scores: msg.scores, winner: msg.winner };
      if (state.room) {
        state.room.scores = msg.scores;
        state.room.phase = GamePhase.GameOver;
      }
      break;

    case ServerMessageType.Error:
      showError(msg.message);
      break;
  }
  render();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMyPlayer(): Player | undefined {
  return state.room?.players.find(p => p.id === state.myPlayerId);
}

function amHost(): boolean {
  return getMyPlayer()?.isHost ?? false;
}

function amClueGiver(): boolean {
  return state.room?.activeClueGiverId === state.myPlayerId;
}

function showError(message: string): void {
  if (state.errorTimeout) clearTimeout(state.errorTimeout);
  state.errorMessage = message;
  state.errorTimeout = setTimeout(() => {
    state.errorMessage = null;
    render();
  }, 4000);
}

function roundLabel(r: RoundType): string {
  switch (r) {
    case RoundType.Describe: return "Describe";
    case RoundType.Charades: return "Charades";
    case RoundType.OneWord: return "One Word";
  }
}

function esc(text: string): string {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  if (state.screen === "landing") {
    renderLanding();
  } else {
    renderRoom();
  }

  // Error toast
  const existing = document.querySelector(".error-toast");
  if (existing) existing.remove();
  if (state.errorMessage) {
    const toast = document.createElement("div");
    toast.className = "error-toast";
    toast.textContent = state.errorMessage;
    document.body.appendChild(toast);
  }
}

function renderLanding(): void {
  app.innerHTML = `
    <div class="landing">
      <h1>Fishbowl</h1>
      <div class="landing-actions">
        <div class="stack">
          <input type="text" id="player-name" placeholder="Your name" maxlength="20" />
        </div>
        <button class="btn-primary" id="btn-create">Create Room</button>
        <div class="join-form">
          <input type="text" id="room-code" placeholder="Room code (e.g. ABCD)" maxlength="4"
                 style="text-transform:uppercase; text-align:center; letter-spacing:4px; font-size:1.2rem" />
          <button class="btn-secondary" id="btn-join">Join Room</button>
        </div>
      </div>
    </div>
  `;

  const nameInput = document.getElementById("player-name") as HTMLInputElement;
  const codeInput = document.getElementById("room-code") as HTMLInputElement;

  document.getElementById("btn-create")!.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) { showError("Enter your name"); render(); return; }
    // Generate a random 4-char code — server will create room if it doesn't exist
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    joinRoom(code, name);
  });

  document.getElementById("btn-join")!.addEventListener("click", () => {
    const name = nameInput.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    if (!name) { showError("Enter your name"); render(); return; }
    if (!code || code.length !== 4) { showError("Enter a 4-character room code"); render(); return; }
    joinRoom(code, name);
  });

  // Allow enter key on inputs
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-join")!.click();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-create")!.click();
  });
}

function joinRoom(code: string, name: string): void {
  state.screen = "room";
  state.myPlayerId = null;
  state.room = null;
  state.slipsSubmitted = false;
  state.currentSlip = null;
  state.turnGuessedCount = null;
  state.turnScores = null;
  state.roundEndInfo = null;
  state.gameOverInfo = null;
  ws.connect(code, name);
  render();
}

function renderRoom(): void {
  if (!state.room) {
    app.innerHTML = `<div class="center"><p class="status">Connecting...</p></div>`;
    return;
  }

  // Detect my player ID from room state if not yet set
  if (!state.myPlayerId && state.room.players.length > 0) {
    // The last player added is most likely us if we just connected
    state.myPlayerId = state.room.players[state.room.players.length - 1].id;
  }

  const room = state.room;
  const phase = room.phase;

  let html = "";

  // Room code header
  html += `<div class="room-code">${esc(room.code)}</div>`;

  // Scoreboard (show when not in lobby)
  if (phase !== GamePhase.Lobby) {
    html += renderScoreboard(room);
  }

  switch (phase) {
    case GamePhase.Lobby:
      html += renderLobby(room);
      break;
    case GamePhase.Submitting:
      html += renderSubmitting(room);
      break;
    case GamePhase.Playing:
    case GamePhase.TurnActive:
      html += renderPlaying(room);
      break;
    case GamePhase.TurnEnd:
      html += renderTurnEnd(room);
      break;
    case GamePhase.RoundEnd:
      html += renderRoundEnd();
      break;
    case GamePhase.GameOver:
      html += renderGameOver();
      break;
  }

  app.innerHTML = html;
  bindRoomEvents(phase);
}

function renderScoreboard(room: Room): string {
  return `
    <div class="scoreboard">
      <div class="score-block score-a">
        <div class="team-label">Team A</div>
        <div class="score-value">${room.scores[Team.A]}</div>
      </div>
      <div class="score-block score-b">
        <div class="team-label">Team B</div>
        <div class="score-value">${room.scores[Team.B]}</div>
      </div>
    </div>
  `;
}

function renderLobby(room: Room): string {
  const teamA = room.players.filter(p => p.team === Team.A);
  const teamB = room.players.filter(p => p.team === Team.B);
  const unassigned = room.players.filter(p => p.team === null);

  let html = `<h2>Lobby</h2>`;

  // Teams
  html += `<div class="teams-container">
    <div class="team-column team-a">
      <h3>Team A</h3>
      ${teamA.map(p => playerItem(p)).join("")}
      ${teamA.length === 0 ? '<p class="status" style="font-size:0.85rem">No players</p>' : ""}
    </div>
    <div class="team-column team-b">
      <h3>Team B</h3>
      ${teamB.map(p => playerItem(p)).join("")}
      ${teamB.length === 0 ? '<p class="status" style="font-size:0.85rem">No players</p>' : ""}
    </div>
  </div>`;

  // Unassigned
  if (unassigned.length > 0) {
    html += `<div class="unassigned-section section">
      <h3>Unassigned</h3>
      <ul class="player-list">
        ${unassigned.map(p => `<li class="player-item">
          <span class="player-name">${esc(p.name)}${p.isHost ? ' <span class="player-host">HOST</span>' : ""}</span>
          ${amHost() ? `
            <div class="row">
              <button class="btn-small btn-danger assign-team" data-player="${p.id}" data-team="A">A</button>
              <button class="btn-small btn-primary assign-team" data-player="${p.id}" data-team="B" style="background:#3498db">B</button>
            </div>
          ` : ""}
        </li>`).join("")}
      </ul>
    </div>`;
  }

  // Host controls
  if (amHost()) {
    html += `<div class="host-controls">
      <button class="btn-secondary" id="btn-randomize">Randomize Teams</button>
      <button class="btn-primary" id="btn-start-game"
        ${room.players.length < 2 ? "disabled" : ""}>Start Game</button>
    </div>`;
  } else {
    html += `<p class="waiting">Waiting for host to start the game...</p>`;
  }

  // Players count
  html += `<p class="status">${room.players.length} player${room.players.length !== 1 ? "s" : ""} in room</p>`;

  return html;
}

function playerItem(p: Player): string {
  return `<div class="player-item ${p.connected ? "" : "player-disconnected"}">
    <span class="player-name">${esc(p.name)}${p.isHost ? ' <span class="player-host">HOST</span>' : ""}</span>
  </div>`;
}

function renderSubmitting(room: Room): string {
  const me = getMyPlayer();
  const mySlipsSubmitted = me && me.slips.length === 4;
  const allSubmitted = room.players.every(p => p.slips.length === 4);
  const submittedCount = room.players.filter(p => p.slips.length === 4).length;

  let html = `<div class="round-info">Submit your slips!</div>`;
  html += `<p class="status">${submittedCount} / ${room.players.length} players submitted</p>`;

  // Players status
  html += `<div class="section">
    <ul class="player-list">
      ${room.players.map(p => `<li class="player-item">
        <span class="player-name">${esc(p.name)}</span>
        ${p.slips.length === 4 ? '<span class="player-slips-done">Done</span>' : '<span style="color:#e74c3c;font-size:0.85rem">Pending</span>'}
      </li>`).join("")}
    </ul>
  </div>`;

  if (mySlipsSubmitted || state.slipsSubmitted) {
    html += `<div class="slips-submitted">Your slips are in! Waiting for others...</div>`;
  } else {
    html += `<div class="section">
      <h3>Enter 4 names</h3>
      <div class="slip-form">
        <input type="text" class="slip-input" id="slip-1" placeholder="Name 1" maxlength="40" />
        <input type="text" class="slip-input" id="slip-2" placeholder="Name 2" maxlength="40" />
        <input type="text" class="slip-input" id="slip-3" placeholder="Name 3" maxlength="40" />
        <input type="text" class="slip-input" id="slip-4" placeholder="Name 4" maxlength="40" />
        <div id="slip-validation" class="slip-validation"></div>
        <button class="btn-success" id="btn-submit-slips">Submit Slips</button>
      </div>
    </div>`;
  }

  if (amHost() && allSubmitted) {
    html += `<p class="status">All slips submitted! Game will begin.</p>`;
  }

  return html;
}

function renderPlaying(room: Room): string {
  const isClueGiver = amClueGiver();
  const clueGiver = room.players.find(p => p.id === room.activeClueGiverId);
  const isActive = room.phase === GamePhase.TurnActive || room.activeClueGiverId !== null;

  let html = `<div class="round-info">Round ${room.roundNumber}: ${roundLabel(room.round)}</div>`;

  if (isActive && clueGiver) {
    // Active turn
    html += `<div class="turn-info">
      <strong>${esc(clueGiver.name)}</strong> is giving clues
      (Team ${room.activeTeam})
    </div>`;

    // Timer
    const low = state.timeRemaining <= 10;
    html += `<div class="timer ${low ? "low" : ""}">${state.timeRemaining}s</div>`;

    if (isClueGiver && state.currentSlip) {
      // Clue-giver sees the slip and action buttons
      html += `<div class="slip-card">${esc(state.currentSlip.text)}</div>`;
      html += `<div class="game-actions">
        <button class="btn-success" id="btn-got-it">Got It!</button>
        <button class="btn-danger" id="btn-skip">Skip (-5s)</button>
      </div>`;
    } else if (isClueGiver) {
      html += `<div class="slip-card">Waiting for slip...</div>`;
    } else {
      html += `<div class="status">Watch and guess!</div>`;
    }

    // Slips remaining
    html += `<p class="status" style="margin-top:12px">${room.slipPool.length} slips remaining</p>`;
  } else {
    // Between turns — waiting for host to start turn
    html += `<div class="turn-info">
      Team ${room.activeTeam}'s turn
    </div>`;

    if (amHost()) {
      html += `<button class="btn-primary" id="btn-start-turn">Start Turn</button>`;
    } else {
      html += `<p class="waiting">Waiting for host to start the turn...</p>`;
    }

    html += `<p class="status" style="margin-top:12px">${room.slipPool.length} slips remaining</p>`;
  }

  return html;
}

function renderTurnEnd(_room: Room): string {
  let html = `<div class="turn-summary">
    <h2>Turn Over!</h2>`;

  if (state.turnGuessedCount !== null) {
    html += `<p class="guessed-count">${state.turnGuessedCount} slips guessed</p>`;
  }

  if (state.turnScores) {
    html += `<div class="scoreboard" style="margin-top:16px">
      <div class="score-block score-a">
        <div class="team-label">Team A</div>
        <div class="score-value">${state.turnScores[Team.A]}</div>
      </div>
      <div class="score-block score-b">
        <div class="team-label">Team B</div>
        <div class="score-value">${state.turnScores[Team.B]}</div>
      </div>
    </div>`;
  }

  html += `</div>`;

  if (amHost()) {
    html += `<button class="btn-primary" id="btn-start-turn" style="margin-top:16px">Start Next Turn</button>`;
  } else {
    html += `<p class="waiting">Waiting for host to start the next turn...</p>`;
  }

  return html;
}

function renderRoundEnd(): string {
  let html = `<div class="turn-summary">
    <h2>Round Complete!</h2>`;

  if (state.roundEndInfo) {
    html += `<p style="margin:8px 0">Finished: ${roundLabel(state.roundEndInfo.completedRound)}</p>`;
    if (state.roundEndInfo.nextRound) {
      html += `<p style="margin:8px 0">Next up: <strong>${roundLabel(state.roundEndInfo.nextRound)}</strong></p>`;
    }
  }

  html += `</div>`;

  if (amHost()) {
    html += `<button class="btn-primary" id="btn-start-turn" style="margin-top:16px">Start Next Round</button>`;
  } else {
    html += `<p class="waiting">Waiting for host to start the next round...</p>`;
  }

  return html;
}

function renderGameOver(): string {
  let html = `<div class="game-over">
    <h2>Game Over!</h2>`;

  if (state.gameOverInfo) {
    const w = state.gameOverInfo.winner;
    html += `<div class="winner">${w === "tie" ? "It's a tie!" : `Team ${w} wins!`}</div>`;
  }

  html += `</div>`;

  if (amHost()) {
    html += `<button class="btn-primary" id="btn-new-game" style="margin-top:16px">New Game</button>`;
  }

  return html;
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function bindRoomEvents(phase: GamePhase): void {
  // Lobby events
  document.getElementById("btn-randomize")?.addEventListener("click", () => {
    ws.send({ type: ClientMessageType.RandomizeTeams });
  });

  document.getElementById("btn-start-game")?.addEventListener("click", () => {
    ws.send({ type: ClientMessageType.StartGame });
  });

  document.querySelectorAll<HTMLButtonElement>(".assign-team").forEach(btn => {
    btn.addEventListener("click", () => {
      const playerId = btn.dataset.player!;
      const team = btn.dataset.team as Team;
      ws.send({ type: ClientMessageType.AssignTeam, playerId, team });
    });
  });

  // Slip submission
  document.getElementById("btn-submit-slips")?.addEventListener("click", () => {
    const inputs = [1, 2, 3, 4].map(i =>
      (document.getElementById(`slip-${i}`) as HTMLInputElement).value.trim()
    );
    const empty = inputs.filter(t => !t).length;
    const validation = document.getElementById("slip-validation")!;

    if (empty > 0) {
      validation.textContent = `Please fill in all 4 slips (${empty} empty)`;
      return;
    }

    ws.send({ type: ClientMessageType.SubmitSlips, texts: inputs });
    state.slipsSubmitted = true;
    render();
  });

  // Game controls
  document.getElementById("btn-start-turn")?.addEventListener("click", () => {
    ws.send({ type: ClientMessageType.StartTurn });
  });

  document.getElementById("btn-got-it")?.addEventListener("click", () => {
    ws.send({ type: ClientMessageType.GotIt });
  });

  document.getElementById("btn-skip")?.addEventListener("click", () => {
    ws.send({ type: ClientMessageType.Skip });
  });

  document.getElementById("btn-new-game")?.addEventListener("click", () => {
    ws.send({ type: ClientMessageType.NewGame });
  });
}

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

render();
