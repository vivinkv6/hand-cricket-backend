import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { GameEngine } from '../engine/game.engine';
import type { RoomState } from '../types/game.types';
import { RoomCacheService } from './room-cache.service';

interface ValidateGameActionOptions {
  room: RoomState;
  roomId: string;
  playerId: string;
  actionId: string;
  client: Socket;
  eventName: string;
  cooldownMs: number;
  requireLiveMatch?: boolean;
}

@Injectable()
export class GameActionGuard {
  constructor(
    private readonly gameEngine: GameEngine,
    private readonly roomCache: RoomCacheService,
  ) {}

  async validateOrThrow(options: ValidateGameActionOptions): Promise<void> {
    const {
      room,
      roomId,
      playerId,
      actionId,
      client,
      eventName,
      cooldownMs,
      requireLiveMatch,
    } = options;

    const player = room.players.find((entry) => entry.id === playerId);
    if (client.data?.role === 'spectator') {
      throw new Error('Spectators cannot perform match actions.');
    }

    if (!player) {
      throw new Error('Player not found in this room.');
    }

    if (!player.connected) {
      throw new Error('Player is not currently connected.');
    }

    if (player.socketId !== client.id) {
      throw new Error('Player authentication failed. Invalid session.');
    }

    if (requireLiveMatch && !['live', 'toss'].includes(room.status)) {
      throw new Error('The match is not accepting this action right now.');
    }

    const isNewAction = await this.roomCache.rememberAction(
      roomId,
      playerId,
      actionId,
    );
    if (!isNewAction) {
      throw new Error('Duplicate action ignored.');
    }

    const hasCooldownSlot = await this.roomCache.acquireCooldown(
      roomId,
      playerId,
      eventName,
      cooldownMs,
    );
    if (!hasCooldownSlot) {
      throw new Error('Action cooldown active. Please wait a moment.');
    }

    if (eventName === 'SELECT_NUMBER') {
      const awaitingPlayerIds = this.gameEngine.toPublicState(room).awaitingPlayerIds;
      if (!awaitingPlayerIds.includes(playerId)) {
        throw new Error("It is not this player's turn.");
      }
    }
  }
}
