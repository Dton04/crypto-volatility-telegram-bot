import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';

interface TestResult {
  currentPrice: number;
  ema34: number;
  ema89: number;
  ema200: number;
  touch34: { touched: boolean; diffPercent: number };
  touch89: { touched: boolean; diffPercent: number };
  touch200: { touched: boolean; diffPercent: number };
  pattern: string | null;
  trend: string;
  rsi: number;
  setupDirection: 'LONG' | 'SHORT' | null;
  isNearSR: boolean;
  srType: 'Support' | 'Resistance' | 'None';
  srPrice: number;
  srDiff: number;
  divDetected: boolean;
  divType: 'Regular' | 'None';
  divPrevRsi: number;
  divCurrRsi: number;
  fundingRate: number | null;
  openInterestValue: number | null;
  patternLow?: number;
  patternHigh?: number;
  ltfConfirmed?: boolean;
  ltfTimeframeName?: string;
  ltfBreakPrice?: number;
  ltfSwingPrice?: number;
  ltfLastSwingLow?: number;
  ltfLastSwingHigh?: number;
  htfFvgType?: 'BULLISH' | 'BEARISH' | 'NONE';
  htfFvgMitigating?: boolean;
  htfSweepType?: 'SSL' | 'BSL' | 'NONE';
  ltfObTop?: number;
  ltfObBottom?: number;
}

@Injectable()
export class TelegramTestService {
  private readonly logger = new Logger(TelegramTestService.name);

  async handleTestCommand(ctx: Context) {
    try {
      const text = (ctx.message as { text?: string }).text?.trim() || '';
      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply(
          '⚠️ Please provide a symbol. Example: `/test BTCUSDT`',
          { parse_mode: 'Markdown' },
        );
        return;
      }
      const symbol = parts[1].toUpperCase();
      await ctx.reply(
        `🔍 Testing EMA and Candlestick setup for *${symbol}* across H1, H4, D1, and W1...`,
        { parse_mode: 'Markdown' },
      );

      const getTestInfo = async (
        tfName: string,
      ): Promise<TestResult | null> => {
        try {
          let interval = '4h';
          if (tfName === '1h') interval = '1h';
          if (tfName === '1d') interval = '1d';
          if (tfName === '1w') interval = '1w';

          const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=250`;
          const res = await fetch(url);
          if (!res.ok) return null;
          const data = (await res.json()) as unknown[][];
          if (!Array.isArray(data) || data.length < 200) return null;

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
          } catch {
            // Safe to ignore
          }

          const checkLTFConfirmation = (
            klines: unknown[][],
            direction: 'LONG' | 'SHORT',
          ) => {
            if (klines.length < 20) return { confirmed: false };

            const n = klines.length;
            const highs = klines.map((k) => parseFloat((k as string[])[2]));
            const lows = klines.map((k) => parseFloat((k as string[])[3]));
            const closes = klines.map((k) => parseFloat((k as string[])[4]));
            const currentPrice = closes[n - 1];

            let lastSwingHigh = 0;
            let lastSwingLow = 0;

            // Find the most recent Swing High (excluding the last 2 candles for stability)
            for (let i = n - 5; i >= 5; i--) {
              const isSwingHigh =
                highs[i] >= highs[i - 1] &&
                highs[i] >= highs[i - 2] &&
                highs[i] >= highs[i + 1] &&
                highs[i] >= highs[i + 2];
              if (isSwingHigh) {
                lastSwingHigh = highs[i];
                break;
              }
            }

            // Find the most recent Swing Low (excluding the last 2 candles for stability)
            for (let i = n - 5; i >= 5; i--) {
              const isSwingLow =
                lows[i] <= lows[i - 1] &&
                lows[i] <= lows[i - 2] &&
                lows[i] <= lows[i + 1] &&
                lows[i] <= lows[i + 2];
              if (isSwingLow) {
                lastSwingLow = lows[i];
                break;
              }
            }

            if (direction === 'LONG') {
              const confirmed =
                lastSwingHigh > 0 && currentPrice > lastSwingHigh;
              return {
                confirmed,
                breakPrice: currentPrice,
                swingPrice: lastSwingHigh,
                lastSwingLow,
                lastSwingHigh,
              };
            } else {
              const confirmed = lastSwingLow > 0 && currentPrice < lastSwingLow;
              return {
                confirmed,
                breakPrice: currentPrice,
                swingPrice: lastSwingLow,
                lastSwingLow,
                lastSwingHigh,
              };
            }
          };

          const calculateEMA = (prices: number[], period: number) => {
            const k = 2 / (period + 1);
            let ema = prices[0];
            for (let i = 1; i < prices.length; i++) {
              ema = prices[i] * k + ema * (1 - k);
            }
            return ema;
          };

          const calculateRSIHistory = (
            closes: number[],
            period = 14,
          ): number[] => {
            const rsiHistory = new Array<number>(closes.length).fill(50);
            if (closes.length <= period) return rsiHistory;

            let gains = 0;
            let losses = 0;

            for (let i = 1; i <= period; i++) {
              const difference = closes[i] - closes[i - 1];
              if (difference > 0) gains += difference;
              else losses -= difference;
            }

            let avgGain = gains / period;
            let avgLoss = losses / period;

            if (avgLoss === 0) rsiHistory[period] = 100;
            else {
              const rs = avgGain / avgLoss;
              rsiHistory[period] = parseFloat(
                (100 - 100 / (1 + rs)).toFixed(2),
              );
            }

            for (let i = period + 1; i < closes.length; i++) {
              const difference = closes[i] - closes[i - 1];
              let currentGain = 0;
              let currentLoss = 0;
              if (difference > 0) currentGain = difference;
              else currentLoss = -difference;

              avgGain = (avgGain * (period - 1) + currentGain) / period;
              avgLoss = (avgLoss * (period - 1) + currentLoss) / period;

              if (avgLoss === 0) rsiHistory[i] = 100;
              else {
                const rs = avgGain / avgLoss;
                rsiHistory[i] = parseFloat((100 - 100 / (1 + rs)).toFixed(2));
              }
            }

            return rsiHistory;
          };

          const detectFVG = (
            highs: number[],
            lows: number[],
            closes: number[],
          ) => {
            const n = highs.length;
            for (let i = n - 3; i >= 0; i--) {
              const h1 = highs[i];
              const l3 = lows[i + 2];

              if (l3 > h1) {
                let mitigated = false;
                for (let j = i + 3; j < n; j++) {
                  if (lows[j] <= h1) {
                    mitigated = true;
                    break;
                  }
                }
                if (!mitigated) {
                  const currentPrice = closes[n - 1];
                  const isMitigating = currentPrice >= h1 && currentPrice <= l3;
                  return {
                    hasActiveFvg: true,
                    fvgType: 'BULLISH' as const,
                    fvgTop: l3,
                    fvgBottom: h1,
                    isMitigating,
                  };
                }
              }

              const l1 = lows[i];
              const h3 = highs[i + 2];
              if (h3 < l1) {
                let mitigated = false;
                for (let j = i + 3; j < n; j++) {
                  if (highs[j] >= l1) {
                    mitigated = true;
                    break;
                  }
                }
                if (!mitigated) {
                  const currentPrice = closes[n - 1];
                  const isMitigating = currentPrice >= h3 && currentPrice <= l1;
                  return {
                    hasActiveFvg: true,
                    fvgType: 'BEARISH' as const,
                    fvgTop: l1,
                    fvgBottom: h3,
                    isMitigating,
                  };
                }
              }
            }

            return {
              hasActiveFvg: false,
              fvgType: 'NONE' as const,
              fvgTop: 0,
              fvgBottom: 0,
              isMitigating: false,
            };
          };

          const detectLiquiditySweep = (
            highs: number[],
            lows: number[],
            closes: number[],
          ) => {
            const n = highs.length;
            if (n < 10) {
              return {
                sweepDetected: false,
                sweepType: 'NONE' as const,
                sweptPrice: 0,
              };
            }

            const currentHigh = highs[n - 1];
            const currentLow = lows[n - 1];
            const currentClose = closes[n - 1];

            let recentSwingHigh = 0;
            let recentSwingLow = 0;

            for (let i = n - 3; i >= Math.max(2, n - 25); i--) {
              const isHigh =
                highs[i] >= highs[i - 1] &&
                highs[i] >= highs[i - 2] &&
                highs[i] >= highs[i + 1] &&
                highs[i] >= highs[i + 2];
              if (isHigh) {
                recentSwingHigh = highs[i];
                break;
              }
            }

            for (let i = n - 3; i >= Math.max(2, n - 25); i--) {
              const isLow =
                lows[i] <= lows[i - 1] &&
                lows[i] <= lows[i - 2] &&
                lows[i] <= lows[i + 1] &&
                lows[i] <= lows[i + 2];
              if (isLow) {
                recentSwingLow = lows[i];
                break;
              }
            }

            if (
              recentSwingLow > 0 &&
              currentLow < recentSwingLow &&
              currentClose > recentSwingLow
            ) {
              return {
                sweepDetected: true,
                sweepType: 'SSL' as const,
                sweptPrice: recentSwingLow,
              };
            }

            if (
              recentSwingHigh > 0 &&
              currentHigh > recentSwingHigh &&
              currentClose < recentSwingHigh
            ) {
              return {
                sweepDetected: true,
                sweepType: 'BSL' as const,
                sweptPrice: recentSwingHigh,
              };
            }

            return {
              sweepDetected: false,
              sweepType: 'NONE' as const,
              sweptPrice: 0,
            };
          };

          const detectOrderBlock = (
            highs: number[],
            lows: number[],
            opens: number[],
            closes: number[],
            direction: 'LONG' | 'SHORT',
          ) => {
            const n = highs.length;
            if (n < 15) {
              return {
                hasOb: false,
                obType: 'NONE' as const,
                obTop: 0,
                obBottom: 0,
              };
            }

            if (direction === 'LONG') {
              let minLow = Infinity;
              let minIdx = -1;
              for (let i = n - 15; i < n - 2; i++) {
                if (lows[i] < minLow) {
                  minLow = lows[i];
                  minIdx = i;
                }
              }
              if (minIdx !== -1) {
                let obIdx = minIdx;
                if (closes[minIdx] > opens[minIdx] && minIdx > 0) {
                  obIdx = minIdx - 1;
                }
                return {
                  hasOb: true,
                  obType: 'BULLISH' as const,
                  obTop: Math.max(opens[obIdx], closes[obIdx]),
                  obBottom: lows[obIdx],
                };
              }
            } else {
              let maxHigh = -Infinity;
              let maxIdx = -1;
              for (let i = n - 15; i < n - 2; i++) {
                if (highs[i] > maxHigh) {
                  maxHigh = highs[i];
                  maxIdx = i;
                }
              }
              if (maxIdx !== -1) {
                let obIdx = maxIdx;
                if (closes[maxIdx] < opens[maxIdx] && maxIdx > 0) {
                  obIdx = maxIdx - 1;
                }
                return {
                  hasOb: true,
                  obType: 'BEARISH' as const,
                  obTop: highs[obIdx],
                  obBottom: Math.min(opens[obIdx], closes[obIdx]),
                };
              }
            }

            return {
              hasOb: false,
              obType: 'NONE' as const,
              obTop: 0,
              obBottom: 0,
            };
          };

          const detectRSIDivergence = (
            highs: number[],
            lows: number[],
            rsiHistory: number[],
            direction: 'LONG' | 'SHORT',
          ): {
            detected: boolean;
            type: 'Regular' | 'None';
            prevRsi: number;
            currRsi: number;
          } => {
            const n = rsiHistory.length;
            const currIdx = n - 2;

            if (direction === 'LONG') {
              let p1 = currIdx;
              for (let i = currIdx - 3; i <= currIdx; i++) {
                if (lows[i] < lows[p1]) {
                  p1 = i;
                }
              }

              if (p1 < 3)
                return {
                  detected: false,
                  type: 'None',
                  prevRsi: 0,
                  currRsi: 0,
                };

              for (let j = currIdx - 6; j >= Math.max(3, currIdx - 50); j--) {
                const isLocalMin =
                  lows[j] <= lows[j - 1] &&
                  lows[j] <= lows[j - 2] &&
                  lows[j] <= lows[j - 3] &&
                  lows[j] <= lows[j + 1] &&
                  lows[j] <= lows[j + 2] &&
                  lows[j] <= lows[j + 3];

                if (isLocalMin) {
                  if (lows[p1] < lows[j] && rsiHistory[p1] > rsiHistory[j]) {
                    return {
                      detected: true,
                      type: 'Regular',
                      prevRsi: rsiHistory[j],
                      currRsi: rsiHistory[p1],
                    };
                  }
                }
              }
            } else if (direction === 'SHORT') {
              let p1 = currIdx;
              for (let i = currIdx - 3; i <= currIdx; i++) {
                if (highs[i] > highs[p1]) {
                  p1 = i;
                }
              }

              if (p1 < 3)
                return {
                  detected: false,
                  type: 'None',
                  prevRsi: 0,
                  currRsi: 0,
                };

              for (let j = currIdx - 6; j >= Math.max(3, currIdx - 50); j--) {
                const isLocalMax =
                  highs[j] >= highs[j - 1] &&
                  highs[j] >= highs[j - 2] &&
                  highs[j] >= highs[j - 3] &&
                  highs[j] >= highs[j + 1] &&
                  highs[j] >= highs[j + 2] &&
                  highs[j] >= highs[j + 3];

                if (isLocalMax) {
                  if (highs[p1] > highs[j] && rsiHistory[p1] < rsiHistory[j]) {
                    return {
                      detected: true,
                      type: 'Regular',
                      prevRsi: rsiHistory[j],
                      currRsi: rsiHistory[p1],
                    };
                  }
                }
              }
            }

            return { detected: false, type: 'None', prevRsi: 0, currRsi: 0 };
          };

          const checkSupportResistance = (
            currentPrice: number,
            highs: number[],
            lows: number[],
          ): {
            isNearCản: boolean;
            type: 'Support' | 'Resistance' | 'None';
            levelPrice: number;
            diffPercent: number;
          } => {
            const n = highs.length;
            const levels: { price: number; type: 'Support' | 'Resistance' }[] =
              [];

            for (let i = 10; i < n - 5; i++) {
              const isLow =
                lows[i] <= lows[i - 1] &&
                lows[i] <= lows[i - 2] &&
                lows[i] <= lows[i - 3] &&
                lows[i] <= lows[i - 4] &&
                lows[i] <= lows[i - 5] &&
                lows[i] <= lows[i + 1] &&
                lows[i] <= lows[i + 2] &&
                lows[i] <= lows[i + 3] &&
                lows[i] <= lows[i + 4] &&
                lows[i] <= lows[i + 5];

              if (isLow) {
                levels.push({ price: lows[i], type: 'Support' });
              }

              const isHigh =
                highs[i] >= highs[i - 1] &&
                highs[i] >= highs[i - 2] &&
                highs[i] >= highs[i - 3] &&
                highs[i] >= highs[i - 4] &&
                highs[i] >= highs[i - 5] &&
                highs[i] >= highs[i + 1] &&
                highs[i] >= highs[i + 2] &&
                highs[i] >= highs[i + 3] &&
                highs[i] >= highs[i + 4] &&
                highs[i] >= highs[i + 5];

              if (isHigh) {
                levels.push({ price: highs[i], type: 'Resistance' });
              }
            }

            let closestLevel = null;
            let minDiff = Infinity;

            for (const lvl of levels) {
              const diff = Math.abs(currentPrice - lvl.price) / lvl.price;
              if (diff < minDiff) {
                minDiff = diff;
                closestLevel = lvl;
              }
            }

            if (closestLevel && minDiff <= 0.015) {
              return {
                isNearCản: true,
                type: closestLevel.type,
                levelPrice: parseFloat(closestLevel.price.toFixed(4)),
                diffPercent: parseFloat((minDiff * 100).toFixed(2)),
              };
            }

            return {
              isNearCản: false,
              type: 'None',
              levelPrice: 0,
              diffPercent: 0,
            };
          };

          const ema34 = calculateEMA(closes, 34);
          const ema89 = calculateEMA(closes, 89);
          const ema200 = calculateEMA(closes, 200);

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

          let pattern = null;
          let patternLow = 0;
          let patternHigh = 0;

          if (data.length >= 3) {
            const prev1 = data[data.length - 2] as string[];
            const prev2 = data[data.length - 3] as string[];
            const p1Open = parseFloat(prev1[1]);
            const p1High = parseFloat(prev1[2]);
            const p1Low = parseFloat(prev1[3]);
            const p1Close = parseFloat(prev1[4]);
            const p2Open = parseFloat(prev2[1]);
            const p2High = parseFloat(prev2[2]);
            const p2Low = parseFloat(prev2[3]);
            const p2Close = parseFloat(prev2[4]);

            const body1 = Math.abs(p1Close - p1Open);
            const totalRange1 = p1High - p1Low;
            const upperShadow1 = p1High - Math.max(p1Open, p1Close);
            const lowerShadow1 = Math.min(p1Open, p1Close) - p1Low;

            if (totalRange1 > 0) {
              if (
                lowerShadow1 >= totalRange1 * 0.6 &&
                body1 <= totalRange1 * 0.3
              ) {
                pattern = 'Bullish Hammer 🔨';
                patternLow = p1Low;
                patternHigh = p1High;
              } else if (
                upperShadow1 >= totalRange1 * 0.6 &&
                body1 <= totalRange1 * 0.3
              ) {
                pattern = 'Bearish Shooting Star ☄️';
                patternLow = p1Low;
                patternHigh = p1High;
              }
            }

            if (!pattern) {
              const body2 = Math.abs(p2Close - p2Open);
              if (body1 > 0 && body2 > 0) {
                if (
                  p2Close < p2Open &&
                  p1Close > p1Open &&
                  p1Close > p2Open &&
                  p1Open < p2Close
                ) {
                  pattern = 'Bullish Engulfing 📈';
                  patternLow = Math.min(p1Low, p2Low);
                  patternHigh = Math.max(p1High, p2High);
                } else if (
                  p2Close > p2Open &&
                  p1Close < p1Open &&
                  p1Close < p2Open &&
                  p1Open > p2Close
                ) {
                  pattern = 'Bearish Engulfing 📉';
                  patternLow = Math.min(p1Low, p2Low);
                  patternHigh = Math.max(p1High, p2High);
                }
              }
            }

            if (!pattern && totalRange1 > 0 && body1 <= totalRange1 * 0.1) {
              pattern = 'Doji ⏳';
              patternLow = p1Low;
              patternHigh = p1High;
            }
          }

          const isBullishTrend = ema34 > ema89 && ema89 > ema200;
          const isBearishTrend = ema34 < ema89 && ema89 < ema200;
          let trend = 'No clear trend';
          if (isBullishTrend) trend = 'Bullish 🟢';
          if (isBearishTrend) trend = 'Bearish 🔴';

          const rsiHistory = calculateRSIHistory(closes, 14);
          const rsi = rsiHistory[rsiHistory.length - 1];

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

          const srData = checkSupportResistance(currentPrice, highs, lows);
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
            divData = detectRSIDivergence(
              highs,
              lows,
              rsiHistory,
              setupDirection,
            );
          }

          const htfFvg = detectFVG(highs, lows, closes);
          const htfSweep = detectLiquiditySweep(highs, lows, closes);

          let ltfConfirmed = false;
          let ltfTimeframeName = '';
          let ltfBreakPrice = 0;
          let ltfSwingPrice = 0;
          let ltfLastSwingLow = 0;
          let ltfLastSwingHigh = 0;
          let ltfObTop = 0;
          let ltfObBottom = 0;

          if (setupDirection) {
            let ltfInterval = '';
            if (tfName === '1d') {
              ltfInterval = '1h';
              ltfTimeframeName = 'H1';
            } else if (tfName === '4h') {
              ltfInterval = '15m';
              ltfTimeframeName = 'M15';
            } else if (tfName === '1h') {
              ltfInterval = '5m';
              ltfTimeframeName = 'M5';
            } else if (tfName === '1w') {
              ltfInterval = '4h';
              ltfTimeframeName = 'H4';
            }

            if (ltfInterval) {
              try {
                const ltfUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${ltfInterval}&limit=100`;
                const ltfRes = await fetch(ltfUrl);
                if (ltfRes.ok) {
                  const ltfData = (await ltfRes.json()) as unknown[][];
                  if (Array.isArray(ltfData) && ltfData.length >= 20) {
                    const conf = checkLTFConfirmation(ltfData, setupDirection);
                    ltfConfirmed = conf.confirmed;
                    ltfBreakPrice = conf.breakPrice || 0;
                    ltfSwingPrice = conf.swingPrice || 0;
                    ltfLastSwingLow = conf.lastSwingLow || 0;
                    ltfLastSwingHigh = conf.lastSwingHigh || 0;

                    const ltfOpens = ltfData.map((k) =>
                      parseFloat((k as string[])[1]),
                    );
                    const ltfHighs = ltfData.map((k) =>
                      parseFloat((k as string[])[2]),
                    );
                    const ltfLows = ltfData.map((k) =>
                      parseFloat((k as string[])[3]),
                    );
                    const ltfCloses = ltfData.map((k) =>
                      parseFloat((k as string[])[4]),
                    );
                    const ob = detectOrderBlock(
                      ltfHighs,
                      ltfLows,
                      ltfOpens,
                      ltfCloses,
                      setupDirection,
                    );
                    if (ob.hasOb) {
                      ltfObTop = ob.obTop;
                      ltfObBottom = ob.obBottom;
                    }
                  }
                }
              } catch {
                // Ignore
              }
            }
          }

          return {
            currentPrice,
            ema34,
            ema89,
            ema200,
            touch34,
            touch89,
            touch200,
            pattern,
            trend,
            rsi,
            setupDirection,
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
            patternLow,
            patternHigh,
            ltfConfirmed,
            ltfTimeframeName,
            ltfBreakPrice,
            ltfSwingPrice,
            ltfLastSwingLow,
            ltfLastSwingHigh,
            htfFvgType: htfFvg.fvgType,
            htfFvgMitigating: htfFvg.isMitigating,
            htfSweepType: htfSweep.sweepType,
            ltfObTop,
            ltfObBottom,
          };
        } catch (e) {
          this.logger.error(`Error in getTestInfo for ${tfName}:`, e);
          return null;
        }
      };

      const res1h = await getTestInfo('1h');
      const res4h = await getTestInfo('4h');
      const res1d = await getTestInfo('1d');
      const res1w = await getTestInfo('1w');

      if (!res1h || !res4h || !res1d || !res1w) {
        await ctx.reply(
          '⚠️ Error fetching data from Binance. Please verify the symbol is correct (e.g. BTCUSDT).',
        );
        return;
      }

      const formatRes = (tfName: string, res: TestResult) => {
        const touchStrs = [];
        if (res.touch34.touched)
          touchStrs.push(`EMA 34 (${res.touch34.diffPercent}%)`);
        if (res.touch89.touched)
          touchStrs.push(`EMA 89 (${res.touch89.diffPercent}%)`);
        if (res.touch200.touched)
          touchStrs.push(`EMA 200 (${res.touch200.diffPercent}%)`);

        const rsiStatus =
          res.rsi <= 30
            ? 'Oversold 🟢 (Quá Bán)'
            : res.rsi >= 70
              ? 'Overbought 🔴 (Quá Mua)'
              : 'Neutral ⚪';

        const srEmoji = res.srType === 'Support' ? '🛡️' : '🧱';
        const srLine =
          res.isNearSR && res.srType !== 'None'
            ? `  • Zone: ${srEmoji} Near *${res.srType}* at \`$${res.srPrice}\` (Diff: \`${res.srDiff}%\`)\n`
            : '';

        const divEmoji = res.setupDirection === 'LONG' ? '🟢 📈' : '🔴 📉';
        const divLine = res.divDetected
          ? `  • Divergence: ${divEmoji} *RSI ${res.setupDirection} Divergence* (Prev: \`${res.divPrevRsi}\` -> Curr: \`${res.divCurrRsi}\`) 🔥\n`
          : '';

        const formatOI = (val?: number | null) => {
          if (val === undefined || val === null) return 'N/A';
          if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B USDT`;
          if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M USDT`;
          return `${(val / 1e3).toFixed(2)}K USDT`;
        };

        const formatFunding = (rate?: number | null) => {
          if (rate === undefined || rate === null) return 'N/A';
          const formatted = rate.toFixed(4) + '%';
          if (rate < 0) {
            return `\`${formatted}\` 🟢 (Short Squeeze)`;
          }
          return `\`${formatted}\` 🔴`;
        };

        const futuresLine =
          res.fundingRate !== null
            ? `  • Funding Rate: ${formatFunding(res.fundingRate)}\n  • Open Interest: \`${formatOI(res.openInterestValue)}\` 📊\n`
            : '';

        let touchEma: number | null = null;
        if (res.touch34.touched) touchEma = res.ema34;
        else if (res.touch89.touched) touchEma = res.ema89;
        else if (res.touch200.touched) touchEma = res.ema200;

        let slVal = 0;
        let tp1Val = 0;
        let tp2Val = 0;
        const entryPrice = res.currentPrice;

        if (res.setupDirection === 'LONG') {
          if (res.patternLow && res.patternLow > 0) {
            slVal = res.patternLow * 0.992; // 0.8% below pattern low
          } else if (res.isNearSR && res.srType === 'Support' && res.srPrice) {
            slVal = res.srPrice * 0.992;
          } else if (touchEma) {
            slVal = touchEma * 0.99;
          } else {
            slVal = entryPrice * 0.985;
          }
          const risk = entryPrice - slVal;
          tp1Val = entryPrice + risk * 1.5;
          tp2Val = entryPrice + risk * 2.5;
        } else if (res.setupDirection === 'SHORT') {
          if (res.patternHigh && res.patternHigh > 0) {
            slVal = res.patternHigh * 1.008; // 0.8% above pattern high
          } else if (
            res.isNearSR &&
            res.srType === 'Resistance' &&
            res.srPrice
          ) {
            slVal = res.srPrice * 1.008;
          } else if (touchEma) {
            slVal = touchEma * 1.01;
          } else {
            slVal = entryPrice * 1.015;
          }
          const risk = slVal - entryPrice;
          tp1Val = entryPrice - risk * 1.5;
          tp2Val = entryPrice - risk * 2.5;
        }

        const formatVal = (val: number) =>
          val.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 4,
          });

        // Calculate safe/SMC option
        let ltfTextLine = '';
        if (res.setupDirection && entryPrice > 0 && res.ltfTimeframeName) {
          let smcTriggerVal = 0;
          let smcSlVal = 0;
          let smcTp1Val = 0;
          let smcTp2Val = 0;

          if (res.setupDirection === 'LONG') {
            smcTriggerVal =
              res.ltfLastSwingHigh || res.ltfSwingPrice || entryPrice;
            smcSlVal = res.ltfLastSwingLow
              ? res.ltfLastSwingLow * 0.996
              : entryPrice * 0.992;
            const smcRisk = entryPrice - smcSlVal;
            smcTp1Val = entryPrice + smcRisk * 1.5;
            smcTp2Val = entryPrice + smcRisk * 2.5;
          } else {
            smcTriggerVal =
              res.ltfLastSwingLow || res.ltfSwingPrice || entryPrice;
            smcSlVal = res.ltfLastSwingHigh
              ? res.ltfLastSwingHigh * 1.004
              : entryPrice * 1.008;
            const smcRisk = smcSlVal - entryPrice;
            smcTp1Val = entryPrice - smcRisk * 1.5;
            smcTp2Val = entryPrice - smcRisk * 2.5;
          }

          const statusEmoji = res.ltfConfirmed
            ? '🟢 (CONFIRMED)'
            : '⏳ (PENDING)';

          let obLine = '';
          if (res.ltfObTop && res.ltfObBottom) {
            obLine = `      - Limit Entry (Order Block): \`$${formatVal(res.ltfObBottom)} - $${formatVal(res.ltfObTop)}\` 🧱\n`;
          }

          ltfTextLine =
            `    - 🛡️ *Option 2: SMC & ICT Confirmation*\n` +
            `      - Status: ${statusEmoji}\n` +
            `      - Wait for \`${res.ltfTimeframeName}\` ${res.setupDirection === 'LONG' ? 'Bullish' : 'Bearish'} CHoCH\n` +
            `      - Trigger: ${res.setupDirection === 'LONG' ? 'Close above Swing High' : 'Close below Swing Low'} \`$${formatVal(smcTriggerVal)}\`\n` +
            (obLine ? obLine : '') +
            `      - Estimated SL: \`$${formatVal(smcSlVal)}\` (Risk: \`${Math.abs(((entryPrice - smcSlVal) / entryPrice) * 100).toFixed(2)}%\`)\n` +
            `      - Estimated TP1 / TP2: \`$${formatVal(smcTp1Val)}\` / \`$${formatVal(smcTp2Val)}\` (RR 1:1.5 / 1:2.5)\n`;
        }

        const tradingIdeaLine =
          res.setupDirection && entryPrice > 0
            ? `  • *Trading Signals (Futures)*:\n` +
              `    - 🚀 *Option 1: Direct Entry (Aggressive)*\n` +
              `      - Entry: \`$${formatVal(entryPrice)}\` (Current)\n` +
              `      - SL: \`$${formatVal(slVal)}\` (Risk: \`${Math.abs(((entryPrice - slVal) / entryPrice) * 100).toFixed(2)}%\`)\n` +
              `      - TP1 / TP2: \`$${formatVal(tp1Val)}\` / \`$${formatVal(tp2Val)}\` (RR 1:1.5 / 1:2.5)\n` +
              (ltfTextLine ? ltfTextLine : '')
            : '';

        let ictStatusLines = '';
        if (res.htfSweepType && res.htfSweepType !== 'NONE') {
          const isGoodSweep =
            (res.setupDirection === 'LONG' && res.htfSweepType === 'SSL') ||
            (res.setupDirection === 'SHORT' && res.htfSweepType === 'BSL');
          ictStatusLines += `  • Liquidity Sweep: \`${res.htfSweepType} Swept\` ${isGoodSweep ? '🟢 (Săn thanh khoản)' : '⚪️'}\n`;
        }
        if (res.htfFvgType && res.htfFvgType !== 'NONE') {
          const isGoodFvg =
            (res.setupDirection === 'LONG' && res.htfFvgType === 'BULLISH') ||
            (res.setupDirection === 'SHORT' && res.htfFvgType === 'BEARISH');
          if (isGoodFvg) {
            ictStatusLines += `  • Imbalance (FVG): \`${res.htfFvgType} FVG\` ${res.htfFvgMitigating ? '🔥 (Mitigating)' : '🟢'}\n`;
          }
        }

        return (
          `*${tfName}*:\n` +
          `  • Price: \`$${res.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\`\n` +
          `  • Trend: ${res.trend}\n` +
          `  • Pattern: \`${res.pattern || 'None'}\`\n` +
          `  • RSI: \`${res.rsi.toFixed(2)}\` (${rsiStatus})\n` +
          srLine +
          divLine +
          futuresLine +
          ictStatusLines +
          tradingIdeaLine +
          `  • EMA Touches: ${touchStrs.join(', ') || 'None'}\n` +
          `  • EMAs: 34: \`$${res.ema34.toLocaleString(undefined, { maximumFractionDigits: 4 })}\` | 89: \`$${res.ema89.toLocaleString(undefined, { maximumFractionDigits: 4 })}\` | 200: \`$${res.ema200.toLocaleString(undefined, { maximumFractionDigits: 4 })}\`\n`
        );
      };

      const replyMsg =
        `📊 *Setup Analysis for ${symbol}*\n\n` +
        formatRes('1 HOUR (H1)', res1h) +
        `\n` +
        formatRes('4 HOURS (H4)', res4h) +
        `\n` +
        formatRes('1 DAY (D1)', res1d) +
        `\n` +
        formatRes('1 WEEK (W1)', res1w);

      await ctx.reply(replyMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      this.logger.error('Error handling /test command:', err);
      await ctx.reply('⚠️ Error running test check.');
    }
  }
}
