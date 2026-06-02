import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { webSocket } from 'rxjs/webSocket';
import { Subscription, timer } from 'rxjs';
import { bufferTime, filter, map, retry } from 'rxjs/operators';
import { DatabaseService } from 'app/database';
import * as ws from 'ws';
import {
  KlineScannerService,
  PriceVolumeState,
  UserConfigCache,
} from './scanner/kline-scanner.service';

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

  // Track last hour where independent EMA scans were run
  private lastScannedHour = -1;

  // Cooldown tracker to prevent spamming: Map<"userId:symbol:alertType", expiryTimestamp>
  private readonly alertCooldowns = new Map<string, number>();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly klineScannerService: KlineScannerService,
  ) {}

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
        },
        include: {
          user: true,
        },
      });

      this.activeUserConfigs = activeConfigs.map((config) => ({
        userId: config.userId,
        telegramId: config.user.telegramId,
        volumeThreshold24h: config.volumeThreshold24h,
        emaReversalFilter: config.emaReversalFilter,
        emaTimeframe: config.emaTimeframe,
        minVolume24h: config.minVolume24h,
        emaTrendFilter: config.emaTrendFilter,
        emaTarget: config.emaTarget,
        candlePattern: config.candlePattern,
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
          void this.processTicks(latestTicks);
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
  private async processTicks(ticks: Map<string, BinanceMiniTicker>) {
    const now = Date.now();
    const currentMin = Math.floor(now / 60000);
    const currentHour = Math.floor(now / 3600000);

    // Clean expired cooldowns periodically (hourly)
    this.cleanExpiredCooldowns(now);

    // Run independent EMA scan when a new hour closes
    if (this.lastScannedHour === -1) {
      this.lastScannedHour = currentHour;
    } else if (currentHour > this.lastScannedHour) {
      this.lastScannedHour = currentHour;
      void this.klineScannerService.runIndependentEmaScan(
        currentHour,
        Array.from(this.priceVolumeTracker.keys()),
        this.activeUserConfigs,
        this.alertCooldowns,
        this.priceVolumeTracker,
      );
    }

    for (const [symbol, tick] of ticks.entries()) {
      const price = parseFloat(tick.c);
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
      } else {
        // Update the current minute's running data
        state.prices[state.prices.length - 1] = price;
      }

      // 2. Hour-level sliding window update for 24h rolling volume
      if (currentHour > state.lastUpdatedHour) {
        state.dailyVolumes.push(cumulativeVolume);
        if (state.dailyVolumes.length > 24) state.dailyVolumes.shift();
        state.lastUpdatedHour = currentHour;

        // Perform 24-hour rolling evaluations via KlineScannerService
        await this.klineScannerService.evaluateDailyAlerts(
          symbol,
          price,
          cumulativeVolume,
          state,
          this.activeUserConfigs,
          this.alertCooldowns,
        );
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
