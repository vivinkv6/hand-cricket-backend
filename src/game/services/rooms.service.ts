import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
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
import { RoomCacheService } from './room-cache.service';

const SNAPSHOT_FLUSH_INTERVAL_MS = 2_000;
const MAX_SNAPSHOT_FLUSH_BATCH = 24;

type PersistenceMetrics = {
  activeRooms: number;
  dirtyRoomCount: number;
  flushingRoomCount: number;
  snapshotFlushIntervalMs: number;
  snapshotFlushBatchSize: number;
  snapshotWrites: number;
  replayWrites: number;
  snapshotWriteFailures: number;
  replayWriteFailures: number;
  immediateSnapshotFlushes: number;
  deferredSnapshotFlushes: number;
  lastSnapshotFlushAt: string | null;
  lastReplayWriteAt: string | null;
  lastPersistenceErrorAt: string | null;
};

@Injectable()
export class RoomsService implements OnModuleDestroy {
  private readonly logger = new Logger(RoomsService.name);
  private readonly rooms = new Map<string, RoomState>();
  private readonly dirtyRooms = new Map<string, string>();
  private readonly flushingRooms = new Set<string>();
  private snapshotWrites = 0;
  private replayWrites = 0;
  private snapshotWriteFailures = 0;
  private replayWriteFailures = 0;
  private immediateSnapshotFlushes = 0;
  private deferredSnapshotFlushes = 0;
  private lastSnapshotFlushAt: string | null = null;
  private lastReplayWriteAt: string | null = null;
  private lastPersistenceErrorAt: string | null = null;

  constructor(
    private readonly gameEngine: GameEngine,
    private readonly prisma: PrismaService,
    private readonly roomCache: RoomCacheService,
  ) {}

  getRoomCount() {
    return this.rooms.size;
  }

  getPersistenceMetrics(): PersistenceMetrics {
    return {
      activeRooms: this.rooms.size,
      dirtyRoomCount: this.dirtyRooms.size,
      flushingRoomCount: this.flushingRooms.size,
      snapshotFlushIntervalMs: SNAPSHOT_FLUSH_INTERVAL_MS,
      snapshotFlushBatchSize: MAX_SNAPSHOT_FLUSH_BATCH,
      snapshotWrites: this.snapshotWrites,
      replayWrites: this.replayWrites,
      snapshotWriteFailures: this.snapshotWriteFailures,
      replayWriteFailures: this.replayWriteFailures,
      immediateSnapshotFlushes: this.immediateSnapshotFlushes,
      deferredSnapshotFlushes: this.deferredSnapshotFlushes,
      lastSnapshotFlushAt: this.lastSnapshotFlushAt,
      lastReplayWriteAt: this.lastReplayWriteAt,
      lastPersistenceErrorAt: this.lastPersistenceErrorAt,
    };
  }

  async onModuleDestroy() {
    await this.flushAllDirtyRooms();
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
        await this.save(room, true);
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

      const redisRoom = await this.roomCache.getRoom(normalizedRoomId);
      if (redisRoom && this.isValidRoomState(redisRoom)) {
        const validRedisRoom = this.gameEngine.ensureValidState(redisRoom);
        this.rooms.set(normalizedRoomId, validRedisRoom);
        return validRedisRoom;
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
    await this.roomCache.setRoom(validState);
    return validState;
  }

  async getPublicRoom(roomId: string): Promise<PublicRoomState> {
    const room = await this.getRoom(roomId);
    const publicRoom = this.gameEngine.toPublicState(room);
    return {
      ...publicRoom,
      spectatorCount: await this.roomCache.getSpectatorCount(room.id),
    };
  }

  async addSpectator(roomId: string, socketId: string) {
    await this.roomCache.addSpectator(roomId, socketId);
  }

  async removeSpectator(roomId: string, socketId: string) {
    await this.roomCache.removeSpectator(roomId, socketId);
  }

  async save(
    room: RoomState,
    persistNow = false,
    options?: { appendLastRound?: boolean },
  ) {
    const previousRoom = this.rooms.get(room.id);
    const validRoom = this.gameEngine.ensureValidState(room);
    this.rooms.set(validRoom.id, validRoom);
    await this.roomCache.setRoom(validRoom);

    const lastRound =
      options?.appendLastRound && validRoom.lastRoundResult
        ? validRoom.lastRoundResult
        : null;

    if (lastRound) {
      await this.persistLastRound(validRoom.id, lastRound);
    }

    if (
      persistNow ||
      this.shouldPersistSnapshotImmediately(previousRoom ?? null, validRoom, lastRound)
    ) {
      this.immediateSnapshotFlushes += 1;
      await this.flushRoomSnapshot(validRoom);
    } else {
      this.deferredSnapshotFlushes += 1;
      this.markRoomDirty(validRoom);
    }

    return validRoom;
  }

  async delete(roomId: string) {
    if (!isValidRoomId(roomId)) {
      return;
    }

    const id = normalizeRoomId(roomId);
    this.rooms.delete(id);
    this.dirtyRooms.delete(id);
    this.flushingRooms.delete(id);
    await this.roomCache.deleteRoom(id);
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
      this.dirtyRooms.delete(roomId);
      this.flushingRooms.delete(roomId);
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

  @Interval(SNAPSHOT_FLUSH_INTERVAL_MS)
  async flushDirtyRooms() {
    const roomIds = [...this.dirtyRooms.keys()].slice(0, MAX_SNAPSHOT_FLUSH_BATCH);
    await Promise.all(roomIds.map((roomId) => this.flushDirtyRoomById(roomId)));
  }

  private async flushAllDirtyRooms() {
    const roomIds = [...this.dirtyRooms.keys()];
    await Promise.all(roomIds.map((roomId) => this.flushDirtyRoomById(roomId)));
  }

  private markRoomDirty(room: RoomState) {
    this.dirtyRooms.set(room.id, room.updatedAt);
  }

  private async flushDirtyRoomById(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) {
      this.dirtyRooms.delete(roomId);
      return;
    }

    await this.flushRoomSnapshot(room);
  }

  private async flushRoomSnapshot(room: RoomState) {
    if (this.flushingRooms.has(room.id)) {
      this.markRoomDirty(room);
      return;
    }

    const queuedVersion = this.dirtyRooms.get(room.id) ?? room.updatedAt;
    this.flushingRooms.add(room.id);

    try {
      await this.persistRoomSnapshot(room);

      const latestRoom = this.rooms.get(room.id);
      const latestVersion = latestRoom?.updatedAt;
      if (latestVersion && latestVersion !== queuedVersion) {
        this.dirtyRooms.set(room.id, latestVersion);
      } else {
        this.dirtyRooms.delete(room.id);
      }
    } catch (error) {
      this.snapshotWriteFailures += 1;
      this.lastPersistenceErrorAt = new Date().toISOString();
      this.logger.error(
        `Failed to persist room snapshot ${room.id}: ${String(error)}`,
      );
      this.markRoomDirty(this.rooms.get(room.id) ?? room);
      throw error;
    } finally {
      this.flushingRooms.delete(room.id);
    }
  }

  private async persistRoomSnapshot(room: RoomState) {
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
    });
    this.snapshotWrites += 1;
    this.lastSnapshotFlushAt = new Date().toISOString();
  }

  private async persistLastRound(roomId: string, lastRound: RoundResult) {
    try {
      await this.prisma.ballHistoryEntry.upsert({
        where: {
          roomId_inningsNumber_ballNumber: {
            roomId,
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
          roomId,
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
    } catch (error) {
      this.replayWriteFailures += 1;
      this.lastPersistenceErrorAt = new Date().toISOString();
      this.logger.error(
        `Failed to persist last round for room ${roomId}: ${String(error)}`,
      );
      throw error;
    }
    this.replayWrites += 1;
    this.lastReplayWriteAt = new Date().toISOString();
  }

  private shouldPersistSnapshotImmediately(
    previousRoom: RoomState | null,
    room: RoomState,
    lastRound: RoundResult | null,
  ) {
    if (room.status === 'completed') {
      return true;
    }

    if (!previousRoom) {
      return true;
    }

    if (previousRoom.status !== room.status) {
      return true;
    }

    if (previousRoom.innings?.number !== room.innings?.number) {
      return true;
    }

    if (previousRoom.innings?.pendingBowlerSelection !== room.innings?.pendingBowlerSelection) {
      return true;
    }

    if (room.lastActionAt !== previousRoom.lastActionAt && !lastRound) {
      return true;
    }

    if (lastRound?.ballInOver === 6) {
      return true;
    }

    return false;
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
