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
  private readonly fallbackSets = new Map<string, Set<string>>();
  private readonly patternSubscribers = new Map<
    string,
    Set<(channel: string, payload: string) => void | Promise<void>>
  >();
  private readonly client: Redis | null;
  private subscriber: Redis | null = null;

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
    this.subscriber = this.client.duplicate();

    this.client.on('error', (error) => {
      this.logger.warn(`Redis error: ${error.message}`);
    });
    this.subscriber.on('error', (error) => {
      this.logger.warn(`Redis subscriber error: ${error.message}`);
    });
    this.subscriber.on('pmessage', (pattern, channel, payload) => {
      const listeners = this.patternSubscribers.get(pattern);
      if (!listeners) {
        return;
      }

      for (const listener of listeners) {
        void listener(channel, payload);
      }
    });
  }

  async onModuleInit() {
    if (!this.client) {
      return;
    }

    try {
      await this.client.connect();
      if (this.subscriber) {
        await this.subscriber.connect();
        if (this.patternSubscribers.size > 0) {
          await this.subscriber.psubscribe(...this.patternSubscribers.keys());
        }
      }
      this.logger.log('Redis connected successfully.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown Redis error';
      this.logger.warn(`Redis unavailable, using fallback store: ${message}`);
    }
  }

  async onModuleDestroy() {
    if (this.subscriber && this.subscriber.status !== 'end') {
      await this.subscriber.quit().catch(() => undefined);
    }

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

  async publish(channel: string, payload: string): Promise<void> {
    if (this.isRedisReady()) {
      await this.client!.publish(channel, payload).catch(() => undefined);
      return;
    }

    for (const [pattern, listeners] of this.patternSubscribers.entries()) {
      if (!this.matchesPattern(channel, pattern)) {
        continue;
      }

      for (const listener of listeners) {
        await listener(channel, payload);
      }
    }
  }

  async subscribePattern(
    pattern: string,
    listener: (channel: string, payload: string) => void | Promise<void>,
  ): Promise<void> {
    const listeners = this.patternSubscribers.get(pattern) ?? new Set();
    listeners.add(listener);
    this.patternSubscribers.set(pattern, listeners);

    if (this.subscriber?.status === 'ready') {
      await this.subscriber.psubscribe(pattern).catch(() => undefined);
    }
  }

  async addToSet(key: string, member: string): Promise<void> {
    if (this.isRedisReady()) {
      await this.client!.sadd(key, member).catch(() => undefined);
      return;
    }

    const set = this.fallbackSets.get(key) ?? new Set<string>();
    set.add(member);
    this.fallbackSets.set(key, set);
  }

  async removeFromSet(key: string, member: string): Promise<void> {
    if (this.isRedisReady()) {
      await this.client!.srem(key, member).catch(() => undefined);
      return;
    }

    const set = this.fallbackSets.get(key);
    if (!set) {
      return;
    }

    set.delete(member);
    if (set.size === 0) {
      this.fallbackSets.delete(key);
    }
  }

  async countSetMembers(key: string): Promise<number> {
    if (this.isRedisReady()) {
      return this.client!.scard(key).catch(() => 0);
    }

    return this.fallbackSets.get(key)?.size ?? 0;
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

  private matchesPattern(channel: string, pattern: string) {
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return regex.test(channel);
  }
}
