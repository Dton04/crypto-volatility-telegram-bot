import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context, Markup } from 'telegraf';
import { DatabaseService } from 'app/database';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  public bot: Telegraf;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {}

  onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.error(
        'TELEGRAM_BOT_TOKEN is not defined in environment! Bot will not start.',
      );
      return;
    }

    this.bot = new Telegraf(token);
    this.setupHandlers();

    // Launch Telegraf Bot via Long Polling
    this.bot
      .launch()
      .then(() => {
        this.logger.log('Telegram Bot successfully launched.');
      })
      .catch((err) => {
        this.logger.error('Failed to launch Telegram Bot:', err);
      });
  }

  onModuleDestroy() {
    if (this.bot) {
      this.bot.stop('SIGINT');
      this.logger.log('Telegram Bot stopped.');
    }
  }

  private setupHandlers() {
    // /start command
    this.bot.command('start', async (ctx) => {
      try {
        const from = ctx.from;
        if (!from) return;

        const telegramId = from.id.toString();
        const username = from.username || null;
        const firstName = from.first_name || '';
        const lastName = from.last_name || '';

        // Upsert user in DB
        let user = await this.databaseService.user.findUnique({
          where: { telegramId },
        });

        if (!user) {
          user = await this.databaseService.user.create({
            data: {
              telegramId,
              username,
              firstName,
              lastName,
              alertsConfig: {
                create: {
                  volumeThreshold24h: 300.0,
                  isActive: true,
                  emaReversalFilter: false,
                  emaTimeframe: '4h',
                  minVolume24h: 1000000.0,
                  emaTrendFilter: false,
                  emaTarget: 'all',
                  candlePattern: 'all',
                },
              },
            },
          });
        }

        await ctx.reply(
          `👋 Welcome *${firstName}* to *Real-time Crypto Volatility Telegram Bot*!\n\n` +
            `I will monitor all Binance pairs 24/7 and notify you immediately of sudden price/volume spikes.\n\n` +
            `⚙️ Use /settings to customize alert thresholds.`,
          { parse_mode: 'Markdown' },
        );
      } catch (error) {
        this.logger.error('Error handling /start command:', error);
        await ctx.reply(
          '⚠️ An error occurred while initializing your profile. Please try again.',
        );
      }
    });

    // /settings command
    this.bot.command('settings', async (ctx) => {
      try {
        const telegramId = ctx.from?.id.toString();
        if (!telegramId) return;

        const user = await this.getOrCreateUser(telegramId, ctx);
        if (!user) return;

        const config = await this.databaseService.alertsConfig.findUnique({
          where: { userId: user.id },
        });

        if (!config) return;

        const { text, keyboard } = this.renderSettingsMenu(config);
        await ctx.reply(text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard.reply_markup,
        });
      } catch (error) {
        this.logger.error('Error handling /settings command:', error);
        await ctx.reply('⚠️ Error loading settings.');
      }
    });

    // /test <symbol> command
    this.bot.command('test', async (ctx) => {
      try {
        const text = ctx.message.text.trim();
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
          `🔍 Testing EMA and Candlestick setup for *${symbol}* across H1, H4, and D1...`,
          { parse_mode: 'Markdown' },
        );

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
        }

        const getTestInfo = async (tf: string): Promise<TestResult | null> => {
          let interval = '4h';
          if (tf === '1h') interval = '1h';
          if (tf === '1d') interval = '1d';

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
          if (data.length >= 3) {
            const prev1 = data[data.length - 2] as string[];
            const prev2 = data[data.length - 3] as string[];
            const p1Open = parseFloat(prev1[1]);
            const p1High = parseFloat(prev1[2]);
            const p1Low = parseFloat(prev1[3]);
            const p1Close = parseFloat(prev1[4]);
            const p2Open = parseFloat(prev2[1]);
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
              } else if (
                upperShadow1 >= totalRange1 * 0.6 &&
                body1 <= totalRange1 * 0.3
              ) {
                pattern = 'Bearish Shooting Star ☄️';
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
                } else if (
                  p2Close > p2Open &&
                  p1Close < p1Open &&
                  p1Close < p2Open &&
                  p1Open > p2Close
                ) {
                  pattern = 'Bearish Engulfing 📉';
                }
              }
            }

            if (!pattern && totalRange1 > 0 && body1 <= totalRange1 * 0.1) {
              pattern = 'Doji ⏳';
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
          };
        };

        const res1h = await getTestInfo('1h');
        const res4h = await getTestInfo('4h');
        const res1d = await getTestInfo('1d');

        if (!res1h || !res4h || !res1d) {
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

          return (
            `*${tfName}*:\n` +
            `  • Price: \`$${res.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\`\n` +
            `  • Trend: ${res.trend}\n` +
            `  • Pattern: \`${res.pattern || 'None'}\`\n` +
            `  • RSI: \`${res.rsi.toFixed(2)}\` (${rsiStatus})\n` +
            srLine +
            divLine +
            futuresLine +
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
          formatRes('1 DAY (D1)', res1d);

        await ctx.reply(replyMsg, { parse_mode: 'Markdown' });
      } catch (err) {
        this.logger.error('Error handling /test command:', err);
        await ctx.reply('⚠️ Error running test check.');
      }
    });

    // Callback Query Handlers (Button clicks)
    this.bot.on('callback_query', async (ctx) => {
      try {
        if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
          return;
        }
        const callbackData = ctx.callbackQuery.data;
        const telegramId = ctx.from.id.toString();

        const user = await this.databaseService.user.findUnique({
          where: { telegramId },
          include: { alertsConfig: true },
        });

        if (!user || !user.alertsConfig) {
          await ctx.answerCbQuery('User not found. Run /start first.');
          return;
        }

        const config = user.alertsConfig;

        if (callbackData === 'toggle_active') {
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { isActive: !config.isActive },
          });
          await ctx.answerCbQuery(
            `Alerts ${updated.isActive ? 'Enabled' : 'Disabled'}`,
          );
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'toggle_ema_reversal') {
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { emaReversalFilter: !config.emaReversalFilter },
          });
          await ctx.answerCbQuery(
            `EMA Reversal ${updated.emaReversalFilter ? 'Enabled' : 'Disabled'}`,
          );
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'toggle_ema_trend') {
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { emaTrendFilter: !config.emaTrendFilter },
          });
          await ctx.answerCbQuery(
            `Trend Filter ${updated.emaTrendFilter ? 'Enabled' : 'Disabled'}`,
          );
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'back_to_settings') {
          await ctx.answerCbQuery();
          const { text, keyboard } = this.renderSettingsMenu(config);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        }
        // Sub-menus rendering
        else if (callbackData === 'menu_min_vol') {
          await ctx.answerCbQuery();
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('Disabled', 'vol_set_0'),
              Markup.button.callback('1M USDT', 'vol_set_1000000'),
            ],
            [
              Markup.button.callback('2M USDT', 'vol_set_2000000'),
              Markup.button.callback('3M USDT', 'vol_set_3000000'),
            ],
            [
              Markup.button.callback('5M USDT', 'vol_set_5000000'),
              Markup.button.callback('10M USDT', 'vol_set_10000000'),
            ],
            [Markup.button.callback('◀️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('💰 *Select Minimum 24h Volume:*', {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_vol_24h') {
          await ctx.answerCbQuery();
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('Disabled', 'vol24_set_999999'),
              Markup.button.callback('+50%', 'vol24_set_50'),
            ],
            [
              Markup.button.callback('+100%', 'vol24_set_100'),
              Markup.button.callback('+150%', 'vol24_set_150'),
            ],
            [
              Markup.button.callback('+200%', 'vol24_set_200'),
              Markup.button.callback('+300%', 'vol24_set_300'),
            ],
            [
              Markup.button.callback('+500%', 'vol24_set_500'),
              Markup.button.callback('◀️ Back', 'back_to_settings'),
            ],
          ]);
          await ctx.editMessageText(
            '📊 *Select 24h Volume Change Threshold:*',
            {
              parse_mode: 'Markdown',
              reply_markup: keyboard.reply_markup,
            },
          );
        } else if (callbackData === 'menu_ema_tf') {
          await ctx.answerCbQuery();
          const selected = config.emaTimeframe
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          const is1h = selected.includes('1h');
          const is4h = selected.includes('4h');
          const is1d = selected.includes('1d');

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                is1h ? '✅ 1 Hour (1h)' : '⬜️ 1 Hour (1h)',
                'tf_toggle_1h',
              ),
              Markup.button.callback(
                is4h ? '✅ 4 Hours (4h)' : '⬜️ 4 Hours (4h)',
                'tf_toggle_4h',
              ),
            ],
            [
              Markup.button.callback(
                is1d ? '✅ 1 Day (1d)' : '⬜️ 1 Day (1d)',
                'tf_toggle_1d',
              ),
            ],
            [Markup.button.callback('◀️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('⏳ *Select EMA Scan Timeframe(s):*', {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_target_ema') {
          await ctx.answerCbQuery();
          const selected = config.emaTarget
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          const is34 = selected.includes('34');
          const is89 = selected.includes('89');
          const is200 = selected.includes('200');
          const isNone = selected.includes('none');

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                is34 ? '✅ EMA 34' : '⬜️ EMA 34',
                'target_toggle_34',
              ),
              Markup.button.callback(
                is89 ? '✅ EMA 89' : '⬜️ EMA 89',
                'target_toggle_89',
              ),
            ],
            [
              Markup.button.callback(
                is200 ? '✅ EMA 200' : '⬜️ EMA 200',
                'target_toggle_200',
              ),
              Markup.button.callback(
                isNone ? '✅ None (Candle Only)' : '⬜️ None (Candle Only)',
                'target_toggle_none',
              ),
            ],
            [Markup.button.callback('◀️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('🎯 *Select Target EMA Touch(es):*', {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_candle_pattern') {
          await ctx.answerCbQuery();
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('All Patterns', 'pattern_set_all'),
              Markup.button.callback('Hammer', 'pattern_set_hammer'),
            ],
            [
              Markup.button.callback(
                'Shooting Star',
                'pattern_set_shooting_star',
              ),
              Markup.button.callback('Engulfing', 'pattern_set_engulfing'),
            ],
            [Markup.button.callback('Doji', 'pattern_set_doji')],
            [Markup.button.callback('◀️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText(
            '🕯️ *Select Candlestick Reversal Pattern:*',
            {
              parse_mode: 'Markdown',
              reply_markup: keyboard.reply_markup,
            },
          );
        }
        // Sub-menus value setting logic
        else if (callbackData.startsWith('vol_set_')) {
          const val = parseInt(callbackData.replace('vol_set_', ''), 10);
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { minVolume24h: val },
          });
          const label = val === 0 ? 'Disabled' : `${val / 1000000}M USDT`;
          await ctx.answerCbQuery(`Min 24h Vol: ${label}`);
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('vol24_set_')) {
          const val = parseInt(callbackData.replace('vol24_set_', ''), 10);
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { volumeThreshold24h: val },
          });
          const label = val >= 999999 ? 'Disabled' : `+${val}%`;
          await ctx.answerCbQuery(`24h Vol Thresh: ${label}`);
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('tf_toggle_')) {
          const tfToToggle = callbackData.replace('tf_toggle_', '');
          let currentList = config.emaTimeframe
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);

          if (currentList.includes(tfToToggle)) {
            if (currentList.length <= 1) {
              await ctx.answerCbQuery(
                '⚠️ Bạn phải chọn ít nhất 1 khung thời gian!',
              );
              return;
            }
            currentList = currentList.filter((t) => t !== tfToToggle);
          } else {
            currentList.push(tfToToggle);
          }

          const orderedList: string[] = [];
          if (currentList.includes('1h')) orderedList.push('1h');
          if (currentList.includes('4h')) orderedList.push('4h');
          if (currentList.includes('1d')) orderedList.push('1d');

          const updatedVal = orderedList.join(',');

          await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { emaTimeframe: updatedVal },
          });

          await ctx.answerCbQuery(`Đã chọn: ${updatedVal.toUpperCase()}`);

          const is1h = orderedList.includes('1h');
          const is4h = orderedList.includes('4h');
          const is1d = orderedList.includes('1d');

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                is1h ? '✅ 1 Hour (1h)' : '⬜️ 1 Hour (1h)',
                'tf_toggle_1h',
              ),
              Markup.button.callback(
                is4h ? '✅ 4 Hours (4h)' : '⬜️ 4 Hours (4h)',
                'tf_toggle_4h',
              ),
            ],
            [
              Markup.button.callback(
                is1d ? '✅ 1 Day (1d)' : '⬜️ 1 Day (1d)',
                'tf_toggle_1d',
              ),
            ],
            [Markup.button.callback('◀️ Back', 'back_to_settings')],
          ]);

          await ctx.editMessageText('⏳ *Select EMA Scan Timeframe(s):*', {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('target_toggle_')) {
          const toggled = callbackData.replace('target_toggle_', '');
          let newTarget = '';

          if (toggled === 'none') {
            newTarget = 'none';
          } else {
            let currentTargets: string[] = [];
            if (config.emaTarget === 'all') {
              currentTargets = ['34', '89', '200'];
            } else if (config.emaTarget !== 'none') {
              currentTargets = config.emaTarget
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);
            }

            if (currentTargets.includes(toggled)) {
              currentTargets = currentTargets.filter((t) => t !== toggled);
            } else {
              currentTargets.push(toggled);
            }

            // Remove none if checking an EMA
            currentTargets = currentTargets.filter((t) => t !== 'none');

            if (currentTargets.length === 0) {
              newTarget = 'none';
            } else {
              newTarget = currentTargets.join(',');
            }
          }

          await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { emaTarget: newTarget },
          });

          await ctx.answerCbQuery();
          const selected = newTarget
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          const is34 = selected.includes('34');
          const is89 = selected.includes('89');
          const is200 = selected.includes('200');
          const isNone = selected.includes('none');

          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                is34 ? '✅ EMA 34' : '⬜️ EMA 34',
                'target_toggle_34',
              ),
              Markup.button.callback(
                is89 ? '✅ EMA 89' : '⬜️ EMA 89',
                'target_toggle_89',
              ),
            ],
            [
              Markup.button.callback(
                is200 ? '✅ EMA 200' : '⬜️ EMA 200',
                'target_toggle_200',
              ),
              Markup.button.callback(
                isNone ? '✅ None (Candle Only)' : '⬜️ None (Candle Only)',
                'target_toggle_none',
              ),
            ],
            [Markup.button.callback('◀️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('🎯 *Select Target EMA Touch(es):*', {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('pattern_set_')) {
          const val = callbackData.replace('pattern_set_', '');
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { candlePattern: val },
          });
          const patternMap: Record<string, string> = {
            all: 'All',
            hammer: 'Hammer',
            shooting_star: 'Shooting Star',
            engulfing: 'Engulfing',
            doji: 'Doji',
          };
          await ctx.answerCbQuery(`Pattern: ${patternMap[val]}`);
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        }
      } catch (error) {
        this.logger.error('Error handling callback query:', error);
        await ctx.answerCbQuery('⚠️ Error updating setting.');
      }
    });
  }

  private async getOrCreateUser(telegramId: string, ctx: Context) {
    let user = await this.databaseService.user.findUnique({
      where: { telegramId },
    });

    if (!user && ctx.from) {
      user = await this.databaseService.user.create({
        data: {
          telegramId,
          username: ctx.from.username || null,
          firstName: ctx.from.first_name || '',
          lastName: ctx.from.last_name || '',
          alertsConfig: {
            create: {
              volumeThreshold24h: 300.0,
              isActive: true,
              emaReversalFilter: false,
              emaTimeframe: '4h',
              minVolume24h: 1000000.0,
              emaTrendFilter: false,
              emaTarget: 'all',
              candlePattern: 'all',
            },
          },
        },
      });
    }
    return user;
  }

  private renderSettingsMenu(config: {
    id: string;
    isActive: boolean;
    volumeThreshold24h: number;
    emaReversalFilter: boolean;
    emaTimeframe: string;
    minVolume24h: number;
    emaTrendFilter: boolean;
    emaTarget: string;
    candlePattern: string;
  }) {
    const formatValue = (val: number) =>
      val >= 999999 ? 'Disabled' : `${val}%`;

    const formatMinVolume = (val: number) => {
      if (val === 0) return 'Disabled';
      if (val >= 1000000) return `${val / 1000000}M USDT`;
      return `${val.toLocaleString()} USDT`;
    };

    const formatPattern = (pat: string) => {
      const patternMap: Record<string, string> = {
        all: 'All',
        hammer: 'Hammer',
        shooting_star: 'Shooting Star',
        engulfing: 'Engulfing',
        doji: 'Doji',
      };
      return patternMap[pat] || 'All';
    };

    const formatEmaTarget = (target: string) => {
      if (target === 'all') return 'All';
      if (target === 'none') return 'None (Candle Only)';
      return target
        .split(',')
        .map((t) => `EMA ${t}`)
        .join(', ');
    };

    const reversalStatusText = config.emaReversalFilter
      ? '🟢 Active'
      : '🔴 Inactive';
    const tfText = (config.emaTimeframe || '4h')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .join(', ');

    const text =
      `⚙️ *Real-time Alert Settings*\n\n` +
      `• *Status*: ${config.isActive ? '🟢 Active' : '🔴 Inactive'}\n` +
      `• *Min 24h Volume*: \`${formatMinVolume(config.minVolume24h)}\`\n` +
      `• *24h Vol Threshold*: \`+${formatValue(config.volumeThreshold24h)}\`\n` +
      `• *EMA Reversal*: \`${reversalStatusText}\` | *EMA TF*: \`${tfText}\`\n` +
      `• *Target EMA*: \`${formatEmaTarget(config.emaTarget)}\`\n` +
      `• *Pattern*: \`${formatPattern(config.candlePattern)}\`\n` +
      `• *Trend Filter (EMA)*: \`${config.emaTrendFilter ? '🟢 Active' : '🔴 Inactive'}\`\n\n` +
      `Customize your alerts below:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          config.isActive ? '🔴 Disable Alerts' : '🟢 Enable Alerts',
          'toggle_active',
        ),
        Markup.button.callback('💰 Min 24h Vol', 'menu_min_vol'),
      ],
      [
        Markup.button.callback('📊 24h Vol Thresh', 'menu_vol_24h'),
        Markup.button.callback(
          config.emaReversalFilter ? '🔴 Stop EMA Filter' : '🟢 Run EMA Filter',
          'toggle_ema_reversal',
        ),
      ],
      [
        Markup.button.callback('⏳ EMA Timeframe', 'menu_ema_tf'),
        Markup.button.callback('🎯 Target EMA', 'menu_target_ema'),
      ],
      [
        Markup.button.callback('🕯️ Candle Pattern', 'menu_candle_pattern'),
        Markup.button.callback(
          config.emaTrendFilter ? '🔴 Stop Trend Fltr' : '🟢 Run Trend Fltr',
          'toggle_ema_trend',
        ),
      ],
    ]);

    return { text, keyboard };
  }
}
