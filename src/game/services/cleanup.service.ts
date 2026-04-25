import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(private prisma: PrismaService) {}

  // Run once per week (Sunday at midnight)
  @Cron(CronExpression.EVERY_WEEK)
  async handleWeeklyCleanup() {
    this.logger.log('Starting weekly data cleanup...');
    
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    try {
      const deletedMatches = await this.prisma.match.deleteMany({
        where: {
          createdAt: {
            lt: sevenDaysAgo,
          },
        },
      });

      this.logger.log(`Cleanup complete. Deleted ${deletedMatches.count} matches and related records.`);
    } catch (error) {
      this.logger.error('Error during weekly cleanup', error.stack);
    }
  }
}
