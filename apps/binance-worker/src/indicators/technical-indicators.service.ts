import { Injectable } from '@nestjs/common';

@Injectable()
export class TechnicalIndicatorsService {
  calculateEMA(prices: number[], period: number): number {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  calculateRSI(closes: number[], period = 14): number {
    const history = this.calculateRSIHistory(closes, period);
    return history[history.length - 1];
  }

  calculateRSIHistory(closes: number[], period = 14): number[] {
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
      rsiHistory[period] = parseFloat((100 - 100 / (1 + rs)).toFixed(2));
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
  }

  detectRSIDivergence(
    highs: number[],
    lows: number[],
    rsiHistory: number[],
    direction: 'LONG' | 'SHORT',
  ): {
    detected: boolean;
    type: 'Regular' | 'None';
    prevRsi: number;
    currRsi: number;
  } {
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
        return { detected: false, type: 'None', prevRsi: 0, currRsi: 0 };

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
        return { detected: false, type: 'None', prevRsi: 0, currRsi: 0 };

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
  }

  checkSupportResistance(
    currentPrice: number,
    highs: number[],
    lows: number[],
  ): {
    isNearCản: boolean;
    type: 'Support' | 'Resistance' | 'None';
    levelPrice: number;
    diffPercent: number;
  } {
    const n = highs.length;
    const levels: { price: number; type: 'Support' | 'Resistance' }[] = [];

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

    return { isNearCản: false, type: 'None', levelPrice: 0, diffPercent: 0 };
  }

  detectReversalPattern(klines: unknown[][]): string | null {
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
}
