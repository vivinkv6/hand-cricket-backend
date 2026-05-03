import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { GAME_EVENTS } from '../contracts/game-events';
import type {
  CreateRoomDto,
  JoinRoomDto,
  LeaveRoomDto,
  RejoinRoomDto,
  RematchRequestDto,
  RenameTeamDto,
  RoomPlayerActionDto,
  SelectBowlerDto,
  SelectNumberDto,
  SelectTossDto,
  SwapTeamDto,
} from '../dto/game.dto';
import { GameEngine } from '../engine/game.engine';
import { RoomsService } from '../services/rooms.service';
import { GameActionGuard } from '../services/game-action.guard';
import { isValidRoomId, normalizeRoomId } from '../utils/room-id.util';
import { RoomBroadcastService } from '../services/room-broadcast.service';

type SocketSession = {
  roomId?: string;
  role?: 'player' | 'spectator';
  playerId?: string | null;
};

@WebSocketGateway({
  cors: {
    origin: process.env.CLIENT_ORIGIN?.split(',') ?? true,
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})
export class GameGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  private readonly logger = new Logger(GameGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly roomsService: RoomsService,
    private readonly gameEngine: GameEngine,
    private readonly gameActionGuard: GameActionGuard,
    private readonly roomBroadcastService: RoomBroadcastService,
  ) {}

  afterInit() {
    this.roomBroadcastService.registerListener(async ({ roomId, event, payload }) => {
      this.server.to(roomId).emit(event, payload);
    });
  }

  handleConnection(client: Socket) {
    this.logger.log(`Socket connected: ${client.id}`);
    client.emit('connected', { socketId: client.id });
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Socket disconnected: ${client.id}`);
    const session = client.data as SocketSession;
    if (session.role === 'spectator' && session.roomId) {
      await this.roomsService.removeSpectator(session.roomId, client.id);
      await this.broadcastState(session.roomId);
      return;
    }

    const rooms = Array.from(client.rooms.values()).filter(
      (room) => room !== client.id,
    );

    for (const roomId of rooms) {
      try {
        const room = await this.roomsService.getRoom(roomId);
        const disconnectedPlayer = room.players.find(p => p.socketId === client.id);
        await this.roomsService.save(
          this.gameEngine.disconnectPlayer(room, client.id),
          true,
        );

        await this.publishRoomEvent(roomId, GAME_EVENTS.PLAYER_DISCONNECTED, {
          roomId,
          playerSocketId: client.id,
          playerName: disconnectedPlayer?.name,
        });
        await this.broadcastState(roomId);
      } catch {
        continue;
      }
    }
  }


  @SubscribeMessage(GAME_EVENTS.CREATE_ROOM)
  handleCreateRoom(
    @MessageBody() payload: CreateRoomDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {
      this.logger.log(

        `CREATE_ROOM from ${client.id} mode=${payload.mode} teamSize=${payload.teamSize ?? 1}`,
      );
      const room = await this.roomsService.createRoom(
        payload.mode,
        payload.playerName,
        client.id,
        payload.teamSize,
      );

      try {
        await client.join(room.id);
      } catch (joinError) {
        this.logger.warn(`Failed to join socket to room: ${joinError}`);
      }
      client.data = {
        roomId: room.id,
        role: 'player',
        playerId: room.players.find((player) => player.socketId === client.id)?.id ?? null,
      } satisfies SocketSession;
      this.broadcastState(room.id);

      return {
        ok: true,
        roomId: room.id,
        playerId: room.players.find((player) => player.socketId === client.id)
          ?.id,
        room: this.gameEngine.toPublicState(room),
      };
    });
  }

  @SubscribeMessage(GAME_EVENTS.JOIN_ROOM)
  handleJoinRoom(
    @MessageBody() payload: JoinRoomDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {
      if (!isValidRoomId(payload.roomId)) {
        throw new Error('A valid room ID is required to join a room.');
      }


      const normalizedRoomId = normalizeRoomId(payload.roomId);
      this.logger.log(`JOIN_ROOM from ${client.id} roomId=${normalizedRoomId}`);
      const room = await this.roomsService.getRoom(normalizedRoomId);

      if (payload.role === 'spectator') {
        await client.join(normalizedRoomId);
        await this.roomsService.addSpectator(normalizedRoomId, client.id);
        client.data = {
          roomId: normalizedRoomId,
          role: 'spectator',
          playerId: null,
        } satisfies SocketSession;
        await this.broadcastState(normalizedRoomId);

        return {
          ok: true,
          roomId: normalizedRoomId,
          role: 'spectator',
          room: await this.roomsService.getPublicRoom(normalizedRoomId),
        };
      }

      const joinedRoom = this.gameEngine.joinRoom(
        room,
        payload.playerName,
        client.id,
        payload.playerId,
      );
      
      // PERSIST immediately for join
      await this.roomsService.save(joinedRoom, true);


      try {
        await client.join(normalizedRoomId);
      } catch (joinError) {
        this.logger.warn(`Failed to join socket to room: ${joinError}`);
      }
      client.data = {
        roomId: normalizedRoomId,
        role: 'player',
        playerId:
          joinedRoom.players.find((player) => player.socketId === client.id)?.id ?? null,
      } satisfies SocketSession;
      this.broadcastState(normalizedRoomId);

      return {
        ok: true,
        roomId: normalizedRoomId,
        playerId: joinedRoom.players.find((player) => player.socketId === client.id)
          ?.id,
        room: this.gameEngine.toPublicState(joinedRoom),
      };
    });
  }

  @SubscribeMessage(GAME_EVENTS.LEAVE_ROOM)
  handleLeaveRoom(
    @MessageBody() payload: LeaveRoomDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {
      const roomId = this.requireRoomId(payload.roomId);
      const session = client.data as SocketSession;
      await client.leave(roomId);

      if (session.role === 'spectator') {
        await this.roomsService.removeSpectator(roomId, client.id);
        client.data = {} satisfies SocketSession;
        await this.broadcastState(roomId);
        return { ok: true };
      }

      return { ok: true };
    });
  }

  @SubscribeMessage(GAME_EVENTS.REJOIN_ROOM)
  handleRejoinRoom(
    @MessageBody() payload: RejoinRoomDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {
      if (!isValidRoomId(payload.roomId)) {
        throw new Error('A valid room ID is required to rejoin a room.');
      }

      const normalizedRoomId = normalizeRoomId(payload.roomId);
      this.logger.log(
        `REJOIN_ROOM from ${client.id} roomId=${normalizedRoomId} playerId=${payload.playerId} playerName=${payload.playerName}`,
      );
      const room = await this.roomsService.getRoom(normalizedRoomId);
      
      const updatedRoom = this.gameEngine.rejoinRoomByIdentity(
        room,
        {
          playerId: payload.playerId,
          playerName: payload.playerName,
        },
        client.id,
      );

      
      // PERSIST immediately for rejoin
      await this.roomsService.save(updatedRoom, true);

      const player = updatedRoom.players.find(p => p.socketId === client.id);
      const resolvedPlayerId = player?.id ?? payload.playerId ?? null;
      client.data = {
        roomId: normalizedRoomId,
        role: 'player',
        playerId: resolvedPlayerId,
      } satisfies SocketSession;

      await client.join(normalizedRoomId);
      await this.publishRoomEvent(normalizedRoomId, GAME_EVENTS.PLAYER_RECONNECTED, {
        roomId: normalizedRoomId,
        playerId: resolvedPlayerId,
      });
      
      this.broadcastState(normalizedRoomId);
      
      return { 
        ok: true, 
        roomId: normalizedRoomId, 
        playerId: resolvedPlayerId,
        room: this.gameEngine.toPublicState(updatedRoom),
      };
    });
  }

  @SubscribeMessage(GAME_EVENTS.START_GAME)
  handleStartGame(
    @MessageBody() payload: RoomPlayerActionDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.validateGameAction(client, GAME_EVENTS.START_GAME, payload, room, {
        cooldownMs: 750,
      });
      await this.roomsService.save(
        this.gameEngine.startGame(room, payload.playerId),
        true,
      );

      this.broadcastState(roomId);
      return { ok: true };
    });
  }

  @SubscribeMessage(GAME_EVENTS.SELECT_BOWLER)
  handleSelectBowler(
    @MessageBody() payload: SelectBowlerDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {

      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.validateGameAction(client, GAME_EVENTS.SELECT_BOWLER, payload, room, {
        cooldownMs: 750,
        requireLiveMatch: true,
      });
      await this.roomsService.save(
        this.gameEngine.selectBowler(room, payload.playerId, payload.bowlerId),
        true, // persist immediately
      );

      this.broadcastState(roomId);
      return { ok: true };
    });
  }

  @SubscribeMessage(GAME_EVENTS.SELECT_TOSS)
  handleSelectToss(
    @MessageBody() payload: SelectTossDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {

      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.validateGameAction(client, GAME_EVENTS.SELECT_TOSS, payload, room, {
        cooldownMs: 750,
        requireLiveMatch: true,
      });
      const updatedRoom = this.gameEngine.selectToss(room, payload.playerId, payload.choice);
      await this.roomsService.save(updatedRoom, true);

      this.broadcastState(roomId);
      return { ok: true };
    });
  }

  @SubscribeMessage(GAME_EVENTS.SELECT_NUMBER)
  handleSelectNumber(
    @MessageBody() payload: SelectNumberDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.validateGameAction(client, GAME_EVENTS.SELECT_NUMBER, payload, room, {
        cooldownMs: 500,
        requireLiveMatch: true,
      });
      const resolution = this.gameEngine.selectNumber(
        room,
        payload.playerId,
        payload.number,
      );
      await this.roomsService.save(resolution.room, true, {
        appendLastRound: Boolean(resolution.room.lastRoundResult),
      });


      if (resolution.room.lastRoundResult) {
        await this.publishRoomEvent(
          roomId,
          GAME_EVENTS.ROUND_RESULT,
          resolution.room.lastRoundResult,
        );
      }

      for (const event of resolution.events) {
        if (event.type === 'switchInnings') {
          await this.publishRoomEvent(roomId, GAME_EVENTS.SWITCH_INNINGS, event.payload);
        }

        if (event.type === 'gameOver') {
          await this.publishRoomEvent(roomId, GAME_EVENTS.GAME_OVER, event.payload);
        }
      }


      this.broadcastState(roomId);
      return { ok: true };
    });
  }


  @SubscribeMessage(GAME_EVENTS.TEAM_SWAP)
  handleTeamSwap(
    @MessageBody() payload: SwapTeamDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {

      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.validateGameAction(client, GAME_EVENTS.TEAM_SWAP, payload, room, {
        cooldownMs: 750,
      });
      await this.roomsService.save(
        this.gameEngine.movePlayer(
          room,
          payload.playerId,
          payload.targetTeamId,
        ),
      );

      this.broadcastState(roomId);
      return { ok: true };
    });
  }

  @SubscribeMessage(GAME_EVENTS.RENAME_TEAM)
  handleRenameTeam(
    @MessageBody() payload: RenameTeamDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {

      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.validateGameAction(client, GAME_EVENTS.RENAME_TEAM, payload, room, {
        cooldownMs: 750,
      });
      await this.roomsService.save(
        this.gameEngine.renameTeam(
          room,
          payload.playerId,
          payload.teamId,
          payload.name,
        ),
      );

      this.broadcastState(roomId);
      return { ok: true };
    });
  }

  @SubscribeMessage(GAME_EVENTS.REMATCH_REQUEST)
  handleRematchRequest(
    @MessageBody() payload: RematchRequestDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, async () => {

      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.validateGameAction(client, GAME_EVENTS.REMATCH_REQUEST, payload, room, {
        cooldownMs: 1000,
      });
      await this.roomsService.save(
        this.gameEngine.requestRematch(
          room,
          payload.playerId,
          payload.preference,
        ),
      );

      this.broadcastState(roomId);
      return { ok: true };
    });
  }

  private async broadcastState(roomId: string) {
    const room = await this.roomsService.getRoom(roomId);
    const validRoom = this.gameEngine.ensureValidState(room);
    await this.roomsService.save(validRoom);
    await this.roomBroadcastService.publishState(
      await this.roomsService.getPublicRoom(roomId),
    );
  }


  private requireRoomId(roomId: string) {
    if (!isValidRoomId(roomId)) {
      throw new Error('A valid room ID is required.');
    }

    return normalizeRoomId(roomId);
  }

  private async tryAction<T>(client: Socket, action: () => T | Promise<T>) {
    try {
      return await action();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected room error.';
      this.logger.warn(`Socket action failed for ${client.id}: ${message}`);
      client.emit(GAME_EVENTS.ERROR, { message });
      return { ok: false, message } as T;
    }
  }

  private async publishRoomEvent(roomId: string, event: string, payload: unknown) {
    await this.roomBroadcastService.publish(roomId, event, payload);
  }

  private async validateGameAction(
    client: Socket,
    eventName: string,
    payload: RoomPlayerActionDto,
    room: Awaited<ReturnType<RoomsService['getRoom']>>,
    options: {
      cooldownMs: number;
      requireLiveMatch?: boolean;
    },
  ) {
    await this.gameActionGuard.validateOrThrow({
      room,
      roomId: room.id,
      playerId: payload.playerId,
      actionId: payload.actionId,
      client,
      eventName,
      cooldownMs: options.cooldownMs,
      requireLiveMatch: options.requireLiveMatch,
    });
  }
}
