import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';

interface SetValueOptions {
  ttlSeconds?: number;
  ttlMilliseconds?: number;
  onlyIfNotExists?: boolean;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly fallbackStore = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  private readonly client: Redis | null;

  constructor() {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      this.client = null;
      this.logger.warn(
        'REDIS_URL is not configured. Falling back to in-memory cache.',
      );
      return;
    }

    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });

    this.client.on('error', (error) => {
      this.logger.warn(`Redis error: ${error.message}`);
    });
  }

  async onModuleInit() {
    if (!this.client) {
      return;
    }

    try {
      await this.client.connect();
      this.logger.log('Redis connected successfully.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown Redis error';
      this.logger.warn(`Redis unavailable, using fallback store: ${message}`);
    }
  }

  async onModuleDestroy() {
    if (this.client && this.client.status !== 'end') {
      await this.client.quit().catch(() => undefined);
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.isRedisReady()) {
      try {
        return await this.client!.get(key);
      } catch (error) {
        this.logger.warn(
          `Redis get failed for ${key}: ${this.stringifyError(error)}`,
        );
      }
    }

    return this.getFallbackValue(key);
  }

  async set(
    key: string,
    value: string,
    options?: SetValueOptions,
  ): Promise<boolean> {
    if (this.isRedisReady()) {
      try {
        const args: Array<string | number> = [];

        if (options?.ttlMilliseconds) {
          args.push('PX', options.ttlMilliseconds);
        } else if (options?.ttlSeconds) {
          args.push('EX', options.ttlSeconds);
        }

        if (options?.onlyIfNotExists) {
          args.push('NX');
        }

        const setCommand = this.client!.set as unknown as {
          call: (
            self: Redis,
            ...input: Array<string | number>
          ) => Promise<string | null>;
        };
        const result = await setCommand.call(this.client!, key, value, ...args);
        return result === 'OK';
      } catch (error) {
        this.logger.warn(
          `Redis set failed for ${key}: ${this.stringifyError(error)}`,
        );
      }
    }

    return this.setFallbackValue(key, value, options);
  }

  async del(key: string): Promise<void> {
    if (this.isRedisReady()) {
      await this.client!.del(key).catch(() => undefined);
    }

    this.fallbackStore.delete(key);
  }

  private isRedisReady() {
    return Boolean(this.client && this.client.status === 'ready');
  }

  private getFallbackValue(key: string) {
    const entry = this.fallbackStore.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.fallbackStore.delete(key);
      return null;
    }

    return entry.value;
  }

  private setFallbackValue(
    key: string,
    value: string,
    options?: SetValueOptions,
  ) {
    const current = this.getFallbackValue(key);
    if (options?.onlyIfNotExists && current !== null) {
      return false;
    }

    const ttl =
      options?.ttlMilliseconds ??
      (options?.ttlSeconds ? options.ttlSeconds * 1000 : null);

    this.fallbackStore.set(key, {
      value,
      expiresAt: ttl ? Date.now() + ttl : null,
    });

    return true;
  }

  private stringifyError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
