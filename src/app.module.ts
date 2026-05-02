import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { GameGateway } from './game/gateway/game.gateway';
import { GameEngine } from './game/engine/game.engine';
import { RoomsService } from './game/services/rooms.service';
import { CleanupService } from './game/services/cleanup.service';
import { MatchesService } from './game/services/matches.service';
import { GameActionGuard } from './game/services/game-action.guard';
import { RoomCacheService } from './game/services/room-cache.service';
import { PrismaModule } from './prisma/prisma.module';
import { RedisService } from './redis/redis.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [
    RoomsService,
    GameEngine,
    GameGateway,
    CleanupService,
    MatchesService,
    RedisService,
    RoomCacheService,
    GameActionGuard,
  ],
})
export class AppModule {}

