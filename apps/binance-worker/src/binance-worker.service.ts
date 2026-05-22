import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { webSocket } from 'rxjs/webSocket';
import { Subscription, timer } from 'rxjs';
import { bufferTime, filter, map, retry } from 'rxjs/operators';
import { DatabaseService } from 'app/database';
import * as ws from 'ws';

interface BinanceMiniTicker {
  e: string; // Event type
  E: number; // Event time
  s: string; // Symbol
  c: string; // Close price
  o: string; // Open price
  h: string; // High price
  l: string; // Low price
  v: string; // Total traded base asset volume
  q: string; // Total traded quote asset volume (USDT for USDT pairs)
}

interface PriceVolumeState {
  prices: number[]; // 120 slots of 1-minute price snapshots
  volumes: number[]; // 120 slots of 1-minute volume deltas
  dailyVolumes: number[]; // 24 slots of hourly snapshots of 24h cumulative volume
  lastUpdatedMin: number;
  lastUpdatedHour: number;
  prevCumulativeVolume: number;
}

interface UserConfigCache {
  userId: string;
  telegramId: string;
  priceThreshold1h: number;
  priceThreshold24h: number;
  volumeThreshold1h: number;
  volumeThreshold24h: number;
}

@Injectable()
export class BinanceWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BinanceWorkerService.name);
  private wsSubscription?: Subscription;
  private readonly wsUrl = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';

  // RAM sliding window state for all active symbols
  private readonly priceVolumeTracker = new Map<string, PriceVolumeState>();

  // Local cache of active user configs to prevent hitting DB on every WebSocket tick
  private activeUserConfigs: UserConfigCache[] = [];
  private configRefreshTimer?: NodeJS.Timeout;

  // Cooldown tracker to prevent spamming: Map<"userId:symbol:alertType", expiryTimestamp>
  private readonly alertCooldowns = new Map<string, number>();

  constructor(
    private readonly databaseService: DatabaseService,
    @InjectQueue('telegram-alerts') private readonly alertsQueue: Queue,
  ) { }

  async onModuleInit() {
    this.logger.log('Initializing Binance Worker Service...');

    // Load configurations from DB immediately, then refresh every 1 minute
    await this.refreshUserConfigs();
    this.configRefreshTimer = setInterval(() => {
      void this.refreshUserConfigs();
    }, 60000);

    // Connect to WebSocket stream
    this.connectToBinanceWebSocket();
  }

  onModuleDestroy() {
    if (this.wsSubscription) {
      this.wsSubscription.unsubscribe();
    }
    if (this.configRefreshTimer) {
      clearInterval(this.configRefreshTimer);
    }
  }

  /**
   * Refreshes active alert configurations from the database into RAM
   */
  private async refreshUserConfigs() {
    try {
      const activeConfigs = await this.databaseService.alertsConfig.findMany({
        where: {
          isActive: true,
          isMuted: false,
        },
        include: {
          user: true,
        },
      });

      this.activeUserConfigs = activeConfigs.map((config) => ({
        userId: config.userId,
        telegramId: config.user.telegramId,
        priceThreshold1h: config.priceThreshold1h,
        priceThreshold24h: config.priceThreshold24h,
        volumeThreshold1h: config.volumeThreshold1h,
        volumeThreshold24h: config.volumeThreshold24h,
      }));

      this.logger.log(
        `Refreshed ${this.activeUserConfigs.length} active user configuration(s) from DB.`,
      );
    } catch (error) {
      this.logger.error(
        'Failed to refresh user configurations from database:',
        error,
      );
    }
  }

  /**
   * Connects to Binance WebSocket using RxJS with automatic reconnection
   */
  private connectToBinanceWebSocket() {
    this.logger.log(`Connecting to Binance WebSocket at: ${this.wsUrl}`);

    const wsSubject$ = webSocket<BinanceMiniTicker[]>({
      url: this.wsUrl,
      WebSocketCtor: ws.WebSocket as unknown as new (
        url: string,
        protocols?: string | string[],
      ) => WebSocket,
    });

    this.wsSubscription = wsSubject$
      .pipe(
        // Reconnect with exponential backoff if the socket closes or fails
        retry({
          delay: (error, retryCount) => {
            const delayTime = Math.min(1000 * Math.pow(2, retryCount), 30000);
            const errMsg =
              error instanceof Error ? error.message : JSON.stringify(error);
            this.logger.warn(
              `Binance WS disconnected (${errMsg}). Reconnecting in ${delayTime}ms... (Attempt ${retryCount})`,
            );
            return timer(delayTime);
          },
        }),
        // Buffer ticks for 5 seconds to process updates in batches
        bufferTime(5000),
        filter((buffers) => buffers.length > 0),
        // Keep only the latest tick for each symbol in the buffered time window
        map((buffers) => this.deduplicateBuffer(buffers)),
      )
      .subscribe({
        next: (latestTicks) => {
          this.processTicks(latestTicks);
        },
        error: (err) => {
          this.logger.error('Unhandled Binance WebSocket Error:', err);
        },
      });
  }

  /**
   * Filter buffer and keep only the latest tick for each USDT symbol
   */
  private deduplicateBuffer(
    buffers: BinanceMiniTicker[][],
  ): Map<string, BinanceMiniTicker> {
    const latestTicks = new Map<string, BinanceMiniTicker>();
    for (const batch of buffers) {
      for (const tick of batch) {
        if (tick.s.endsWith('USDT')) {
          latestTicks.set(tick.s, tick);
        }
      }
    }
    return latestTicks;
  }

  /**
   * Updates RAM sliding windows and checks thresholds
   */
  private processTicks(ticks: Map<string, BinanceMiniTicker>) {
    const now = Date.now();
    const currentMin = Math.floor(now / 60000);
    const currentHour = Math.floor(now / 3600000);

    for (const [symbol, tick] of ticks.entries()) {
      const price = parseFloat(tick.c);
      const openPrice24h = parseFloat(tick.o);
      const cumulativeVolume = parseFloat(tick.q); // Quote asset volume in USDT

      let state = this.priceVolumeTracker.get(symbol);

      if (!state) {
        // Initialize state
        state = {
          prices: new Array<number>(120).fill(price),
          volumes: new Array<number>(120).fill(0),
          dailyVolumes: new Array<number>(24).fill(cumulativeVolume),
          lastUpdatedMin: currentMin,
          lastUpdatedHour: currentHour,
          prevCumulativeVolume: cumulativeVolume,
        };
        this.priceVolumeTracker.set(symbol, state);
        continue;
      }

      // 1. Minute-level sliding window update
      if (currentMin > state.lastUpdatedMin) {
        // Calculate volume delta for the minute
        // Because Binance volume is rolling 24h, a decrease can happen if old blocks drop.
        // We capture positive deltas to approximate newly generated volume.
        const volumeDelta = Math.max(
          0,
          cumulativeVolume - state.prevCumulativeVolume,
        );

        state.prices.push(price);
        state.volumes.push(volumeDelta);

        if (state.prices.length > 120) state.prices.shift();
        if (state.volumes.length > 120) state.volumes.shift();

        state.prevCumulativeVolume = cumulativeVolume;
        state.lastUpdatedMin = currentMin;

        // Perform 1-hour rolling evaluations
        this.evaluateHourlyAlerts(symbol, price, state);
      } else {
        // Update the current minute's running data
        state.prices[state.prices.length - 1] = price;
      }

      // 2. Hour-level sliding window update for 24h rolling volume
      if (currentHour > state.lastUpdatedHour) {
        state.dailyVolumes.push(cumulativeVolume);
        if (state.dailyVolumes.length > 24) state.dailyVolumes.shift();
        state.lastUpdatedHour = currentHour;

        // Perform 24-hour rolling evaluations
        this.evaluateDailyAlerts(symbol, price, openPrice24h, state);
      }
    }
  }

  /**
   * Evaluates 1h price and volume changes
   */
  private evaluateHourlyAlerts(
    symbol: string,
    currentPrice: number,
    state: PriceVolumeState,
  ) {
    const price1hAgo = state.prices[59]; // Index 59 is 60 minutes ago in a 120-size array
    const priceChange1h = ((currentPrice - price1hAgo) / price1hAgo) * 100;

    // Calculate rolling volume in last hour vs. previous hour
    const volume1hCurr = state.volumes
      .slice(60, 120)
      .reduce((sum, v) => sum + v, 0);
    const volume1hPrev = state.volumes
      .slice(0, 60)
      .reduce((sum, v) => sum + v, 0);

    // Calculate volume increase percentage
    let volumeChange1h = 0;
    if (volume1hPrev > 0) {
      volumeChange1h = ((volume1hCurr - volume1hPrev) / volume1hPrev) * 100;
    } else if (volume1hCurr > 0) {
      volumeChange1h = 100.0; // 100% increase if prev was empty
    }

    const now = Date.now();

    for (const config of this.activeUserConfigs) {
      // 1. Check 1h Price Alert
      if (Math.abs(priceChange1h) >= config.priceThreshold1h) {
        const cooldownKey = `${config.userId}:${symbol}:PRICE_1H`;
        const cooldownExpiry = this.alertCooldowns.get(cooldownKey) || 0;

        if (now > cooldownExpiry) {
          void this.alertsQueue.add('alert-job', {
            userId: config.userId,
            telegramId: config.telegramId,
            symbol,
            alertType: 'PRICE_VOLATILITY',
            timeframe: 'H1',
            oldValue: price1hAgo,
            newValue: currentPrice,
            percentageChange: priceChange1h,
          });

          // Set 15 minutes cooldown
          this.alertCooldowns.set(cooldownKey, now + 15 * 60 * 1000);
        }
      }

      // 2. Check 1h Volume Alert
      if (volumeChange1h >= config.volumeThreshold1h && volume1hCurr > 5000) {
        // Limit noise with min 5000 USDT vol
        const cooldownKey = `${config.userId}:${symbol}:VOLUME_1H`;
        const cooldownExpiry = this.alertCooldowns.get(cooldownKey) || 0;

        if (now > cooldownExpiry) {
          void this.alertsQueue.add('alert-job', {
            userId: config.userId,
            telegramId: config.telegramId,
            symbol,
            alertType: 'VOLUME_VOLATILITY',
            timeframe: 'H1',
            oldValue: volume1hPrev,
            newValue: volume1hCurr,
            percentageChange: volumeChange1h,
          });

          // Set 15 minutes cooldown
          this.alertCooldowns.set(cooldownKey, now + 15 * 60 * 1000);
        }
      }
    }

    // Proactively clean up expired cooldowns to save RAM
    this.cleanExpiredCooldowns(now);
  }

  /**
   * Evaluates 24h price and volume changes
   */
  private evaluateDailyAlerts(
    symbol: string,
    currentPrice: number,
    openPrice24h: number,
    state: PriceVolumeState,
  ) {
    const priceChange24h = ((currentPrice - openPrice24h) / openPrice24h) * 100;

    const volume24hCurr = state.dailyVolumes[state.dailyVolumes.length - 1];
    const volume24hAgo = state.dailyVolumes[0];

    let volumeChange24h = 0;
    if (volume24hAgo > 0) {
      volumeChange24h = ((volume24hCurr - volume24hAgo) / volume24hAgo) * 100;
    }

    const now = Date.now();

    for (const config of this.activeUserConfigs) {
      // 1. Check 24h Price Alert
      if (Math.abs(priceChange24h) >= config.priceThreshold24h) {
        const cooldownKey = `${config.userId}:${symbol}:PRICE_24H`;
        const cooldownExpiry = this.alertCooldowns.get(cooldownKey) || 0;

        if (now > cooldownExpiry) {
          void this.alertsQueue.add('alert-job', {
            userId: config.userId,
            telegramId: config.telegramId,
            symbol,
            alertType: 'PRICE_VOLATILITY',
            timeframe: 'H24',
            oldValue: openPrice24h,
            newValue: currentPrice,
            percentageChange: priceChange24h,
          });

          // Set 1 hour cooldown for daily alerts
          this.alertCooldowns.set(cooldownKey, now + 60 * 60 * 1000);
        }
      }

      // 2. Check 24h Volume Alert
      if (
        volumeChange24h >= config.volumeThreshold24h &&
        volume24hCurr > 50000
      ) {
        const cooldownKey = `${config.userId}:${symbol}:VOLUME_24H`;
        const cooldownExpiry = this.alertCooldowns.get(cooldownKey) || 0;

        if (now > cooldownExpiry) {
          void this.alertsQueue.add('alert-job', {
            userId: config.userId,
            telegramId: config.telegramId,
            symbol,
            alertType: 'VOLUME_VOLATILITY',
            timeframe: 'H24',
            oldValue: volume24hAgo,
            newValue: volume24hCurr,
            percentageChange: volumeChange24h,
          });

          // Set 1 hour cooldown for daily alerts
          this.alertCooldowns.set(cooldownKey, now + 60 * 60 * 1000);
        }
      }
    }
  }

  /**
   * Helper to clean up expired alerts cooldown keys
   */
  private cleanExpiredCooldowns(now: number) {
    for (const [key, expiry] of this.alertCooldowns.entries()) {
      if (now > expiry) {
        this.alertCooldowns.delete(key);
      }
    }
  }
}
