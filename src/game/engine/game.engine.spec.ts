import { Test, TestingModule } from '@nestjs/testing';
import { GameEngine } from './game.engine';
import { TeamId } from '../types/game.types';

describe('GameEngine', () => {
  let engine: GameEngine;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GameEngine],
    }).compile();

    engine = module.get<GameEngine>(GameEngine);
  });

  const setupLiveRoom = (mode: 'solo' | 'duel' | 'team' = 'duel') => {
    const room = engine.createRoom(mode, 'P1', 's1', 1);
    const p1Id = room.players[0].id;
    let p2Id = 'bot';

    if (mode === 'duel' || mode === 'team') {
      const p2 = engine.createPlayer('P2', 'B', 's2');
      room.players.push(p2);
      room.teams.find(t => t.id === 'B')!.playerIds.push(p2.id);
      p2Id = p2.id;
    }
    
    room.status = 'toss';
    room.toss = {
      winnerTeamId: 'A',
      decisionMakerId: p1Id,
      choice: null
    };
    engine.selectToss(room, p1Id, 'bat');
    
    return { room, p1Id, p2Id };
  };

  it('should create a room correctly', () => {
    const room = engine.createRoom('duel', 'Vivin', 'socket-1', 1);
    expect(room.mode).toBe('duel');
    expect(room.players.length).toBe(1);
    expect(room.players[0].name).toBe('Vivin');
  });

  it('should resolve a delivery (Normal run)', () => {
    const { room, p1Id, p2Id } = setupLiveRoom();
    
    engine.selectNumber(room, p2Id, 1);
    const res = engine.selectNumber(room, p1Id, 4);
    
    expect(res.room.teams.find(t => t.id === 'A')?.score).toBe(4);
    expect(res.room.lastRoundResult?.runs).toBe(4);
    expect(res.room.lastRoundResult?.isOut).toBe(false);
  });

  it('should resolve a wicket', () => {
    const { room, p1Id, p2Id } = setupLiveRoom();
    
    engine.selectNumber(room, p1Id, 6);
    const res = engine.selectNumber(room, p2Id, 6);
    
    expect(res.room.lastRoundResult?.isOut).toBe(true);
    expect(res.room.lastRoundResult?.runs).toBe(0);
  });

  it('should switch innings after all out', () => {
    const { room, p1Id, p2Id } = setupLiveRoom();
    
    engine.selectNumber(room, p1Id, 3);
    const res = engine.selectNumber(room, p2Id, 3);
    
    expect(res.room.innings?.number).toBe(2);
    expect(res.room.innings?.battingTeamId).toBe('B');
    expect(res.room.currentTurn).toBe(0);
  });

  it('should handle a tie match', () => {
    const { room, p1Id, p2Id } = setupLiveRoom();
    
    // Innings 1: A scores 5
    room.teams.find(t => t.id === 'A')!.score = 5;
    room.innings!.number = 2;
    room.innings!.battingTeamId = 'B';
    room.innings!.bowlingTeamId = 'A';
    room.targetScore = 6;

    // Innings 2: B scores 5 and gets out (Tie)
    room.teams.find(t => t.id === 'B')!.score = 5;
    engine.selectNumber(room, p2Id, 4); // Out!
    const res = engine.selectNumber(room, p1Id, 4);
    
    expect(res.room.status).toBe('completed');
    expect(res.room.result?.winnerTeamId).toBeNull();
    expect(res.room.result?.reason).toBe('tie');
  });

  it('should end game after successful chase', () => {
    const { room, p1Id, p2Id } = setupLiveRoom();
    
    engine.selectNumber(room, p1Id, 5);
    engine.selectNumber(room, p2Id, 1);
    engine.selectNumber(room, p1Id, 2);
    engine.selectNumber(room, p2Id, 2); 
    
    expect(room.innings?.number).toBe(2);
    expect(room.targetScore).toBe(6);

    engine.selectNumber(room, p2Id, 6); 
    const res = engine.selectNumber(room, p1Id, 2); 
    
    expect(res.room.status).toBe('completed');
    expect(res.room.result?.winnerTeamId).toBe('B');
  });

  it('should handle solo mode (Bot interaction)', () => {
    const room = engine.createRoom('solo', 'SoloPlayer', 's1', 1);
    const p1Id = room.players[0].id;
    room.status = 'toss';
    room.toss = {
      winnerTeamId: 'A',
      decisionMakerId: p1Id,
      choice: null
    };
    engine.selectToss(room, p1Id, 'bat');
    
    const res = engine.selectNumber(room, p1Id, 4);
    
    expect(res.room.lastRoundResult).toBeDefined();
    expect(res.room.lastRoundResult?.runs).toBeLessThanOrEqual(6);
  });
});
