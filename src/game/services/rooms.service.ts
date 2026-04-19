import { Injectable } from '@nestjs/common';
import { ROOM_EXPIRY_MS } from '../constants/room-lifecycle.constants';
import { GameEngine } from '../engine/game.engine';
import type { PublicRoomState, RoomState } from '../types/game.types';
import { isValidRoomId, normalizeRoomId } from '../utils/room-id.util';

@Injectable()
export class RoomsService {
  private readonly rooms = new Map<string, RoomState>();

  constructor(private readonly gameEngine: GameEngine) {}

  getRoomCount() {
    this.pruneExpiredRooms();
    return this.rooms.size;
  }

  createRoom(
    mode: RoomState['mode'],
    playerName: string,
    socketId: string,
    teamSize?: number,
  ) {
    this.pruneExpiredRooms();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const room = this.gameEngine.createRoom(
        mode,
        playerName,
        socketId,
        teamSize,
      );

      if (!this.rooms.has(room.id)) {
        this.rooms.set(room.id, room);
        return room;
      }
    }

    throw new Error('Unable to allocate a unique room ID right now.');
  }

  getRoom(roomId: string) {
    this.pruneExpiredRooms();
    if (!isValidRoomId(roomId)) {
      throw new Error('Invalid room ID.');
    }

    const normalizedRoomId = normalizeRoomId(roomId);
    const room = this.rooms.get(normalizedRoomId);
    if (!room) {
      throw new Error('Room not found.');
    }

    return room;
  }

  getPublicRoom(roomId: string): PublicRoomState {
    return this.gameEngine.toPublicState(this.getRoom(roomId));
  }

  save(room: RoomState) {
    this.pruneExpiredRooms();
    this.rooms.set(room.id, room);
    return room;
  }

  delete(roomId: string) {
    if (isValidRoomId(roomId)) {
      this.rooms.delete(normalizeRoomId(roomId));
    }
  }

  private pruneExpiredRooms() {
    const now = Date.now();

    for (const [roomId, room] of this.rooms.entries()) {
      const lastActionAt = Date.parse(room.lastActionAt);
      const idleFor = Number.isNaN(lastActionAt) ? 0 : now - lastActionAt;
      const ttl =
        room.status === 'completed'
          ? ROOM_EXPIRY_MS.COMPLETED
          : room.status === 'live'
            ? ROOM_EXPIRY_MS.ACTIVE
            : ROOM_EXPIRY_MS.WAITING;

      if (idleFor > ttl) {
        this.rooms.delete(roomId);
      }
    }
  }
}
