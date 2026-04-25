import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as pg from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const pool = new pg.Pool({ 
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      max: 20,
    });
    const adapter = new PrismaPg(pool);
    
    super({ 
      adapter,
      log: ['warn', 'error'],
    });

  }

  async onModuleInit() {
    try {
      await this.$connect();
      console.log("Prisma connected successfully via driver adapter");
    } catch (error) {
      console.error("Prisma failed to connect on init, will retry on first query:", error);
    }
  }


  async onModuleDestroy() {
    await this.$disconnect();
  }
}
