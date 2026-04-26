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
  pingTimeout: 60000,
  pingInterval: 25000,
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

  async handleDisconnect(client: Socket) {
    this.logger.log(`Socket disconnected: ${client.id}`);
    const rooms = Array.from(client.rooms.values()).filter(
      (room) => room !== client.id,
    );

    for (const roomId of rooms) {
      try {
        const room = await this.roomsService.getRoom(roomId);
        await this.roomsService.save(
          this.gameEngine.disconnectPlayer(room, client.id),
        );
        this.server.to(roomId).emit(GAME_EVENTS.PLAYER_DISCONNECTED, {
          roomId,
          playerSocketId: client.id,
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

      await client.join(normalizedRoomId);
      this.server.to(normalizedRoomId).emit(GAME_EVENTS.PLAYER_RECONNECTED, {
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
      this.verifyPlayerAuth(room, payload.playerId, client.id);
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
      this.verifyPlayerAuth(room, payload.playerId, client.id);
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
      this.verifyPlayerAuth(room, payload.playerId, client.id);
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
      this.verifyPlayerAuth(room, payload.playerId, client.id);
      const resolution = this.gameEngine.selectNumber(
        room,
        payload.playerId,
        payload.number,
      );
      await this.roomsService.save(resolution.room, true, {
        appendLastRound: Boolean(resolution.room.lastRoundResult),
      });


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
    return this.tryAction(client, async () => {

      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      this.verifyPlayerAuth(room, payload.playerId, client.id);
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
      this.verifyPlayerAuth(room, payload.playerId, client.id);
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
    // Update the room in memory with validated state
    await this.roomsService.save(validRoom);
    this.server
      .to(roomId)
      .emit(
        GAME_EVENTS.GAME_STATE_UPDATE,
        this.gameEngine.toPublicState(validRoom),
      );
  }


  private requireRoomId(roomId: string) {
    if (!isValidRoomId(roomId)) {
      throw new Error('A valid room ID is required.');
    }

    return normalizeRoomId(roomId);
  }

  private readonly rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  private readonly RATE_LIMIT_WINDOW_MS = 5000;
  private readonly RATE_LIMIT_MAX = 10;

  private checkRateLimit(clientId: string): void {
    const now = Date.now();
    const record = this.rateLimitMap.get(clientId);
    
    if (!record || now > record.resetAt) {
      this.rateLimitMap.set(clientId, { count: 1, resetAt: now + this.RATE_LIMIT_WINDOW_MS });
      this.cleanupRateLimitMap();
      return;
    }

    record.count += 1;
    if (record.count > this.RATE_LIMIT_MAX) {
      this.rateLimitMap.delete(clientId);
      throw new Error('Rate limit exceeded. Please slow down.');
    }
  }

  private cleanupRateLimitMap(): void {
    const now = Date.now();
    for (const [key, record] of this.rateLimitMap.entries()) {
      if (now > record.resetAt) {
        this.rateLimitMap.delete(key);
      }
    }
  }

  private async tryAction<T>(client: Socket, action: () => T | Promise<T>) {
    try {
      this.checkRateLimit(client.id);
      return await action();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected room error.';
      this.logger.warn(`Socket action failed for ${client.id}: ${message}`);
      client.emit(GAME_EVENTS.ERROR, { message });
      return { ok: false, message } as T;
    }
  }

  private verifyPlayerAuth(room: { players: { id: string; socketId: string | null; connected: boolean }[] }, playerId: string, clientId: string): void {
    const player = room.players.find(p => p.id === playerId);
    if (!player) {
      throw new Error('Player not found in this room.');
    }
    if (!player.connected) {
      throw new Error('Player is not connected.');
    }
    if (player.socketId !== clientId) {
      throw new Error('Player authentication failed. Invalid session.');
    }
  }

}
