import { Controller, Get } from '@nestjs/common';
import { RoomsService } from './game/services/rooms.service';

@Controller()
export class AppController {
  constructor(private readonly roomsService: RoomsService) {}

  @Get()
  getHealth() {
    return {
      service: 'hand-cricket-server',
      status: 'ok',
      activeRooms: this.roomsService.getRoomCount(),
      persistence: this.roomsService.getPersistenceMetrics(),
      timestamp: new Date().toISOString(),
    };
  }
}
