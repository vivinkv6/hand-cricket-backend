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
import { MatchesService } from '../services/matches.service';
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
    private readonly matchesService: MatchesService,
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


      void client.join(room.id);
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
    return this.tryAction(client, async () => {
      if (!isValidRoomId(payload.roomId)) {
        throw new Error('A valid room ID is required to join a room.');
      }


      const normalizedRoomId = normalizeRoomId(payload.roomId);
      this.logger.log(`JOIN_ROOM from ${client.id} roomId=${normalizedRoomId}`);
      const room = await this.roomsService.getRoom(normalizedRoomId);
      await this.roomsService.save(
        this.gameEngine.joinRoom(
          room,
          payload.playerName,
          client.id,
          payload.playerId,
        ),
      );


      void client.join(normalizedRoomId);
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
    return this.tryAction(client, async () => {
      if (!isValidRoomId(payload.roomId)) {
        throw new Error('A valid room ID is required to rejoin a room.');
      }


      const normalizedRoomId = normalizeRoomId(payload.roomId);
      this.logger.log(
        `REJOIN_ROOM from ${client.id} roomId=${normalizedRoomId} playerId=${payload.playerId}`,
      );
      const room = await this.roomsService.getRoom(normalizedRoomId);
      await this.roomsService.save(
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
    return this.tryAction(client, async () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.roomsService.save(this.gameEngine.startGame(room, payload.playerId));

      
      // PERSISTENCE: Create match record and start 1st innings
      await this.matchesService.createMatchRecord(room);
      if (room.innings) {
        await this.matchesService.startInnings(room.id, 1, room.innings.battingTeamId);
      }
      
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
      await this.roomsService.save(
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
    return this.tryAction(client, async () => {

      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      await this.roomsService.save(
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
    return this.tryAction(client, async () => {
      const roomId = this.requireRoomId(payload.roomId);
      const room = await this.roomsService.getRoom(roomId);
      const resolution = this.gameEngine.selectNumber(
        room,
        payload.playerId,
        payload.number,
      );
      await this.roomsService.save(resolution.room);


      if (resolution.room.lastRoundResult) {
        this.server
          .to(roomId)
          .emit(GAME_EVENTS.ROUND_RESULT, resolution.room.lastRoundResult);
        
        // Save Ball to DB
        if (room.innings) {
          const playerNameMap: Record<string, string> = {};
          room.players.forEach(p => playerNameMap[p.id] = p.name);

          void this.matchesService.saveBall(room.id, room.innings.battingTeamId, {
            batsmanId: resolution.room.lastRoundResult.batterId,
            bowlerId: resolution.room.lastRoundResult.bowlerId,
            runs: resolution.room.lastRoundResult.runs,
            isWicket: resolution.room.lastRoundResult.isOut,
            playerNameMap,
          });
        }

      }

      for (const event of resolution.events) {
        if (event.type === 'switchInnings') {
          // 2-second delay for the final wicket animation to be seen
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          this.server
            .to(roomId)
            .emit(GAME_EVENTS.SWITCH_INNINGS, event.payload);
            
          // PERSISTENCE: Start 2nd innings
          if (room.innings) {
             void this.matchesService.startInnings(room.id, 2, room.innings.battingTeamId);
          }
        }

        if (event.type === 'gameOver') {
          // 2-second delay for the final match-winning ball to be seen
          await new Promise(resolve => setTimeout(resolve, 2000));

          const result = event.payload as any;
          this.server.to(roomId).emit(GAME_EVENTS.GAME_OVER, result);
          
          // PERSISTENCE: Finalize Match
          await this.matchesService.finalizeMatch(room.id, result, room.players);
          
          // MoM: Only for Team mode with no bots
          const hasBots = room.players.some(p => p.isBot);
          if (room.mode === 'team' && !hasBots) {
            const momData = await this.matchesService.calculateMOM(room.players);
            if (momData) {
              this.server.to(roomId).emit('man_of_the_match', momData);
            }
          }
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
    this.server
      .to(roomId)
      .emit(
        GAME_EVENTS.GAME_STATE_UPDATE,
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

}
