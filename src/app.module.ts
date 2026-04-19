import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { GameGateway } from './game/gateway/game.gateway';
import { GameEngine } from './game/engine/game.engine';
import { RoomsService } from './game/services/rooms.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [RoomsService, GameEngine, GameGateway],
})
export class AppModule {}
