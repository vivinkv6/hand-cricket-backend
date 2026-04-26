import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ROOM_EXPIRY_MS } from '../constants/room-lifecycle.constants';
import { GameEngine } from '../engine/game.engine';
import type {
  PublicRoomState,
  RoomState,
  RoundResult,
  TeamId,
} from '../types/game.types';
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
        await this.persistRoom(room);
        return room;
      }
    }

    throw new Error('Unable to allocate a unique room ID right now.');
  }

  async getRoom(roomId: string, forceFresh = false): Promise<RoomState> {
    if (!isValidRoomId(roomId)) {
      throw new Error('Invalid room ID.');
    }

    const normalizedRoomId = normalizeRoomId(roomId);

    if (!forceFresh) {
      const cachedRoom = this.rooms.get(normalizedRoomId);
      if (cachedRoom) {
        return this.gameEngine.ensureValidState(cachedRoom);
      }
    }

    const dbRoom = await this.prisma.gameRoom.findUnique({
      where: { id: normalizedRoomId },
    });

    if (!dbRoom) {
      throw new Error('Room not found.');
    }

    const recoveredState = dbRoom.snapshot as unknown as RoomState;
    if (!this.isValidRoomState(recoveredState)) {
      throw new Error('Persisted room state is invalid.');
    }

    const validState = this.gameEngine.ensureValidState(recoveredState);
    this.rooms.set(normalizedRoomId, validState);
    return validState;
  }

  async getPublicRoom(roomId: string): Promise<PublicRoomState> {
    return this.gameEngine.toPublicState(await this.getRoom(roomId));
  }

  async save(
    room: RoomState,
    persistNow = false,
    options?: { appendLastRound?: boolean },
  ) {
    const validRoom = this.gameEngine.ensureValidState(room);
    this.rooms.set(validRoom.id, validRoom);

    const savePromise = this.persistRoom(
      validRoom,
      options?.appendLastRound ? validRoom.lastRoundResult : null,
    );

    if (persistNow) {
      await savePromise;
    } else {
      void savePromise.catch((error: unknown) =>
        this.logger.error(`Failed to update room ${validRoom.id}: ${String(error)}`),
      );
    }

    return validRoom;
  }

  async delete(roomId: string) {
    if (!isValidRoomId(roomId)) {
      return;
    }

    const id = normalizeRoomId(roomId);
    this.rooms.delete(id);
    await this.prisma.gameRoom.delete({ where: { id } }).catch(() => undefined);
  }

  async purgeRoomsOlderThan(cutoff: Date) {
    const staleRooms = await this.prisma.gameRoom.findMany({
      where: {
        updatedAt: {
          lt: cutoff,
        },
      },
      select: {
        id: true,
      },
    });

    const roomIds = staleRooms.map((room) => room.id);
    if (roomIds.length === 0) {
      return {
        deletedCount: 0,
        roomIds: [] as string[],
      };
    }

    roomIds.forEach((roomId) => {
      this.rooms.delete(roomId);
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const affectedUsers = await tx.gamePlayer.findMany({
        where: {
          roomId: {
            in: roomIds,
          },
        },
        select: {
          userId: true,
        },
      });

      const deletedRooms = await tx.gameRoom.deleteMany({
        where: {
          id: {
            in: roomIds,
          },
        },
      });

      const userIds = [...new Set(affectedUsers.map((entry) => entry.userId))];
      if (userIds.length > 0) {
        await tx.gameUser.deleteMany({
          where: {
            id: {
              in: userIds,
            },
            players: {
              none: {},
            },
          },
        });
      }

      return deletedRooms;
    });

    return {
      deletedCount: result.count,
      roomIds,
    };
  }

  private async persistRoom(room: RoomState, lastRound?: RoundResult | null) {
    await this.prisma.$transaction(async (tx) => {
      await tx.gameRoom.upsert({
        where: { id: room.id },
        update: {
          roomCode: room.id,
          status: this.mapRoomStatus(room.status),
          mode: room.mode,
          teamSize: room.teamSize,
          maxPlayers: room.maxPlayers,
          snapshot: room as unknown as object,
        },
        create: {
          id: room.id,
          roomCode: room.id,
          status: this.mapRoomStatus(room.status),
          mode: room.mode,
          teamSize: room.teamSize,
          maxPlayers: room.maxPlayers,
          snapshot: room as unknown as object,
        },
      });

      for (const player of room.players) {
        await tx.gameUser.upsert({
          where: { id: player.id },
          update: {
            username: player.name,
            socketId: player.socketId,
          },
          create: {
            id: player.id,
            username: player.name,
            socketId: player.socketId,
          },
        });

        await tx.gamePlayer.upsert({
          where: { roomId_userId: { roomId: room.id, userId: player.id } },
          update: {
            id: player.id,
            role: this.getPersistedRole(room, player.id),
            score: player.runsScored,
            isOut: this.isPlayerOut(room, player.id),
            isBot: player.isBot,
            teamId: player.teamId,
            connected: player.connected,
            state: player as unknown as object,
          },
          create: {
            id: player.id,
            userId: player.id,
            roomId: room.id,
            role: this.getPersistedRole(room, player.id),
            score: player.runsScored,
            isOut: this.isPlayerOut(room, player.id),
            isBot: player.isBot,
            teamId: player.teamId,
            connected: player.connected,
            state: player as unknown as object,
          },
        });
      }

      await tx.gameStateRecord.upsert({
        where: { roomId: room.id },
        update: {
          currentBall: room.gameState.currentBall,
          currentOver: room.gameState.currentOver,
          totalBalls: room.gameState.totalBalls,
          inningsNumber: room.gameState.inningsNumber,
          strikerId: room.gameState.strikerId,
          bowlerId: room.gameState.bowlerId,
          lastAction: room.gameState.lastAction,
        },
        create: {
          roomId: room.id,
          currentBall: room.gameState.currentBall,
          currentOver: room.gameState.currentOver,
          totalBalls: room.gameState.totalBalls,
          inningsNumber: room.gameState.inningsNumber,
          strikerId: room.gameState.strikerId,
          bowlerId: room.gameState.bowlerId,
          lastAction: room.gameState.lastAction,
        },
      });

      if (lastRound) {
        await tx.ballHistoryEntry.upsert({
          where: {
            roomId_inningsNumber_ballNumber: {
              roomId: room.id,
              inningsNumber: lastRound.inningsNumber,
              ballNumber: lastRound.deliveryNumber,
            },
          },
          update: {
            overNumber: lastRound.overNumber,
            ballInOver: lastRound.ballInOver,
            batterId: lastRound.batterId,
            bowlerId: lastRound.bowlerId,
            batterChoice: lastRound.batterNumber,
            bowlerChoice: lastRound.bowlerNumber,
            result: lastRound.isOut ? 'wicket' : 'run',
            runsScored: lastRound.runs,
          },
          create: {
            roomId: room.id,
            inningsNumber: lastRound.inningsNumber,
            ballNumber: lastRound.deliveryNumber,
            overNumber: lastRound.overNumber,
            ballInOver: lastRound.ballInOver,
            batterId: lastRound.batterId,
            bowlerId: lastRound.bowlerId,
            batterChoice: lastRound.batterNumber,
            bowlerChoice: lastRound.bowlerNumber,
            result: lastRound.isOut ? 'wicket' : 'run',
            runsScored: lastRound.runs,
          },
        });
      }
    });
  }

  private mapRoomStatus(status: RoomState['status']) {
    if (status === 'completed') {
      return 'finished';
    }

    if (['live', 'inningsBreak', 'toss'].includes(status)) {
      return 'playing';
    }

    return 'waiting';
  }

  private getPersistedRole(room: RoomState, playerId: string): 'batter' | 'bowler' | null {
    if (!room.innings) {
      return null;
    }

    if (room.innings.currentBatterId === playerId) {
      return 'batter';
    }

    if (room.innings.currentBowlerId === playerId) {
      return 'bowler';
    }

    return null;
  }

  private isPlayerOut(room: RoomState, playerId: string) {
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) {
      return false;
    }

    const team = room.teams.find((entry) => entry.id === player.teamId);
    if (!team) {
      return false;
    }

    const battingOrderIndex = team.playerIds.findIndex((id) => id === playerId);
    return battingOrderIndex > -1 && battingOrderIndex < team.wickets;
  }

  private isValidRoomState(state: unknown): state is RoomState {
    if (!state || typeof state !== 'object') {
      return false;
    }

    const candidate = state as Record<string, unknown>;
    return (
      typeof candidate['id'] === 'string' &&
      typeof candidate['mode'] === 'string' &&
      typeof candidate['status'] === 'string' &&
      Array.isArray(candidate['players']) &&
      Array.isArray(candidate['teams']) &&
      typeof candidate['gameState'] === 'object'
    );
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
