export type GameMode = 'solo' | 'duel' | 'team';
export type TeamId = 'A' | 'B';
export type GameStatus =
  | 'waiting'
  | 'ready'
  | 'toss'
  | 'live'
  | 'inningsBreak'
  | 'completed';

export type TossChoice = 'bat' | 'bowl';

export interface TossState {
  winnerTeamId: TeamId;
  decisionMakerId: string;
  choice: TossChoice | null;
}

export interface PlayerState {
  id: string;
  socketId: string | null;
  name: string;
  teamId: TeamId;
  connected: boolean;
  isBot: boolean;
  isCaptain: boolean;
  runsScored: number;
  runsConceded: number;
  wicketsTaken: number;
  deliveriesPlayed: number;
  deliveriesBowled: number;
  currentSelection: number | null;
}

export interface TeamState {
  id: TeamId;
  name: string;
  playerIds: string[];
  captainId: string | null;
  score: number;
  wickets: number;
}

export interface RoundResult {
  batterId: string;
  bowlerId: string;
  batterNumber: number;
  bowlerNumber: number;
  runs: number;
  isOut: boolean;
  label: string;
  deliveryNumber: number;
  inningsNumber: 1 | 2;
  overNumber: number;
  ballInOver: number;
  battingTeamId: TeamId;
}

export interface InningsState {
  number: 1 | 2;
  battingTeamId: TeamId;
  bowlingTeamId: TeamId;
  currentBatterId: string | null;
  currentBowlerId: string | null;
  currentSpellBalls: number;
  pendingBowlerSelection: boolean;
  overHistory: { runs: number; isOut: boolean; label: string }[];
}

export interface GameStateSnapshot {
  inningsNumber: 1 | 2;
  currentBall: number;
  currentOver: number;
  totalBalls: number;
  strikerId: string | null;
  bowlerId: string | null;
  lastAction: string | null;
}

export interface MatchResult {
  winnerTeamId: TeamId | null;
  loserTeamId: TeamId | null;
  reason: 'allOut' | 'chaseComplete' | 'tie' | 'abandoned';
  margin: number;
  marginType: 'runs' | 'wickets' | 'tie' | 'abandoned';
  winningScore: number;
  losingScore: number;
}

export interface RoomState {
  id: string;
  mode: GameMode;
  status: GameStatus;
  teamSize: number;
  maxPlayers: number;
  players: PlayerState[];
  teams: TeamState[];
  toss: TossState | null;
  innings: InningsState | null;
  gameState: GameStateSnapshot;
  targetScore: number | null;
  currentTurn: number;
  lastRoundResult: RoundResult | null;
  rematchVotes: Record<string, 'same' | 'swap'>;
  result: MatchResult | null;
  createdAt: string;
  updatedAt: string;
  lastActionAt: string;
}

export interface PublicRoomState extends RoomState {
  awaitingPlayerIds: string[];
}
