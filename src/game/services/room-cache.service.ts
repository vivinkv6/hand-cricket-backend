import { Injectable } from '@nestjs/common';
import type { RoomState } from '../types/game.types';
import { RedisService } from '../../redis/redis.service';

const ACTIVE_ROOM_TTL_SECONDS = 60 * 90;
const COMPLETED_ROOM_TTL_SECONDS = 60 * 20;
const WAITING_ROOM_TTL_SECONDS = 60 * 60 * 2;
const ACTION_REPLAY_TTL_SECONDS = 60 * 60 * 6;

@Injectable()
export class RoomCacheService {
  constructor(private readonly redis: RedisService) {}

  async getRoom(roomId: string): Promise<RoomState | null> {
    const serialized = await this.redis.get(this.roomStateKey(roomId));
    if (!serialized) {
      return null;
    }

    return JSON.parse(serialized) as RoomState;
  }

  async setRoom(room: RoomState): Promise<void> {
    await this.redis.set(this.roomStateKey(room.id), JSON.stringify(room), {
      ttlSeconds: this.resolveRoomTtl(room),
    });
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.redis.del(this.roomStateKey(roomId));
  }

  async rememberAction(
    roomId: string,
    playerId: string,
    actionId: string,
  ): Promise<boolean> {
    return this.redis.set(
      this.replayKey(roomId, playerId, actionId),
      '1',
      {
        ttlSeconds: ACTION_REPLAY_TTL_SECONDS,
        onlyIfNotExists: true,
      },
    );
  }

  async acquireCooldown(
    roomId: string,
    playerId: string,
    eventName: string,
    cooldownMs: number,
  ): Promise<boolean> {
    return this.redis.set(
      this.cooldownKey(roomId, playerId, eventName),
      '1',
      {
        ttlMilliseconds: cooldownMs,
        onlyIfNotExists: true,
      },
    );
  }

  async addSpectator(roomId: string, socketId: string): Promise<void> {
    await this.redis.addToSet(this.spectatorSetKey(roomId), socketId);
  }

  async removeSpectator(roomId: string, socketId: string): Promise<void> {
    await this.redis.removeFromSet(this.spectatorSetKey(roomId), socketId);
  }

  async getSpectatorCount(roomId: string): Promise<number> {
    return this.redis.countSetMembers(this.spectatorSetKey(roomId));
  }

  private roomStateKey(roomId: string) {
    return `room:${roomId}:state`;
  }

  private replayKey(roomId: string, playerId: string, actionId: string) {
    return `room:${roomId}:player:${playerId}:action:${actionId}`;
  }

  private cooldownKey(roomId: string, playerId: string, eventName: string) {
    return `room:${roomId}:player:${playerId}:cooldown:${eventName}`;
  }

  private spectatorSetKey(roomId: string) {
    return `room:${roomId}:spectators`;
  }

  private resolveRoomTtl(room: RoomState) {
    if (room.status === 'completed') {
      return COMPLETED_ROOM_TTL_SECONDS;
    }

    if (room.status === 'live' || room.status === 'inningsBreak') {
      return ACTIVE_ROOM_TTL_SECONDS;
    }

    return WAITING_ROOM_TTL_SECONDS;
  }
}
