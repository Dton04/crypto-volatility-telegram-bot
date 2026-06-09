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
    if (klines.length < 12) return null;

    const prev1 = klines[klines.length - 2] as string[];
    const prev2 = klines[klines.length - 3] as string[];
    const prev3 = klines[klines.length - 4] as string[];

    const p1Open = parseFloat(prev1[1]);
    const p1High = parseFloat(prev1[2]);
    const p1Low = parseFloat(prev1[3]);
    const p1Close = parseFloat(prev1[4]);

    const p2Open = parseFloat(prev2[1]);
    const p2Close = parseFloat(prev2[4]);

    // Enforce 1.25x volume surge over the 10-candle average
    const p1Vol = parseFloat(prev1[5]);
    let totalVol = 0;
    for (let i = klines.length - 12; i < klines.length - 2; i++) {
      totalVol += parseFloat((klines[i] as string[])[5]);
    }
    const avgVol = totalVol / 10;
    if (p1Vol < avgVol * 1.25) {
      return null;
    }

    // 1. Detect Bullish Morning Star 🌅 (3-candle pattern)
    const p3Open = parseFloat(prev3[1]);
    const p3High = parseFloat(prev3[2]);
    const p3Low = parseFloat(prev3[3]);
    const p3Close = parseFloat(prev3[4]);
    const body3 = Math.abs(p3Close - p3Open);
    const totalRange3 = p3High - p3Low;
    const isP3Bearish = p3Close < p3Open;

    const body2 = Math.abs(p2Close - p2Open);
    const totalRange2 = parseFloat(prev2[2]) - parseFloat(prev2[3]);
    const isP2Bearish = p2Close < p2Open;

    if (
      isP3Bearish &&
      body3 >= totalRange3 * 0.4 &&
      body2 <= totalRange2 * 0.4 &&
      Math.max(p2Open, p2Close) <= Math.min(p3Open, p3Close) * 1.015 &&
      p1Close > p1Open &&
      p1Close >= p3Close + body3 * 0.5
    ) {
      return 'Bullish Morning Star 🌅';
    }

    // 2. Detect Bullish Tweezer Bottom 👥 (2-candle pattern)
    const p2Low = parseFloat(prev2[3]);
    if (
      isP2Bearish &&
      p1Close > p1Open &&
      Math.abs(p1Low - p2Low) / Math.min(p1Low, p2Low) <= 0.0005
    ) {
      return 'Bullish Tweezer Bottom 👥';
    }

    // 3. Detect Bullish Harami 🤰 (2-candle pattern)
    if (
      isP2Bearish &&
      body2 >= totalRange2 * 0.4 &&
      p1Close > p1Open &&
      p1Open > p2Close &&
      p1Close < p2Open
    ) {
      return 'Bullish Harami 🤰';
    }

    // 4. Detect Pinbar (Hammer / Inverted Hammer / Shooting Star)
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

    // 5. Detect Engulfing
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

    // 6. Detect Doji
    if (totalRange1 > 0 && body1 <= totalRange1 * 0.1) {
      return 'Doji ⏳';
    }

    return null;
  }

  checkLTFConfirmation(
    klines: unknown[][],
    direction: 'LONG' | 'SHORT',
  ): {
    confirmed: boolean;
    breakPrice?: number;
    swingPrice?: number;
    lastSwingLow?: number;
    lastSwingHigh?: number;
  } {
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
      const confirmed = lastSwingHigh > 0 && currentPrice > lastSwingHigh;
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
  }

  detectFVG(
    highs: number[],
    lows: number[],
    closes: number[],
  ): {
    hasActiveFvg: boolean;
    fvgType: 'BULLISH' | 'BEARISH' | 'NONE';
    fvgTop: number;
    fvgBottom: number;
    isMitigating: boolean;
  } {
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
            fvgType: 'BULLISH',
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
            fvgType: 'BEARISH',
            fvgTop: l1,
            fvgBottom: h3,
            isMitigating,
          };
        }
      }
    }

    return {
      hasActiveFvg: false,
      fvgType: 'NONE',
      fvgTop: 0,
      fvgBottom: 0,
      isMitigating: false,
    };
  }

  detectLiquiditySweep(
    highs: number[],
    lows: number[],
    closes: number[],
  ): {
    sweepDetected: boolean;
    sweepType: 'SSL' | 'BSL' | 'NONE';
    sweptPrice: number;
  } {
    const n = highs.length;
    if (n < 10) {
      return { sweepDetected: false, sweepType: 'NONE', sweptPrice: 0 };
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
        sweepType: 'SSL',
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
        sweepType: 'BSL',
        sweptPrice: recentSwingHigh,
      };
    }

    return {
      sweepDetected: false,
      sweepType: 'NONE',
      sweptPrice: 0,
    };
  }

  detectOrderBlock(
    highs: number[],
    lows: number[],
    opens: number[],
    closes: number[],
    direction: 'LONG' | 'SHORT',
  ): {
    hasOb: boolean;
    obType: 'BULLISH' | 'BEARISH' | 'NONE';
    obTop: number;
    obBottom: number;
  } {
    const n = highs.length;
    if (n < 15) {
      return { hasOb: false, obType: 'NONE', obTop: 0, obBottom: 0 };
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
          obType: 'BULLISH',
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
          obType: 'BEARISH',
          obTop: highs[obIdx],
          obBottom: Math.min(opens[obIdx], closes[obIdx]),
        };
      }
    }

    return { hasOb: false, obType: 'NONE', obTop: 0, obBottom: 0 };
  }
}
