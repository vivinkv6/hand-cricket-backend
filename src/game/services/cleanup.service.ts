import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RoomsService } from './rooms.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(private readonly roomsService: RoomsService) {}

  // Run every day at midnight IST and delete rooms older than 24 hours.
  @Cron('0 0 * * *', {
    timeZone: 'Asia/Kolkata',
  })
  async handleMidnightCleanup() {
    this.logger.log('Starting midnight room cleanup for stale rooms...');

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    try {
      const { deletedCount, roomIds } =
        await this.roomsService.purgeRoomsOlderThan(cutoff);

      this.logger.log(
        `Midnight cleanup complete. Deleted ${deletedCount} room(s) older than ${cutoff.toISOString()}.`,
      );

      if (roomIds.length > 0) {
        this.logger.debug(`Deleted room IDs: ${roomIds.join(', ')}`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.error('Error during midnight room cleanup', message);
    }
  }
}
