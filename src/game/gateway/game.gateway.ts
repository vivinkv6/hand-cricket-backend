import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
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
import { isValidRoomId, normalizeRoomId } from '../utils/room-id.util';

@WebSocketGateway({
  cors: {
    origin: process.env.CLIENT_ORIGIN?.split(',') ?? true,
    credentials: true,
  },
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GameGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly roomsService: RoomsService,
    private readonly gameEngine: GameEngine,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Socket connected: ${client.id}`);
    client.emit('connected', { socketId: client.id });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Socket disconnected: ${client.id}`);
    const rooms = Array.from(client.rooms.values()).filter(
      (room) => room !== client.id,
    );

    for (const roomId of rooms) {
      try {
        const room = this.roomsService.getRoom(roomId);
        this.roomsService.save(
          this.gameEngine.disconnectPlayer(room, client.id),
        );
        this.server.to(roomId).emit(GAME_EVENTS.PLAYER_DISCONNECTED, {
          roomId,
          playerSocketId: client.id,
        });
        this.logger.debug(
          `Adapter rooms after disconnect: ${JSON.stringify(
            [...this.server.sockets.adapter.rooms.entries()].map(
              ([id, members]) => [id, [...members]],
            ),
          )}`,
        );
        this.broadcastState(roomId);
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
    return this.tryAction(client, () => {
      this.logger.log(
        `CREATE_ROOM from ${client.id} mode=${payload.mode} teamSize=${payload.teamSize ?? 1}`,
      );
      const room = this.roomsService.createRoom(
        payload.mode,
        payload.playerName,
        client.id,
        payload.teamSize,
      );

      void client.join(room.id);
      // Development visibility for room membership while hardening multiplayer flows.
      console.log(this.server.sockets.adapter.rooms);
      this.broadcastState(room.id);
      return {
        ok: true,
        roomId: room.id,
        playerId: room.players.find((player) => player.socketId === client.id)
          ?.id,
      };
    });
  }

  @SubscribeMessage(GAME_EVENTS.JOIN_ROOM)
  handleJoinRoom(
    @MessageBody() payload: JoinRoomDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, () => {
      if (!isValidRoomId(payload.roomId)) {
        throw new Error('A valid room ID is required to join a room.');
      }

      const normalizedRoomId = normalizeRoomId(payload.roomId);
      this.logger.log(`JOIN_ROOM from ${client.id} roomId=${normalizedRoomId}`);
      const room = this.roomsService.getRoom(normalizedRoomId);
      this.roomsService.save(
        this.gameEngine.joinRoom(
          room,
          payload.playerName,
          client.id,
          payload.playerId,
        ),
      );

      void client.join(normalizedRoomId);
      console.log(this.server.sockets.adapter.rooms);
      this.broadcastState(normalizedRoomId);
      return {
        ok: true,
        roomId: normalizedRoomId,
        playerId: room.players.find((player) => player.socketId === client.id)
          ?.id,
      };
    });
  }

  @SubscribeMessage(GAME_EVENTS.REJOIN_ROOM)
  handleRejoinRoom(
    @MessageBody() payload: RejoinRoomDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, () => {
      if (!isValidRoomId(payload.roomId)) {
        throw new Error('A valid room ID is required to rejoin a room.');
      }

      const normalizedRoomId = normalizeRoomId(payload.roomId);
      this.logger.log(
        `REJOIN_ROOM from ${client.id} roomId=${normalizedRoomId} playerId=${payload.playerId}`,
      );
      const room = this.roomsService.getRoom(normalizedRoomId);
      this.roomsService.save(
        this.gameEngine.rejoinRoom(room, payload.playerId, client.id),
      );
      void client.join(normalizedRoomId);
      this.server.to(normalizedRoomId).emit(GAME_EVENTS.PLAYER_RECONNECTED, {
        roomId: normalizedRoomId,
        playerId: payload.playerId,
      });
      this.broadcastState(normalizedRoomId);
      return { ok: true, roomId: normalizedRoomId, playerId: payload.playerId };
    });
  }

  @SubscribeMessage(GAME_EVENTS.START_GAME)
  handleStartGame(
    @MessageBody() payload: RoomPlayerActionDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = this.roomsService.getRoom(roomId);
      this.roomsService.save(this.gameEngine.startGame(room, payload.playerId));
      this.broadcastState(roomId);
      return { ok: true };
    });
  }

  @SubscribeMessage(GAME_EVENTS.SELECT_BOWLER)
  handleSelectBowler(
    @MessageBody() payload: SelectBowlerDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = this.roomsService.getRoom(roomId);
      this.roomsService.save(
        this.gameEngine.selectBowler(room, payload.playerId, payload.bowlerId),
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
    return this.tryAction(client, () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = this.roomsService.getRoom(roomId);
      this.roomsService.save(
        this.gameEngine.selectToss(room, payload.playerId, payload.choice),
      );
      this.broadcastState(roomId);
      return { ok: true };
    });
  }

  @SubscribeMessage(GAME_EVENTS.SELECT_NUMBER)
  handleSelectNumber(
    @MessageBody() payload: SelectNumberDto,
    @ConnectedSocket() client: Socket,
  ) {
    return this.tryAction(client, () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = this.roomsService.getRoom(roomId);
      const resolution = this.gameEngine.selectNumber(
        room,
        payload.playerId,
        payload.number,
      );
      this.roomsService.save(resolution.room);

      if (resolution.room.lastRoundResult) {
        this.server
          .to(roomId)
          .emit(GAME_EVENTS.ROUND_RESULT, resolution.room.lastRoundResult);
      }

      for (const event of resolution.events) {
        if (event.type === 'switchInnings') {
          this.server
            .to(roomId)
            .emit(GAME_EVENTS.SWITCH_INNINGS, event.payload);
        }
        if (event.type === 'gameOver') {
          this.server.to(roomId).emit(GAME_EVENTS.GAME_OVER, event.payload);
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
    return this.tryAction(client, () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = this.roomsService.getRoom(roomId);
      this.roomsService.save(
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
    return this.tryAction(client, () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = this.roomsService.getRoom(roomId);
      this.roomsService.save(
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
    return this.tryAction(client, () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = this.roomsService.getRoom(roomId);
      this.roomsService.save(
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

  private broadcastState(roomId: string) {
    this.server
      .to(roomId)
      .emit(
        GAME_EVENTS.GAME_STATE_UPDATE,
        this.roomsService.getPublicRoom(roomId),
      );
  }

  private requireRoomId(roomId: string) {
    if (!isValidRoomId(roomId)) {
      throw new Error('A valid room ID is required.');
    }

    return normalizeRoomId(roomId);
  }

  private tryAction<T>(client: Socket, action: () => T) {
    try {
      return action();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected room error.';
      this.logger.warn(`Socket action failed for ${client.id}: ${message}`);
      client.emit(GAME_EVENTS.ERROR, { message });
      return { ok: false, message } as T;
    }
  }
}
