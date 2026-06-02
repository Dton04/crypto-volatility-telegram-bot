import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TechnicalIndicatorsService } from '../indicators/technical-indicators.service';

export interface PriceVolumeState {
  prices: number[];
  volumes: number[];
  dailyVolumes: number[];
  lastUpdatedMin: number;
  lastUpdatedHour: number;
  prevCumulativeVolume: number;
}

export interface UserConfigCache {
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
export class KlineScannerService {
  private readonly logger = new Logger(KlineScannerService.name);

  constructor(
    private readonly indicatorsService: TechnicalIndicatorsService,
    @InjectQueue('telegram-alerts') private readonly alertsQueue: Queue,
  ) {}

  async getEmaReversalData(
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

      const highs = data.map((k) => parseFloat((k as string[])[2]));
      const lows = data.map((k) => parseFloat((k as string[])[3]));
      const closes = data.map((k) => parseFloat((k as string[])[4]));
      const currentPrice = closes[closes.length - 1];

      let fundingRate: number | null = null;
      let openInterestValue: number | null = null;

      try {
        const [premiumRes, oiRes] = await Promise.all([
          fetch(
            `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,
          ),
          fetch(
            `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`,
          ),
        ]);

        if (premiumRes.ok) {
          const premiumData = (await premiumRes.json()) as {
            lastFundingRate?: string;
          };
          if (premiumData && premiumData.lastFundingRate) {
            fundingRate = parseFloat(premiumData.lastFundingRate) * 100;
          }
        }

        if (oiRes.ok) {
          const oiData = (await oiRes.json()) as { openInterest?: string };
          if (oiData && oiData.openInterest) {
            const rawOi = parseFloat(oiData.openInterest);
            openInterestValue = rawOi * currentPrice;
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Failed to fetch Futures info for ${symbol}: ${errMsg}`,
        );
      }

      const rsiHistory = this.indicatorsService.calculateRSIHistory(closes, 14);

      const ema34 = this.indicatorsService.calculateEMA(closes, 34);
      const ema89 = this.indicatorsService.calculateEMA(closes, 89);
      const ema200 = this.indicatorsService.calculateEMA(closes, 200);

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
      let pattern = this.indicatorsService.detectReversalPattern(data);

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

      const srData = this.indicatorsService.checkSupportResistance(
        currentPrice,
        highs,
        lows,
      );

      let divData: {
        detected: boolean;
        type: 'Regular' | 'None';
        prevRsi: number;
        currRsi: number;
      } = {
        detected: false,
        type: 'None',
        prevRsi: 0,
        currRsi: 0,
      };
      if (setupDirection) {
        divData = this.indicatorsService.detectRSIDivergence(
          highs,
          lows,
          rsiHistory,
          setupDirection,
        );
      }

      let patternLow = 0;
      let patternHigh = 0;
      if (pattern && data.length >= 3) {
        const prev1 = data[data.length - 2] as string[];
        const prev2 = data[data.length - 3] as string[];
        const p1High = parseFloat(prev1[2]);
        const p1Low = parseFloat(prev1[3]);
        const p2High = parseFloat(prev2[2]);
        const p2Low = parseFloat(prev2[3]);

        if (
          pattern.startsWith('Bullish Engulfing') ||
          pattern.startsWith('Bearish Engulfing')
        ) {
          patternLow = Math.min(p1Low, p2Low);
          patternHigh = Math.max(p1High, p2High);
        } else {
          patternLow = p1Low;
          patternHigh = p1High;
        }
      }

      let ltfConfirmed = false;
      let ltfTimeframeName = '';
      let ltfBreakPrice = 0;
      let ltfSwingPrice = 0;
      let ltfLastSwingLow = 0;
      let ltfLastSwingHigh = 0;

      if (setupDirection) {
        let ltfInterval = '';
        if (timeframe === '1d') {
          ltfInterval = '1h';
          ltfTimeframeName = 'H1';
        } else if (timeframe === '4h') {
          ltfInterval = '15m';
          ltfTimeframeName = 'M15';
        } else if (timeframe === '1h') {
          ltfInterval = '5m';
          ltfTimeframeName = 'M5';
        }

        if (ltfInterval) {
          try {
            const ltfUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${ltfInterval}&limit=100`;
            const ltfRes = await fetch(ltfUrl);
            if (ltfRes.ok) {
              const ltfData = (await ltfRes.json()) as unknown[][];
              if (Array.isArray(ltfData) && ltfData.length >= 20) {
                const conf = this.indicatorsService.checkLTFConfirmation(
                  ltfData,
                  setupDirection,
                );
                ltfConfirmed = conf.confirmed;
                ltfBreakPrice = conf.breakPrice || 0;
                ltfSwingPrice = conf.swingPrice || 0;
                ltfLastSwingLow = conf.lastSwingLow || 0;
                ltfLastSwingHigh = conf.lastSwingHigh || 0;
              }
            }
          } catch (err) {
            this.logger.debug(
              `Failed to fetch LTF confirmation klines for ${symbol}: ${err}`,
            );
          }
        }
      }

      return {
        currentPrice,
        touchEma,
        emaName,
        touchDiff,
        pattern,
        patternLow,
        patternHigh,
        setupDirection,
        ltfConfirmed,
        ltfTimeframeName,
        ltfBreakPrice,
        ltfSwingPrice,
        ltfLastSwingLow,
        ltfLastSwingHigh,
        nearestEmaName: nearest.name,
        nearestEmaVal: nearest.val,
        nearestEmaDiff: nearest.diff,
        ema34: parseFloat(ema34.toFixed(4)),
        ema89: parseFloat(ema89.toFixed(4)),
        ema200: parseFloat(ema200.toFixed(4)),
        rsi: rsiHistory[rsiHistory.length - 1],
        isNearSR: srData.isNearCản,
        srType: srData.type,
        srPrice: srData.levelPrice,
        srDiff: srData.diffPercent,
        divDetected: divData.detected,
        divType: divData.type,
        divPrevRsi: divData.prevRsi,
        divCurrRsi: divData.currRsi,
        fundingRate,
        openInterestValue,
      };
    } catch (err) {
      this.logger.error(`Error calculating EMA Reversal for ${symbol}:`, err);
      return null;
    }
  }

  async evaluateDailyAlerts(
    symbol: string,
    currentPrice: number,
    cumulativeVolume: number,
    state: PriceVolumeState,
    activeUserConfigs: UserConfigCache[],
    alertCooldowns: Map<string, number>,
  ) {
    const volume24hCurr = state.dailyVolumes[state.dailyVolumes.length - 1];
    const volume24hAgo = state.dailyVolumes[0];

    let volumeChange24h = 0;
    if (volume24hAgo > 0) {
      volumeChange24h = ((volume24hCurr - volume24hAgo) / volume24hAgo) * 100;
    }

    const now = Date.now();

    for (const config of activeUserConfigs) {
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
        const cooldownExpiry = alertCooldowns.get(cooldownKey) || 0;

        if (now > cooldownExpiry) {
          const timeframes = config.emaTimeframe
            .split(',')
            .map((t) => t.trim());
          const primaryTf = timeframes[0] || '4h';

          const emaData = await this.getEmaReversalData(
            symbol,
            primaryTf,
            'all',
            false,
          );

          const detectedPatterns = [];
          for (const tf of timeframes) {
            const data = await this.getEmaReversalData(
              symbol,
              tf,
              'all',
              false,
            );
            if (data && data.pattern) {
              detectedPatterns.push({
                tf: tf.toUpperCase(),
                pattern: data.pattern,
                direction: data.setupDirection,
              });
            }
          }

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
            detectedPatterns,
            isNearSR: emaData?.isNearSR,
            srType: emaData?.srType,
            srPrice: emaData?.srPrice,
            srDiff: emaData?.srDiff,
            divDetected: emaData?.divDetected,
            divType: emaData?.divType,
            divPrevRsi: emaData?.divPrevRsi,
            divCurrRsi: emaData?.divCurrRsi,
            fundingRate: emaData?.fundingRate,
            openInterestValue: emaData?.openInterestValue,
            patternLow: emaData?.patternLow || 0,
            patternHigh: emaData?.patternHigh || 0,
            ltfConfirmed: emaData?.ltfConfirmed || false,
            ltfTimeframeName: emaData?.ltfTimeframeName || '',
            ltfBreakPrice: emaData?.ltfBreakPrice || 0,
            ltfSwingPrice: emaData?.ltfSwingPrice || 0,
            ltfLastSwingLow: emaData?.ltfLastSwingLow || 0,
            ltfLastSwingHigh: emaData?.ltfLastSwingHigh || 0,
          });

          // Set 1 hour cooldown for daily alerts
          alertCooldowns.set(cooldownKey, now + 60 * 60 * 1000);
        }
      }
    }
  }

  async runIndependentEmaScan(
    currentHour: number,
    symbols: string[],
    activeUserConfigs: UserConfigCache[],
    alertCooldowns: Map<string, number>,
    trackerStateMap: Map<string, PriceVolumeState>,
  ) {
    const timeframesToScan = new Set<string>();
    for (const config of activeUserConfigs) {
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
        const trackerState = trackerStateMap.get(symbol);
        if (!trackerState) continue;

        // Fetch EMA reversal data
        const emaData = await this.getEmaReversalData(symbol, tf, 'all', false);
        if (!emaData || emaData.pattern === null) {
          continue;
        }

        // Evaluate for all users
        for (const config of activeUserConfigs) {
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

          const targetEmas = config.emaTarget
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);

          if (targetEmas.includes('none')) {
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
              !targetEmas.includes('all') &&
              !targetEmas.includes(emaData.emaName || '')
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
          const cooldownExpiry = alertCooldowns.get(cooldownKey) || 0;
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
              isNearSR: emaData.isNearSR,
              srType: emaData.srType,
              srPrice: emaData.srPrice,
              srDiff: emaData.srDiff,
              divDetected: emaData.divDetected,
              divType: emaData.divType,
              divPrevRsi: emaData.divPrevRsi,
              divCurrRsi: emaData.divCurrRsi,
              fundingRate: emaData.fundingRate,
              openInterestValue: emaData.openInterestValue,
              patternLow: emaData.patternLow || 0,
              patternHigh: emaData.patternHigh || 0,
              ltfConfirmed: emaData.ltfConfirmed || false,
              ltfTimeframeName: emaData.ltfTimeframeName || '',
              ltfBreakPrice: emaData.ltfBreakPrice || 0,
              ltfSwingPrice: emaData.ltfSwingPrice || 0,
              ltfLastSwingLow: emaData.ltfLastSwingLow || 0,
              ltfLastSwingHigh: emaData.ltfLastSwingHigh || 0,
            });

            // Set 2 hours cooldown
            alertCooldowns.set(cooldownKey, nowMs + 2 * 60 * 60 * 1000);
          }
        }
      }
      // Delay 50ms to prevent rate limiting
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
