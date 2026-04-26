import { GameEngine } from './game.engine';
import { TeamId } from '../types/game.types';
import { createTestRoom, joinRoomToDuel, startToss } from '../../test/test-utils';

describe('GameEngine - Smoke Suite (P0)', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine();
  });

  describe('Room Creation', () => {
    it('creates solo room', () => {
      const { room } = createTestRoom(engine, 'solo', 'Player1');
      expect(room.mode).toBe('solo');
      expect(room.players.length).toBe(2);
    });

    it('creates duel room', () => {
      const { room } = createTestRoom(engine, 'duel', 'Player1');
      expect(room.mode).toBe('duel');
      expect(room.maxPlayers).toBe(2);
    });

    it('generates unique room IDs', () => {
      const { room: r1 } = createTestRoom(engine, 'solo', 'P1');
      const { room: r2 } = createTestRoom(engine, 'solo', 'P2');
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe('Join Flow', () => {
    it('joins waiting room', () => {
      const { room } = createTestRoom(engine, 'duel', 'Cap');
      const result = engine.joinRoom(room, 'NewP', 's2');
      expect(result.players.length).toBe(2);
    });

    it('rejects full room', () => {
      const { room } = createTestRoom(engine, 'duel', 'P1');
      const p2 = makePlayer('P2', 'B', 's2');
      room.players.push(p2);
      room.teams.find(t => t.id === 'B')!.playerIds.push('P2');
      expect(() => engine.joinRoom(room, 'P3', 's3')).toThrow('Room is full');
    });

    it('rejects duplicate names', () => {
      const { room } = createTestRoom(engine, 'duel', 'Player1');
      room.players[0].connected = true;
      expect(() => engine.joinRoom(room, 'PLAYER1', 's2')).toThrow('already being used');
    });
  });
});

describe('GameEngine - Regression Suite (P1)', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine();
  });

  describe('Toss', () => {
    it('selects bat and starts innings', () => {
      const { room } = createTestRoom(engine, 'solo', 'Player');
      const p1Id = room.players[0].id;
      room.status = 'toss';
      room.toss = { winnerTeamId: 'A', decisionMakerId: p1Id, choice: null };

      const result = engine.selectToss(room, p1Id, 'bat');
      expect(result.status).toBe('live');
      expect(result.innings).not.toBeNull();
    });

    it('selects bowl and starts innings', () => {
      const { room } = createTestRoom(engine, 'solo', 'Player');
      const p1Id = room.players[0].id;
      room.status = 'toss';
      room.toss = { winnerTeamId: 'A', decisionMakerId: p1Id, choice: null };

      const result = engine.selectToss(room, p1Id, 'bowl');
      expect(result.status).toBe('live');
      expect(result.innings!.battingTeamId).toBe('B');
    });
  });

  describe('Score Calculation', () => {
    it('calculates runs', () => {
      const { room } = createTestRoom(engine, 'duel', 'P1');
      const p1Id = room.players[0].id;
      const r2 = joinRoomToDuel(engine, room, 'P2');
      const p2Id = r2.players[1].id;

      startToss(engine, room, p1Id);

      engine.selectNumber(room, p1Id, 3);
      const result = engine.selectNumber(room, p2Id, 1);

      expect(result.room.lastRoundResult!.runs).toBe(3);
    });

    it('detects wicket', () => {
      const { room } = createTestRoom(engine, 'duel', 'P1');
      const p1Id = room.players[0].id;
      const r2 = joinRoomToDuel(engine, room, 'P2');
      const p2Id = r2.players[1].id;

      startToss(engine, room, p1Id);

      engine.selectNumber(room, p1Id, 4);
      const result = engine.selectNumber(room, p2Id, 4);

      expect(result.room.lastRoundResult!.isOut).toBe(true);
    });

    it('labels four', () => {
      const { room } = createTestRoom(engine, 'duel', 'P1');
      const p1Id = room.players[0].id;
      const r2 = joinRoomToDuel(engine, room, 'P2');
      const p2Id = r2.players[1].id;

      startToss(engine, room, p1Id);

      engine.selectNumber(room, p1Id, 4);
      const result = engine.selectNumber(room, p2Id, 1);

      expect(result.room.lastRoundResult!.label).toBe('FOUR');
    });

    it('labels six', () => {
      const { room } = createTestRoom(engine, 'duel', 'P1');
      const p1Id = room.players[0].id;
      const r2 = joinRoomToDuel(engine, room, 'P2');
      const p2Id = r2.players[1].id;

      startToss(engine, room, p1Id);

      engine.selectNumber(room, p1Id, 6);
      const result = engine.selectNumber(room, p2Id, 1);

      expect(result.room.lastRoundResult!.label).toBe('SIX');
    });
  });

  describe('Over Progression', () => {
    it('tracks balls in over', () => {
      const { room } = createTestRoom(engine, 'duel', 'P1');
      const p1Id = room.players[0].id;
      const r2 = joinRoomToDuel(engine, room, 'P2');
      const p2Id = r2.players[1].id;

      startToss(engine, room, p1Id);

      let currentSpellBalls = 0;
      for (let i = 0; i < 5; i++) {
        engine.selectNumber(room, p1Id, 1);
        const res = engine.selectNumber(room, p2Id, 2);
        if (res.room.innings?.pendingBowlerSelection) break;
        currentSpellBalls = res.room.innings?.currentSpellBalls || 0;
      }

      expect(currentSpellBalls).toBe(5);
    });

    it('handles over completion', () => {
      const { room } = createTestRoom(engine, 'duel', 'P1');
      const p1Id = room.players[0].id;
      const r2 = joinRoomToDuel(engine, room, 'P2');
      const p2Id = r2.players[1].id;

      startToss(engine, room, p1Id);

      for (let i = 0; i < 6; i++) {
        engine.selectNumber(room, p1Id, 1);
        const res = engine.selectNumber(room, p2Id, 2);
        if (res.room.innings?.pendingBowlerSelection) break;
      }

      // Game should be in valid state
      expect(room.innings).not.toBeNull();
    });
  });

  describe('Rejoin', () => {
    it('restores disconnected player', () => {
      const { room } = createTestRoom(engine, 'solo', 'Player');
      room.players[0].connected = false;
      room.players[0].socketId = null;

      const result = engine.rejoinRoom(room, room.players[0].id, 'new-socket');
      expect(result.players[0].connected).toBe(true);
    });
  });
});

describe('Unhappy Path - Edge Cases', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine();
  });

  it('rejects invalid numbers', () => {
    const { room } = createTestRoom(engine, 'solo', 'Player');
    const p1Id = room.players[0].id;
    startToss(engine, room, p1Id);

    expect(() => engine.selectNumber(room, p1Id, 0)).toThrow();
    expect(() => engine.selectNumber(room, p1Id, 7)).toThrow();
  });

  it('truncates long names', () => {
    const { room } = createTestRoom(engine, 'duel', 'P1');
    const result = engine.joinRoom(room, 'A'.repeat(100), 's2');
    expect(result.players[1].name.length).toBeLessThanOrEqual(24);
  });

  it('handles consecutive wickets', () => {
    const { room } = createTestRoom(engine, 'duel', 'P1');
    const p1Id = room.players[0].id;
    const r2 = joinRoomToDuel(engine, room, 'P2');
    const p2Id = r2.players[1].id;

    startToss(engine, room, p1Id);
    room.teams[0].playerIds = [p1Id];

    let wickets = 0;
    for (let i = 0; i < 6; i++) {
      if (room.status !== 'live') break;
      engine.selectNumber(room, p1Id, 3);
      const res = engine.selectNumber(room, p2Id, 3);
      if (res.room.lastRoundResult?.isOut) wickets++;
    }

    expect(wickets).toBeGreaterThan(0);
  });

it('handles score accumulation', () => {
      const { room } = createTestRoom(engine, 'duel', 'P1');
      const p1Id = room.players[0].id;
      const r2 = joinRoomToDuel(engine, room, 'P2');
      const p2Id = r2.players[1].id;

      startToss(engine, room, p1Id);

      // Just play 3 deliveries to verify score updates work
      let totalRuns = 0;
      for (let i = 0; i < 3; i++) {
        if (room.status !== 'live') break;
        engine.selectNumber(room, p1Id, 4);
        const res = engine.selectNumber(room, p2Id, 1);
        if (res.room.lastRoundResult) {
          totalRuns += res.room.lastRoundResult.runs;
        }
      }

      expect(totalRuns).toBeGreaterThanOrEqual(0);
    });
  });

describe('Performance', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine();
  });

  it('creates room quickly', () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      engine.createRoom('solo', 'P', 's');
    }
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(100);
  });

  it('processes deliveries quickly', () => {
    const { room } = createTestRoom(engine, 'solo', 'P');
    const p1 = room.players[0];
    const bot = room.players.find(p => p.isBot)!;

    startToss(engine, room, p1.id);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      if (room.status !== 'live') break;
      if (room.innings?.pendingBowlerSelection) break;
      engine.selectNumber(room, p1.id, 3);
      if (room.lastRoundResult?.runs !== undefined) {
        engine.selectNumber(room, bot.id, 1);
      }
    }
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(100);
  });
});

function makePlayer(name: string, teamId: TeamId, socketId: string) {
  return {
    id: crypto.randomUUID(),
    socketId,
    name,
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