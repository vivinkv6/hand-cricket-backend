import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ROOM_EXPIRY_MS } from '../constants/room-lifecycle.constants';
import { GameEngine } from '../engine/game.engine';
import type { PublicRoomState, RoomState } from '../types/game.types';
import { isValidRoomId, normalizeRoomId } from '../utils/room-id.util';

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);
  private readonly rooms = new Map<string, RoomState>();

  constructor(
    private readonly gameEngine: GameEngine,
    private readonly prisma: PrismaService,
  ) {}

  getRoomCount() {
    return this.rooms.size;
  }

  async createRoom(
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
        
        // PERSISTENCE: Save to DB
        await this.prisma.room.create({
          data: {
            id: room.id,
            mode: room.mode,
            status: room.status,
            state: room as any,
          }
        }).catch(e => this.logger.error(`Failed to persist room: ${e.message}`));

        return room;
      }
    }

    throw new Error('Unable to allocate a unique room ID right now.');
  }

  async getRoom(roomId: string): Promise<RoomState> {
    if (!isValidRoomId(roomId)) {
      throw new Error('Invalid room ID.');
    }

    const normalizedRoomId = normalizeRoomId(roomId);
    
    // 1. Check memory
    let room = this.rooms.get(normalizedRoomId);
    
    // 2. Fallback to DB (Recovery)
    if (!room) {
      const dbRoom = await this.prisma.room.findUnique({
        where: { id: normalizedRoomId }
      });
      
      if (dbRoom) {
        room = dbRoom.state as unknown as RoomState;
        this.rooms.set(normalizedRoomId, room);
        this.logger.log(`Recovered room session ${normalizedRoomId} from database.`);
      }
    }

    if (!room) {
      throw new Error('Room not found.');
    }

    return room;
  }

  async getPublicRoom(roomId: string): Promise<PublicRoomState> {
    return this.gameEngine.toPublicState(await this.getRoom(roomId));
  }

  async save(room: RoomState) {
    this.rooms.set(room.id, room);
    
    // PERSISTENCE: Background save to DB
    void this.prisma.room.update({
      where: { id: room.id },
      data: {
        status: room.status,
        state: room as any,
      }
    }).catch(e => this.logger.error(`Failed to update room: ${e.message}`));

    return room;
  }

  async delete(roomId: string) {
    if (isValidRoomId(roomId)) {
      const id = normalizeRoomId(roomId);
      this.rooms.delete(id);
      await this.prisma.room.delete({ where: { id } }).catch(() => {});
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
        // We leave the DB record for historical analysis but remove from hot memory
      }
    }
  }
}
