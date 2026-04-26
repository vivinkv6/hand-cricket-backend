import { Injectable } from '@nestjs/common';
import type {
  GameMode,
  InningsState,
  MatchResult,
  PlayerState,
  PublicRoomState,
  RoomState,
  RoundResult,
  TeamId,
  TeamState,
  TossChoice,
  TossState,
} from '../types/game.types';
import {
  normalizePlayerName,
  validatePlayerName,
} from '../utils/player-name.util';

const TEAM_IDS: TeamId[] = ['A', 'B'];

@Injectable()
export class GameEngine {
  createRoom(
    mode: GameMode,
    ownerName: string,
    socketId: string,
    teamSize?: number,
  ): RoomState {
    const normalizedTeamSize =
      mode === 'team' ? this.clampTeamSize(teamSize ?? 2) : 1;
    const roomId = this.createRoomId();
    const owner = this.createPlayer(ownerName, 'A', socketId);
    const players = [owner];

    if (mode === 'solo') {
      players.push(this.createBotPlayer('B'));
    }

    const room: RoomState = {
      id: roomId,
      mode,
      status: mode === 'solo' ? 'ready' : 'waiting',
      teamSize: normalizedTeamSize,
      maxPlayers: mode === 'team' ? normalizedTeamSize * 2 : 2,
      players,
      teams: [
        this.createTeam('A', [owner.id]),
        this.createTeam('B', mode === 'solo' ? [players[1].id] : []),
      ],
      toss: null,
      innings: null,
      gameState: {
        inningsNumber: 1,
        currentBall: 1,
        currentOver: 1,
        totalBalls: 0,
        strikerId: null,
        bowlerId: null,
        lastAction: 'room_created',
      },
      targetScore: null,
      currentTurn: 0,
      lastRoundResult: null,
      rematchVotes: {},
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActionAt: new Date().toISOString(),
    };

    return this.refreshDerivedState(room);
  }

  joinRoom(
    room: RoomState,
    playerName: string,
    socketId: string,
    requestedPlayerId?: string,
  ): RoomState {
    const normalizedPlayerName = validatePlayerName(playerName);
    const duplicate = requestedPlayerId
      ? room.players.find((player) => player.id === requestedPlayerId)
      : undefined;

    if (duplicate) {
      if (duplicate.connected) {
        throw new Error('Player is already connected to this room.');
      }

      duplicate.connected = true;
      duplicate.socketId = socketId;
      return this.refreshDerivedState(room);
    }

    if (
      room.players.filter((player) => !player.isBot).length >= room.maxPlayers
    ) {
      throw new Error('Room is full.');
    }

    const duplicateName = room.players.find(
      (player) =>
        !player.isBot &&
        player.connected &&
        normalizePlayerName(player.name).toLowerCase() ===
          normalizedPlayerName.toLowerCase(),
    );

    if (duplicateName) {
      throw new Error('That player name is already being used in this room.');
    }

    const teamId = this.pickJoinTeam(room);
    const player = this.createPlayer(normalizedPlayerName, teamId, socketId);
    room.players.push(player);
    this.getTeam(room, teamId).playerIds.push(player.id);

    return this.refreshDerivedState(room);
  }

  rejoinRoom(room: RoomState, playerId: string, socketId: string): RoomState {
    const player = this.getPlayer(room, playerId);
    player.connected = true;
    player.socketId = socketId;
    return this.refreshDerivedState(room);
  }

  rejoinRoomByIdentity(
    room: RoomState,
    identity: { playerId?: string; playerName?: string },
    socketId: string,
  ): RoomState {
    const player =
      (identity.playerId
        ? room.players.find((entry) => entry.id === identity.playerId)
        : null) ??
      (identity.playerName
        ? room.players.find(
            (entry) =>
              !entry.isBot &&
              normalizePlayerName(entry.name).toLowerCase() ===
                normalizePlayerName(identity.playerName!).toLowerCase(),
          )
        : null);

    if (!player) {
      throw new Error('Unable to find your saved player session in this room.');
    }

    player.connected = true;
    player.socketId = socketId;
    return this.refreshDerivedState(room);
  }

disconnectPlayer(room: RoomState, socketId: string): RoomState {
    const player = room.players.find((entry) => entry.socketId === socketId);
    if (!player) {
      return room;
    }

    const playerLeft = player;
    
    const shouldRemove = room.mode !== 'solo' && 
      !['completed'].includes(room.status);
    
    if (shouldRemove) {
      const teamId = player.teamId;
      room.players = room.players.filter((p) => p.socketId !== socketId);
      const team = room.teams.find((t) => t.id === teamId);
      if (team) {
        team.playerIds = team.playerIds.filter((id) => id !== player.id);
        if (team.captainId === player.id) {
          team.captainId = null;
        }
      }
      return this.refreshDerivedState(room);
    }

    player.connected = false;
    player.socketId = null;

    return this.refreshDerivedState(room);
  }

  startGame(room: RoomState, playerId: string): RoomState {
    if (!['ready', 'waiting', 'toss'].includes(room.status)) {
      throw new Error('Game has already started.');
    }

    if (!this.canStart(room)) {
      throw new Error('Not enough players to start the match.');
    }

    const player = this.getPlayer(room, playerId);
    if (!player.isCaptain) {
      throw new Error('Only a captain can start the match.');
    }

    if (room.status === 'toss' && room.toss) {
      return this.refreshDerivedState(room);
    }

    TEAM_IDS.forEach((teamId) => {
      if (!this.getTeam(room, teamId).captainId) {
        this.assignCaptain(room, teamId);
      }
    });

    room.status = 'toss';
    room.targetScore = null;
    room.result = null;
    room.currentTurn = 0;
    room.lastRoundResult = null;
    room.rematchVotes = {};
    room.innings = null;
    room.toss = this.createToss(room);

    return this.refreshDerivedState(room);
  }

  selectToss(room: RoomState, playerId: string, choice: TossChoice): RoomState {
    if (room.status !== 'toss' || !room.toss) {
      throw new Error('Toss is not active right now.');
    }

    if (room.toss.decisionMakerId !== playerId) {
      throw new Error('Only the toss winner can decide bat or bowl.');
    }

    room.toss.choice = choice;
    this.resetScores(room);

    const battingTeamId =
      choice === 'bat'
        ? room.toss.winnerTeamId
        : this.otherTeam(room.toss.winnerTeamId);
    const bowlingTeamId = this.otherTeam(battingTeamId);

    room.status = 'live';
    room.innings = this.createInnings(room, 1, battingTeamId, bowlingTeamId);
    room.toss = null;

    return this.refreshDerivedState(room);
  }

  selectBowler(room: RoomState, playerId: string, bowlerId: string): RoomState {
    const innings = this.requireInnings(room);
    const selector = this.getPlayer(room, playerId);
    const bowler = this.getPlayer(room, bowlerId);
    const bowlingTeam = this.getTeam(room, innings.bowlingTeamId);

    if (!selector.isCaptain || selector.teamId !== innings.bowlingTeamId) {
      throw new Error('Only the bowling captain can choose the bowler.');
    }

    if (!bowlingTeam.playerIds.includes(bowlerId)) {
      throw new Error('Selected bowler is not on the bowling side.');
    }

    innings.currentBowlerId = bowler.id;
    innings.currentSpellBalls = 0;
    innings.pendingBowlerSelection = false;
    innings.overHistory = [];
    bowler.currentSelection = null;

    return this.refreshDerivedState(room);
  }

  renameTeam(
    room: RoomState,
    playerId: string,
    teamId: TeamId,
    name: string,
  ): RoomState {
    const player = this.getPlayer(room, playerId);
    const team = this.getTeam(room, teamId);

    if (!player.isCaptain || player.teamId !== teamId) {
      throw new Error('Only the team captain can rename the team.');
    }

    team.name = name.trim().slice(0, 24) || team.name;
    return this.refreshDerivedState(room);
  }

  movePlayer(
    room: RoomState,
    playerId: string,
    targetTeamId: TeamId,
  ): RoomState {
    if (!['waiting', 'ready', 'completed'].includes(room.status)) {
      throw new Error(
        'Teams can only be changed in the lobby or rematch state.',
      );
    }

    const player = this.getPlayer(room, playerId);
    const sourceTeam = this.getTeam(room, player.teamId);
    const targetTeam = this.getTeam(room, targetTeamId);

    if (sourceTeam.id === targetTeam.id) {
      return this.refreshDerivedState(room);
    }

    if (targetTeam.playerIds.length >= room.teamSize) {
      throw new Error('That team is already full.');
    }

    sourceTeam.playerIds = sourceTeam.playerIds.filter(
      (id) => id !== player.id,
    );
    targetTeam.playerIds.push(player.id);
    player.teamId = targetTeamId;

    if (player.isCaptain) {
      player.isCaptain = false;
      sourceTeam.captainId = null;
      this.assignCaptain(room, sourceTeam.id);
    }

    room.status = this.canStart(room) ? 'ready' : 'waiting';
    return this.refreshDerivedState(room);
  }

  selectNumber(
    room: RoomState,
    playerId: string,
    value: number,
  ): {
    room: RoomState;
    events: Array<{ type: 'switchInnings' | 'gameOver'; payload: unknown }>;
  } {
    const innings = this.requireInnings(room);
    if (
      innings.pendingBowlerSelection ||
      !innings.currentBowlerId ||
      !innings.currentBatterId
    ) {
      throw new Error(
        'A bowler must be selected before numbers can be played.',
      );
    }

    if (value < 1 || value > 6) {
      throw new Error('Selections must be between 1 and 6.');
    }

    const player = this.getPlayer(room, playerId);
    if (
      ![innings.currentBatterId, innings.currentBowlerId].includes(player.id)
    ) {
      throw new Error("It is not this player's turn.");
    }

    if (player.currentSelection !== null) {
      throw new Error('Selection already locked for this delivery.');
    }

    player.currentSelection = value;

    const batter = this.getPlayer(room, innings.currentBatterId);
    const bowler = this.getPlayer(room, innings.currentBowlerId);

    if (bowler.isBot && bowler.currentSelection === null) {
      bowler.currentSelection = this.rollBotNumber();
    }

    if (batter.isBot && batter.currentSelection === null) {
      batter.currentSelection = this.rollBotNumber();
    }

    if (batter.currentSelection === null || bowler.currentSelection === null) {
      return {
        room: this.refreshDerivedState(room),
        events: [],
      };
    }

    return this.resolveDelivery(room, batter, bowler, innings);
  }

  requestRematch(
    room: RoomState,
    playerId: string,
    preference: 'same' | 'swap',
  ): RoomState {
    if (room.status !== 'completed') {
      throw new Error('Rematch is only available after the game ends.');
    }

    this.getPlayer(room, playerId);
    room.rematchVotes[playerId] = preference;

    const humanPlayers = room.players.filter((player) => !player.isBot);
    const allVoted = humanPlayers.every((player) => room.rematchVotes[player.id]);
    
    if (allVoted) {
      if (Object.values(room.rematchVotes).some((vote) => vote === 'swap')) {
        this.swapSides(room);
      }

      // Preserve player connection state and isBot flags before reset
      const playerConnectionMap = new Map(
        room.players.map(p => [p.id, { connected: p.connected, isBot: p.isBot, socketId: p.socketId }])
      );

      room.status = this.canStart(room) ? 'ready' : 'waiting';
      room.result = null;
      room.targetScore = null;
      room.toss = null;
      room.innings = null;
      room.currentTurn = 0;
      room.lastRoundResult = null;
      room.rematchVotes = {};
      this.resetScores(room);
      TEAM_IDS.forEach((teamId) => this.assignCaptain(room, teamId));

      // Restore player connection state
      room.players.forEach(p => {
        const saved = playerConnectionMap.get(p.id);
        if (saved) {
          p.connected = saved.connected;
          p.isBot = saved.isBot;
          p.socketId = saved.socketId;
        }
      });
    }

    return this.refreshDerivedState(room);
  }

  endGameForDisconnect(room: RoomState, disconnectedPlayerId: string): RoomState {
    const disconnectedPlayer = room.players.find(p => p.id === disconnectedPlayerId);
    if (!disconnectedPlayer) {
      return room;
    }

    const winnerTeamId = disconnectedPlayer.teamId === 'A' ? 'B' : 'A';
    const winnerTeam = room.teams.find(t => t.id === winnerTeamId);
    
    room.status = 'completed';
    room.result = {
      winnerTeamId,
      loserTeamId: disconnectedPlayer.teamId,
      reason: 'abandoned',
      margin: 0,
      marginType: 'abandoned',
      winningScore: winnerTeam?.score ?? 0,
      losingScore: disconnectedPlayer.teamId === 'A' 
        ? room.teams.find(t => t.id === 'A')?.score ?? 0
        : room.teams.find(t => t.id === 'B')?.score ?? 0,
    };

    return this.refreshDerivedState(room);
  }

  toPublicState(room: RoomState): PublicRoomState {
    return {
      ...room,
      awaitingPlayerIds: this.getAwaitingPlayerIds(room),
    };
  }

  private resolveDelivery(
    room: RoomState,
    batter: PlayerState,
    bowler: PlayerState,
    innings: InningsState,
  ): {
    room: RoomState;
    events: Array<{ type: 'switchInnings' | 'gameOver'; payload: unknown }>;
  } {
    room.currentTurn += 1;
    room.lastActionAt = new Date().toISOString();

    batter.deliveriesPlayed += 1;
    bowler.deliveriesBowled += 1;
    innings.currentSpellBalls += 1;
    const ballInOver = ((room.currentTurn - 1) % 6) + 1;
    const overNumber = Math.floor((room.currentTurn - 1) / 6) + 1;

    const battingTeam = this.getTeam(room, innings.battingTeamId);
    const batterNumber = batter.currentSelection!;
    const bowlerNumber = bowler.currentSelection!;
    const isOut = batterNumber === bowlerNumber;
    const runs = isOut ? 0 : batterNumber;

    if (runs > 0) {
      battingTeam.score += runs;
      batter.runsScored += runs;
      bowler.runsConceded += runs;
    }

    let label = `${runs} run${runs === 1 ? '' : 's'}`;
    if (runs === 4) {
      label = 'FOUR';
    }
    if (runs === 6) {
      label = 'SIX';
    }

    if (isOut) {
      battingTeam.wickets += 1;
      bowler.wicketsTaken += 1;
      label = 'Wicket';
    }



    const result: RoundResult = {
      batterId: batter.id,
      bowlerId: bowler.id,
      batterNumber,
      bowlerNumber,
      runs,
      isOut,
      label,
      deliveryNumber: room.currentTurn,
      inningsNumber: innings.number,
      overNumber,
      ballInOver,
      battingTeamId: battingTeam.id,
    };

    room.lastRoundResult = result;
    batter.currentSelection = null;
    bowler.currentSelection = null;

    const emittedEvents: Array<{
      type: 'switchInnings' | 'gameOver';
      payload: unknown;
    }> = [];

    innings.overHistory = [...innings.overHistory, { runs, isOut, label }].slice(
      -6,
    );

    if (isOut) {

      innings.currentBatterId = this.getNextBatterId(
        room,
        innings.battingTeamId,
      );
    }

    if (room.targetScore && battingTeam.score >= room.targetScore) {
      room.status = 'completed';
      room.result = this.createMatchResult(room, 'chaseComplete');
      emittedEvents.push({ type: 'gameOver', payload: room.result });
    } else if (
      battingTeam.wickets >= battingTeam.playerIds.length ||
      !innings.currentBatterId
    ) {
      if (innings.number === 1) {
        room.status = 'inningsBreak';
        room.targetScore = battingTeam.score + 1;
        room.currentTurn = 0;
        room.innings = this.createInnings(
          room,
          2,
          innings.bowlingTeamId,
          innings.battingTeamId,
        );
        room.innings.overHistory = [];
        emittedEvents.push({
          type: 'switchInnings',
          payload: {
            targetScore: room.targetScore,
            innings: room.innings,
          },
        });
        room.status = 'live';
      } else {
        room.status = 'completed';
        room.result = this.createMatchResult(room, 'allOut');
        emittedEvents.push({ type: 'gameOver', payload: room.result });
      }
    } else if (innings.currentSpellBalls >= 6) {
      innings.currentBowlerId = null;
      innings.pendingBowlerSelection = true;
    }

    return {
      room: this.refreshDerivedState(room),
      events: emittedEvents,
    };
  }

  private createMatchResult(
    room: RoomState,
    reason: MatchResult['reason'],
  ): MatchResult {
    const [teamA, teamB] = TEAM_IDS.map((teamId) => this.getTeam(room, teamId));

    if (teamA.score === teamB.score) {
      return {
        winnerTeamId: null,
        loserTeamId: null,
        reason: 'tie',
        margin: 0,
        marginType: 'tie',
        winningScore: teamA.score,
        losingScore: teamB.score,
      };
    }

    const winner = teamA.score > teamB.score ? teamA : teamB;
    const loser = winner.id === 'A' ? teamB : teamA;
    const wicketsRemaining =
      this.getTeamPlayerCount(room, winner.id) - winner.wickets;

    return {
      winnerTeamId: winner.id,
      loserTeamId: loser.id,
      reason,
      margin:
        reason === 'chaseComplete'
          ? Math.max(wicketsRemaining, 0)
          : winner.score - loser.score,
      marginType: reason === 'chaseComplete' ? 'wickets' : 'runs',
      winningScore: winner.score,
      losingScore: loser.score,
    };
  }

  private createInnings(
    room: RoomState,
    number: 1 | 2,
    battingTeamId: TeamId,
    bowlingTeamId: TeamId,
  ): InningsState {
    const innings: InningsState = {
      number,
      battingTeamId,
      bowlingTeamId,
      currentBatterId: this.getTeam(room, battingTeamId).playerIds[0] ?? null,
      currentBowlerId: null,
      currentSpellBalls: 0,
      pendingBowlerSelection: true,
      overHistory: [],
    };


    if (room.mode === 'solo') {
      this.autoAssignBowlerFromTeam(room, innings);
    } else {
      this.autoAssignBotBowler(room, innings);
    }

    return innings;
  }

  private createToss(room: RoomState): TossState {
    const winnerTeamId: TeamId = this.secureRandom() > 0.5 ? 'A' : 'B';
    const decisionMakerId = this.getTeam(room, winnerTeamId).captainId;

    if (!decisionMakerId) {
      throw new Error('Toss cannot start without an assigned captain.');
    }

    const toss: TossState = {
      winnerTeamId,
      decisionMakerId,
      choice: null,
    };

    const decisionMaker = this.getPlayer(room, decisionMakerId);
    if (decisionMaker.isBot) {
      toss.choice = this.secureRandom() > 0.5 ? 'bat' : 'bowl';
    }

    return toss;
  }

  private createPlayer(
    name: string,
    teamId: TeamId,
    socketId: string,
  ): PlayerState {
    return {
      id: crypto.randomUUID(),
      socketId,
      name: validatePlayerName(name),
      teamId,
      connected: true,
      isBot: false,
      isCaptain: false,
      runsScored: 0,
      runsConceded: 0,
      wicketsTaken: 0,
      deliveriesPlayed: 0,
      deliveriesBowled: 0,
      currentSelection: null,
    };
  }

  private createBotPlayer(teamId: TeamId): PlayerState {
    return {
      ...this.createPlayer('Captain Bot', teamId, 'bot'),
      socketId: null,
      connected: true,
      isBot: true,
    };
  }

  private createTeam(id: TeamId, playerIds: string[]): TeamState {
    return {
      id,
      name: `Team ${id}`,
      playerIds,
      captainId: null,
      score: 0,
      wickets: 0,
    };
  };

  ensureValidState(room: RoomState): RoomState {
    return this.refreshDerivedState(room);
  }

  private refreshDerivedState(room: RoomState): RoomState {
    TEAM_IDS.forEach((teamId) => {
      const team = this.getTeam(room, teamId);
      team.playerIds = room.players
        .filter((player) => player.teamId === teamId)
        .map((player) => player.id);

      if (!team.captainId || !team.playerIds.includes(team.captainId)) {
        this.assignCaptain(room, teamId);
      } else {
        // Double check captain property sync
        room.players.filter(p => p.teamId === teamId).forEach(p => {
          p.isCaptain = p.id === team.captainId;
        });
      }
    });


    room.status =
      room.status === 'completed'
        ? 'completed'
        : room.status === 'live'
          ? 'live'
          : room.status === 'inningsBreak'
            ? 'inningsBreak'
            : room.status === 'toss'
              ? 'toss'
              : this.canStart(room)
                ? 'ready'
                : 'waiting';

    if (room.status === 'live') {
      const innings = room.innings;
      
      // SAFEGUARD: If no bowler selected at all, always force bowler selection
      if (innings && !innings.currentBowlerId) {
        innings.pendingBowlerSelection = true;
      }

      // SAFEGUARD: At start of over, ensure bowler selection is pending
      if (innings && !innings.currentBowlerId && !innings.pendingBowlerSelection && innings.currentSpellBalls === 0) {
        innings.pendingBowlerSelection = true;
      }

      if (innings?.pendingBowlerSelection) {
        if (room.mode === 'solo') {
          this.autoAssignBowlerFromTeam(room, innings);
        } else {
          // In Duel or Team mode, only auto-assign if the captain is a bot
          this.autoAssignBotBowler(room, innings);
        }
      }
    }

    room.gameState = this.buildGameState(room);

    // Auto-resolve toss for bot captains (non-recursive)
    if (room.status === 'toss' && room.toss?.choice && room.toss.decisionMakerId) {
      return this.autoResolveToss(room);
    }

    room.updatedAt = new Date().toISOString();
    return room;
  }

  private autoResolveToss(room: RoomState): RoomState {
    if (
      room.status === 'toss' &&
      room.toss?.choice &&
      room.toss.decisionMakerId &&
      room.toss.choice !== null
    ) {
      return this.selectToss(room, room.toss.decisionMakerId, room.toss.choice);
    }
    return room;
  }

  private autoAssignBotBowler(room: RoomState, innings: InningsState) {
    const bowlingTeam = this.getTeam(room, innings.bowlingTeamId);
    const captainId = bowlingTeam.captainId;
    const captain = captainId ? this.getPlayer(room, captainId) : null;

    if (!captain?.isBot) {
      return;
    }

    const bowlerId = bowlingTeam.playerIds[0] ?? null;
    if (!bowlerId) {
      return;
    }

    innings.currentBowlerId = bowlerId;
    innings.currentSpellBalls = 0;
    innings.pendingBowlerSelection = false;
    innings.overHistory = [];
  }

  private autoAssignBowlerFromTeam(room: RoomState, innings: InningsState) {
    const bowlingTeam = this.getTeam(room, innings.bowlingTeamId);
    const bowlerId = bowlingTeam.playerIds[0] ?? null;
    if (!bowlerId) {
      return;
    }

    innings.currentBowlerId = bowlerId;
    innings.currentSpellBalls = 0;
    innings.pendingBowlerSelection = false;
    innings.overHistory = [];
  }

  private canStart(room: RoomState) {
    if (room.mode === 'solo') {
      return true;
    }

    if (room.mode === 'duel') {
      return TEAM_IDS.every(
        (teamId) => this.getTeam(room, teamId).playerIds.length === 1,
      );
    }

    return TEAM_IDS.every(
      (teamId) => this.getTeam(room, teamId).playerIds.length === room.teamSize,
    );
  }

  private clampTeamSize(teamSize: number) {
    return Math.max(2, Math.min(5, teamSize));
  }

  private pickJoinTeam(room: RoomState): TeamId {
    const [teamA, teamB] = TEAM_IDS.map((teamId) => this.getTeam(room, teamId));
    return teamA.playerIds.length <= teamB.playerIds.length ? 'A' : 'B';
  }

  private otherTeam(teamId: TeamId): TeamId {
    return teamId === 'A' ? 'B' : 'A';
  }

  private swapSides(room: RoomState) {
    room.players.forEach((player) => {
      player.teamId = player.teamId === 'A' ? 'B' : 'A';
      player.isCaptain = false;
    });

    room.teams.forEach((team) => {
      team.captainId = null;
      team.playerIds = [];
    });
  }

  private resetScores(room: RoomState) {
    room.players.forEach((player) => {
      player.runsScored = 0;
      player.runsConceded = 0;
      player.wicketsTaken = 0;
      player.deliveriesPlayed = 0;
      player.deliveriesBowled = 0;
      player.currentSelection = null;
    });

    room.teams.forEach((team) => {
      team.score = 0;
      team.wickets = 0;
    });
  }

  private assignCaptain(room: RoomState, teamId: TeamId) {
    const team = this.getTeam(room, teamId);
    const candidates = room.players.filter(
      (player) => player.teamId === teamId,
    );
    const connectedCandidates = candidates.filter(
      (player) => player.connected || player.isBot,
    );
    const pool =
      connectedCandidates.length > 0 ? connectedCandidates : candidates;
    const nextCaptain =
      pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;

    candidates.forEach((player) => {
      player.isCaptain = nextCaptain?.id === player.id;
    });

    team.captainId = nextCaptain?.id ?? null;
  }

  private getNextBatterId(room: RoomState, teamId: TeamId) {
    const team = this.getTeam(room, teamId);
    return team.playerIds[team.wickets] ?? null;
  }

  private getTeamPlayerCount(room: RoomState, teamId: TeamId) {
    return room.players.filter((player) => player.teamId === teamId).length;
  }

  private getAwaitingPlayerIds(room: RoomState) {
    if (!room.innings || room.status !== 'live') {
      return [];
    }

    const innings = room.innings;
    
    // If pending bowler selection, return bowling captain
    if (innings.pendingBowlerSelection) {
      const bowlingCaptainId = this.getTeam(room, innings.bowlingTeamId).captainId;
      return bowlingCaptainId ? [bowlingCaptainId] : [];
    }

    // Return batter and bowler who haven't selected yet
    const awaiting: string[] = [];
    
    if (innings.currentBatterId) {
      const batter = room.players.find(p => p.id === innings.currentBatterId);
      if (batter && batter.currentSelection === null) {
        awaiting.push(innings.currentBatterId);
      }
    }
    
    if (innings.currentBowlerId) {
      const bowler = room.players.find(p => p.id === innings.currentBowlerId);
      if (bowler && bowler.currentSelection === null) {
        awaiting.push(innings.currentBowlerId);
      }
    }
    
    return awaiting;
  }

  private getPlayer(room: RoomState, playerId: string) {
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) {
      throw new Error('Player not found.');
    }

    return player;
  }

  private getTeam(room: RoomState, teamId: TeamId) {
    const team = room.teams.find((entry) => entry.id === teamId);
    if (!team) {
      throw new Error('Team not found.');
    }

    return team;
  }

  private requireInnings(room: RoomState) {
    if (!room.innings || room.status !== 'live') {
      throw new Error('The match is not currently live.');
    }

    return room.innings;
  }

  private createRoomId() {
    return crypto.randomUUID().slice(2, 8).toUpperCase();
  }

  private buildGameState(room: RoomState) {
    const innings = room.innings;
    const totalBalls = room.currentTurn;
    const currentBall =
      totalBalls === 0
        ? 1
        : innings?.pendingBowlerSelection && innings.currentSpellBalls >= 6
          ? 6
          : (totalBalls % 6) + 1;
    const currentOver =
      totalBalls === 0 ? 1 : Math.floor((Math.max(totalBalls - 1, 0)) / 6) + 1;

    return {
      inningsNumber: innings?.number ?? 1,
      currentBall,
      currentOver,
      totalBalls,
      strikerId: innings?.currentBatterId ?? null,
      bowlerId: innings?.currentBowlerId ?? null,
      lastAction: room.lastRoundResult
        ? `${room.lastRoundResult.label} on ball ${room.lastRoundResult.deliveryNumber}`
        : room.status,
    };
  }

  private secureRandom(): number {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return array[0] / (0xFFFFFFFF + 1);
  }

  private rollBotNumber() {
    return Math.floor(this.secureRandom() * 6) + 1;
  }
}
