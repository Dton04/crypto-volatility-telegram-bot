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
  volumeThreshold24h: number;
  emaReversalFilter: boolean;
  emaTimeframe: string;
  minVolume24h: number;
  emaTrendFilter: boolean;
  emaTarget: string;
  candlePattern: string;
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
    @InjectQueue('telegram-alerts') private readonly alertsQueue: Queue,
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

    // Run independent EMA scan when a new hour closes
    if (this.lastScannedHour === -1) {
      this.lastScannedHour = currentHour;
    } else if (currentHour > this.lastScannedHour) {
      this.lastScannedHour = currentHour;
      void this.runIndependentEmaScan(currentHour);
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
        await this.evaluateDailyAlerts(symbol, price, cumulativeVolume, state);
      }
    }
  }

  /**
   * Evaluates 24h volume changes
   */
  private async evaluateDailyAlerts(
    symbol: string,
    currentPrice: number,
    cumulativeVolume: number,
    state: PriceVolumeState,
  ) {
    const volume24hCurr = state.dailyVolumes[state.dailyVolumes.length - 1];
    const volume24hAgo = state.dailyVolumes[0];

    let volumeChange24h = 0;
    if (volume24hAgo > 0) {
      volumeChange24h = ((volume24hCurr - volume24hAgo) / volume24hAgo) * 100;
    }

    const now = Date.now();

    for (const config of this.activeUserConfigs) {
      // 0. Filter by minimum 24h volume
      if (cumulativeVolume < config.minVolume24h) {
        continue;
      }

      // 1. Check 24h Volume Alert
      if (
        volumeChange24h >= config.volumeThreshold24h &&
        volume24hCurr > 50000
      ) {
        const cooldownKey = `${config.userId}:${symbol}:VOLUME_24H`;
        const cooldownExpiry = this.alertCooldowns.get(cooldownKey) || 0;

        if (now > cooldownExpiry) {
          const emaData = await this.getEmaReversalData(
            symbol,
            config.emaTimeframe,
            'all',
            false,
          );

          void this.alertsQueue.add('alert-job', {
            userId: config.userId,
            telegramId: config.telegramId,
            symbol,
            alertType: 'VOLUME_VOLATILITY',
            timeframe: 'H24',
            oldValue: volume24hAgo,
            newValue: volume24hCurr,
            percentageChange: volumeChange24h,
            currentPrice,
            emaTimeframe: config.emaTimeframe,
            touchEma: null,
            emaName: null,
            touchDiff: null,
            pattern: null,
            nearestEmaName: emaData?.nearestEmaName,
            nearestEmaVal: emaData?.nearestEmaVal,
            nearestEmaDiff: emaData?.nearestEmaDiff,
            ema34: emaData?.ema34,
            ema89: emaData?.ema89,
            ema200: emaData?.ema200,
            rsi: emaData?.rsi,
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

  private calculateEMA(prices: number[], period: number): number {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  private calculateRSI(closes: number[], period = 14): number {
    if (closes.length <= period) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const difference = closes[i] - closes[i - 1];
      if (difference > 0) {
        gains += difference;
      } else {
        losses -= difference;
      }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const difference = closes[i] - closes[i - 1];
      let currentGain = 0;
      let currentLoss = 0;
      if (difference > 0) {
        currentGain = difference;
      } else {
        currentLoss = -difference;
      }

      avgGain = (avgGain * (period - 1) + currentGain) / period;
      avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
    }

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
  }

  private detectReversalPattern(klines: unknown[][]): string | null {
    if (klines.length < 3) return null;

    const prev1 = klines[klines.length - 2] as string[];
    const prev2 = klines[klines.length - 3] as string[];

    const p1Open = parseFloat(prev1[1]);
    const p1High = parseFloat(prev1[2]);
    const p1Low = parseFloat(prev1[3]);
    const p1Close = parseFloat(prev1[4]);

    const p2Open = parseFloat(prev2[1]);
    const p2Close = parseFloat(prev2[4]);

    // 1. Detect Pinbar (Hammer / Inverted Hammer / Shooting Star)
    const body1 = Math.abs(p1Close - p1Open);
    const totalRange1 = p1High - p1Low;

    if (totalRange1 > 0) {
      const upperShadow1 = p1High - Math.max(p1Open, p1Close);
      const lowerShadow1 = Math.min(p1Open, p1Close) - p1Low;

      // Bullish Hammer: long lower shadow, small body
      if (lowerShadow1 >= totalRange1 * 0.6 && body1 <= totalRange1 * 0.3) {
        return 'Bullish Hammer 🔨';
      }
      // Bearish Shooting Star: long upper shadow, small body
      if (upperShadow1 >= totalRange1 * 0.6 && body1 <= totalRange1 * 0.3) {
        return 'Bearish Shooting Star ☄️';
      }
    }

    // 2. Detect Engulfing
    const body2 = Math.abs(p2Close - p2Open);
    const isP2Bearish = p2Close < p2Open;
    const isP2Bullish = p2Close > p2Open;
    const isP1Bullish = p1Close > p1Open;
    const isP1Bearish = p1Close < p1Open;

    if (body1 > 0 && body2 > 0) {
      // Bullish Engulfing
      if (isP2Bearish && isP1Bullish && p1Close > p2Open && p1Open < p2Close) {
        return 'Bullish Engulfing 📈';
      }
      // Bearish Engulfing
      if (isP2Bullish && isP1Bearish && p1Close < p2Open && p1Open > p2Close) {
        return 'Bearish Engulfing 📉';
      }
    }

    // 3. Detect Doji
    if (totalRange1 > 0 && body1 <= totalRange1 * 0.1) {
      return 'Doji ⏳';
    }

    return null;
  }

  private async getEmaReversalData(
    symbol: string,
    timeframe: string,
    targetEma = 'all',
    emaTrendFilter = false,
  ) {
    try {
      let interval = '4h';
      if (timeframe === '1h') interval = '1h';
      if (timeframe === '1d') interval = '1d';

      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=250`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Failed to fetch klines from Binance: ${res.statusText}`,
        );
      }
      const data = (await res.json()) as unknown[][];
      if (!Array.isArray(data) || data.length < 200) {
        return null;
      }

      const closes = data.map((k) => parseFloat((k as string[])[4]));
      const currentPrice = closes[closes.length - 1];

      const ema34 = this.calculateEMA(closes, 34);
      const ema89 = this.calculateEMA(closes, 89);
      const ema200 = this.calculateEMA(closes, 200);

      const checkTouch = (price: number, ema: number) => {
        const diff = Math.abs(price - ema) / ema;
        return {
          touched: diff <= 0.005,
          diffPercent: parseFloat((diff * 100).toFixed(2)),
        };
      };

      const touch34 = checkTouch(currentPrice, ema34);
      const touch89 = checkTouch(currentPrice, ema89);
      const touch200 = checkTouch(currentPrice, ema200);

      let touchEma: number | null = null;
      let emaName: string | null = null;
      let touchDiff: number | null = null;

      if (touch34.touched && (targetEma === 'all' || targetEma === '34')) {
        touchEma = ema34;
        emaName = '34';
        touchDiff = touch34.diffPercent;
      } else if (
        touch89.touched &&
        (targetEma === 'all' || targetEma === '89')
      ) {
        touchEma = ema89;
        emaName = '89';
        touchDiff = touch89.diffPercent;
      } else if (
        touch200.touched &&
        (targetEma === 'all' || targetEma === '200')
      ) {
        touchEma = ema200;
        emaName = '200';
        touchDiff = touch200.diffPercent;
      }

      const nearestEmaData = () => {
        const diffs = [
          { name: '34', val: ema34, diff: touch34.diffPercent },
          { name: '89', val: ema89, diff: touch89.diffPercent },
          { name: '200', val: ema200, diff: touch200.diffPercent },
        ];
        diffs.sort((a, b) => a.diff - b.diff);
        return diffs[0];
      };

      const nearest = nearestEmaData();
      let pattern = this.detectReversalPattern(data);

      const isBullishTrend = ema34 > ema89 && ema89 > ema200;
      const isBearishTrend = ema34 < ema89 && ema89 < ema200;

      let setupDirection: 'LONG' | 'SHORT' | null = null;
      if (pattern) {
        if (pattern.startsWith('Bullish')) {
          setupDirection = 'LONG';
        } else if (pattern.startsWith('Bearish')) {
          setupDirection = 'SHORT';
        } else if (pattern === 'Doji ⏳') {
          if (isBullishTrend) setupDirection = 'LONG';
          else if (isBearishTrend) setupDirection = 'SHORT';
        }
      }

      if (emaTrendFilter) {
        if (setupDirection === 'LONG' && !isBullishTrend) {
          pattern = null;
          touchEma = null;
        } else if (setupDirection === 'SHORT' && !isBearishTrend) {
          pattern = null;
          touchEma = null;
        } else if (!setupDirection) {
          pattern = null;
          touchEma = null;
        }
      }

      return {
        currentPrice,
        touchEma,
        emaName,
        touchDiff,
        pattern,
        setupDirection,
        nearestEmaName: nearest.name,
        nearestEmaVal: nearest.val,
        nearestEmaDiff: nearest.diff,
        ema34: parseFloat(ema34.toFixed(4)),
        ema89: parseFloat(ema89.toFixed(4)),
        ema200: parseFloat(ema200.toFixed(4)),
        rsi: this.calculateRSI(closes, 14),
      };
    } catch (err) {
      this.logger.error(`Error calculating EMA Reversal for ${symbol}:`, err);
      return null;
    }
  }

  private async runIndependentEmaScan(currentHour: number) {
    const timeframesToScan = new Set<string>();
    for (const config of this.activeUserConfigs) {
      if (config.emaReversalFilter) {
        const tfList = config.emaTimeframe
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (tfList.includes('1h')) timeframesToScan.add('1h');
        if (tfList.includes('4h') && currentHour % 4 === 0)
          timeframesToScan.add('4h');
        if (tfList.includes('1d') && currentHour % 24 === 0)
          timeframesToScan.add('1d');
      }
    }

    if (timeframesToScan.size === 0) {
      this.logger.log(
        'No active users requiring independent EMA scan in this hour.',
      );
      return;
    }

    const symbols = Array.from(this.priceVolumeTracker.keys());
    this.logger.log(
      `Starting independent EMA scan for ${symbols.length} symbols across timeframes: ${Array.from(timeframesToScan).join(', ').toUpperCase()}`,
    );

    const matchPattern = (
      detectedPattern: string,
      targetPattern: string,
    ): boolean => {
      if (targetPattern === 'all') return true;
      const lowerDetected = detectedPattern.toLowerCase();
      if (targetPattern === 'hammer') return lowerDetected.includes('hammer');
      if (targetPattern === 'shooting_star') {
        return (
          lowerDetected.includes('shooting star') ||
          lowerDetected.includes('shooting_star')
        );
      }
      if (targetPattern === 'engulfing')
        return lowerDetected.includes('engulfing');
      if (targetPattern === 'doji') return lowerDetected.includes('doji');
      return false;
    };

    for (const tf of timeframesToScan) {
      for (const symbol of symbols) {
        const trackerState = this.priceVolumeTracker.get(symbol);
        if (!trackerState) continue;

        // Fetch EMA reversal data
        const emaData = await this.getEmaReversalData(symbol, tf, 'all', false);
        if (!emaData || emaData.pattern === null) {
          continue;
        }

        // Evaluate for all users
        for (const config of this.activeUserConfigs) {
          const tfList = config.emaTimeframe
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          if (!config.emaReversalFilter || !tfList.includes(tf)) {
            continue;
          }

          // 1. Min Volume 24h filter
          const cumulativeVolume = trackerState.prevCumulativeVolume;
          if (cumulativeVolume < config.minVolume24h) {
            continue;
          }

          // 2. Specific EMA Target filter / Candle Only evaluation
          let touchEma: number | null = null;
          let emaName: string | null = null;
          let touchDiff: number | null = null;

          if (config.emaTarget === 'none') {
            // Candle only mode: does not require touchEma to be non-null,
            // but we still pass the touch info if it happened to touch!
            touchEma = emaData.touchEma;
            emaName = emaData.emaName;
            touchDiff = emaData.touchDiff;
          } else {
            // Reversal mode: requires a valid touchEma
            if (emaData.touchEma === null) {
              continue;
            }
            if (
              config.emaTarget !== 'all' &&
              emaData.emaName !== config.emaTarget
            ) {
              continue;
            }
            touchEma = emaData.touchEma;
            emaName = emaData.emaName;
            touchDiff = emaData.touchDiff;
          }

          // 3. Specific Candlestick Pattern filter
          if (!matchPattern(emaData.pattern, config.candlePattern)) {
            continue;
          }

          // 4. EMA Trend filter
          if (config.emaTrendFilter) {
            const isBullishTrend =
              emaData.ema34 > emaData.ema89 && emaData.ema89 > emaData.ema200;
            const isBearishTrend =
              emaData.ema34 < emaData.ema89 && emaData.ema89 < emaData.ema200;
            const setupDirection = emaData.setupDirection;

            if (setupDirection === 'LONG' && !isBullishTrend) continue;
            if (setupDirection === 'SHORT' && !isBearishTrend) continue;
            if (!setupDirection) continue;
          }

          // Check cooldown
          const cooldownKey = `${config.userId}:${symbol}:EMA_INDEPENDENT_${tf}`;
          const nowMs = Date.now();
          const cooldownExpiry = this.alertCooldowns.get(cooldownKey) || 0;
          if (nowMs > cooldownExpiry) {
            void this.alertsQueue.add('alert-job', {
              userId: config.userId,
              telegramId: config.telegramId,
              symbol,
              alertType: 'VOLUME_VOLATILITY',
              timeframe: tf === '1d' ? 'H24' : 'H1',
              oldValue: 0,
              newValue: 0,
              percentageChange: 0,
              currentPrice: emaData.currentPrice,
              emaTimeframe: tf,
              touchEma,
              emaName,
              touchDiff,
              pattern: emaData.pattern,
              nearestEmaName: emaData.nearestEmaName,
              nearestEmaVal: emaData.nearestEmaVal,
              nearestEmaDiff: emaData.nearestEmaDiff,
              ema34: emaData.ema34,
              ema89: emaData.ema89,
              ema200: emaData.ema200,
              setupDirection: emaData.setupDirection,
              rsi: emaData.rsi,
            });

            // Set 2 hours cooldown
            this.alertCooldowns.set(cooldownKey, nowMs + 2 * 60 * 60 * 1000);
          }
        }

        // Delay 50ms to prevent rate limiting
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}
