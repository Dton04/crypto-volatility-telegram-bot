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

          const closes = data.map((k) => parseFloat((k as string[])[4]));
          const currentPrice = closes[closes.length - 1];

          const calculateEMA = (prices: number[], period: number) => {
            const k = 2 / (period + 1);
            let ema = prices[0];
            for (let i = 1; i < prices.length; i++) {
              ema = prices[i] * k + ema * (1 - k);
            }
            return ema;
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

          return (
            `*${tfName}*:\n` +
            `  • Price: \`$${res.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\`\n` +
            `  • Trend: ${res.trend}\n` +
            `  • Pattern: \`${res.pattern || 'None'}\`\n` +
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
              Markup.button.callback('+200%', 'vol24_set_200'),
            ],
            [Markup.button.callback('◀️ Back', 'back_to_settings')],
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
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('All EMAs', 'target_set_all'),
              Markup.button.callback('EMA 34', 'target_set_34'),
            ],
            [
              Markup.button.callback('EMA 89', 'target_set_89'),
              Markup.button.callback('EMA 200', 'target_set_200'),
            ],
            [Markup.button.callback('None (Candle Only)', 'target_set_none')],
            [Markup.button.callback('◀️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('🎯 *Select Target EMA Touch:*', {
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
        } else if (callbackData.startsWith('target_set_')) {
          const val = callbackData.replace('target_set_', '');
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { emaTarget: val },
          });
          const label =
            val === 'all'
              ? 'All'
              : val === 'none'
                ? 'None (Candle Only)'
                : `EMA ${val}`;
          await ctx.answerCbQuery(`Target EMA: ${label}`);
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
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
      return `EMA ${target}`;
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
