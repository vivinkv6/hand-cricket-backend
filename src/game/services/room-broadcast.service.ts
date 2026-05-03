import { Injectable, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import type { PublicRoomState } from '../types/game.types';

export interface RoomBroadcastMessage {
  roomId: string;
  event: string;
  payload: unknown;
}

type RoomBroadcastListener = (message: RoomBroadcastMessage) => void | Promise<void>;

@Injectable()
export class RoomBroadcastService implements OnModuleInit {
  private readonly listeners = new Set<RoomBroadcastListener>();

  constructor(private readonly redis: RedisService) {}

  async onModuleInit() {
    await this.redis.subscribePattern('room:*:events', async (channel, payload) => {
      const roomId = this.getRoomIdFromChannel(channel);
      if (!roomId) {
        return;
      }

      const message = JSON.parse(payload) as Omit<RoomBroadcastMessage, 'roomId'>;
      await Promise.all(
        [...this.listeners].map((listener) =>
          Promise.resolve(listener({ roomId, ...message })),
        ),
      );
    });
  }

  registerListener(listener: RoomBroadcastListener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async publish(roomId: string, event: string, payload: unknown) {
    await this.redis.publish(
      this.channelFor(roomId),
      JSON.stringify({ event, payload }),
    );
  }

  async publishState(room: PublicRoomState) {
    await this.publish(room.id, 'GAME_STATE_UPDATE', room);
  }

  private channelFor(roomId: string) {
    return `room:${roomId}:events`;
  }

  private getRoomIdFromChannel(channel: string) {
    const match = /^room:(.+):events$/.exec(channel);
    return match?.[1] ?? null;
  }
}
