import { GameEngine } from '../../src/game/engine/game.engine';

export function createTestRoom(
  engine: GameEngine,
  mode: 'solo' | 'duel' | 'team' = 'solo',
  playerName = 'TestPlayer',
) {
  const room = engine.createRoom(mode, playerName, `socket-${Date.now()}`);
  return { room };
}

export function joinRoomToDuel(
  engine: GameEngine,
  room: ReturnType<GameEngine['createRoom']>,
  playerName: string,
) {
  return engine.joinRoom(room, playerName, `socket-${Date.now()}`);
}

export function startToss(
  engine: GameEngine,
  room: ReturnType<GameEngine['createRoom']>,
  playerId: string,
) {
  room.status = 'toss';
  room.toss = {
    winnerTeamId: 'A',
    decisionMakerId: playerId,
    choice: null,
  };
  return engine.selectToss(room, playerId, 'bat');
}