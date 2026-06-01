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
                  priceThreshold1h: 5.0,
                  priceThreshold24h: 15.0,
                  volumeThreshold1h: 100.0,
                  volumeThreshold24h: 300.0,
                  isActive: true,
                  isMuted: false,
                  emaReversalFilter: false,
                  emaTimeframe: '4h',
                  minVolume24h: 1000000.0,
                  emaTrendFilter: false,
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
        } else if (callbackData === 'toggle_mute') {
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { isMuted: !config.isMuted },
          });
          await ctx.answerCbQuery(`Mute ${updated.isMuted ? 'On' : 'Off'}`);
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_price') {
          // Show Price options menu (Timeframe selection)
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('1 Hour Price', 'menu_price_tf:1h'),
              Markup.button.callback('24 Hours Price', 'menu_price_tf:24h'),
            ],
            [Markup.button.callback('⬅️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('📈 Select Price timeframe to configure:', {
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_vol') {
          // Show Volume options menu (Timeframe selection)
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('1 Hour Volume', 'menu_vol_tf:1h'),
              Markup.button.callback('24 Hours Volume', 'menu_vol_tf:24h'),
            ],
            [Markup.button.callback('⬅️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText(
            '📊 Select Volume timeframe to configure:',
            {
              reply_markup: keyboard.reply_markup,
            },
          );
        } else if (callbackData === 'menu_price_tf:1h') {
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('1%', 'set_price:1h:1'),
              Markup.button.callback('2%', 'set_price:1h:2'),
              Markup.button.callback('5%', 'set_price:1h:5'),
            ],
            [
              Markup.button.callback('10%', 'set_price:1h:10'),
              Markup.button.callback('📴 Disable', 'set_price:1h:999999'),
            ],
            [Markup.button.callback('⬅️ Back', 'menu_price')],
          ]);
          await ctx.editMessageText('📈 Choose Price Change Threshold (1h):', {
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_price_tf:24h') {
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('5%', 'set_price:24h:5'),
              Markup.button.callback('10%', 'set_price:24h:10'),
              Markup.button.callback('15%', 'set_price:24h:15'),
            ],
            [
              Markup.button.callback('25%', 'set_price:24h:25'),
              Markup.button.callback('📴 Disable', 'set_price:24h:999999'),
            ],
            [Markup.button.callback('⬅️ Back', 'menu_price')],
          ]);
          await ctx.editMessageText('📈 Choose Price Change Threshold (24h):', {
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_vol_tf:1h') {
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('50%', 'set_vol:1h:50'),
              Markup.button.callback('100%', 'set_vol:1h:100'),
              Markup.button.callback('200%', 'set_vol:1h:200'),
            ],
            [
              Markup.button.callback('500%', 'set_vol:1h:500'),
              Markup.button.callback('📴 Disable', 'set_vol:1h:999999'),
            ],
            [Markup.button.callback('⬅️ Back', 'menu_vol')],
          ]);
          await ctx.editMessageText('📊 Choose 1h Volume Increase Threshold:', {
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_vol_tf:24h') {
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('20%', 'set_vol:24h:20'),
              Markup.button.callback('50%', 'set_vol:24h:50'),
              Markup.button.callback('100%', 'set_vol:24h:100'),
            ],
            [
              Markup.button.callback('200%', 'set_vol:24h:200'),
              Markup.button.callback('📴 Disable', 'set_vol:24h:999999'),
            ],
            [Markup.button.callback('⬅️ Back', 'menu_vol')],
          ]);
          await ctx.editMessageText(
            '📊 Choose 24h Volume Increase Threshold:',
            {
              reply_markup: keyboard.reply_markup,
            },
          );
        } else if (callbackData.startsWith('set_price:1h:')) {
          const value = parseFloat(callbackData.split(':')[2]);
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { priceThreshold1h: value },
          });
          await ctx.answerCbQuery(
            `1h Price threshold set to ${value >= 999999 ? 'Disabled' : value + '%'}`,
          );
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('set_price:24h:')) {
          const value = parseFloat(callbackData.split(':')[2]);
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { priceThreshold24h: value },
          });
          await ctx.answerCbQuery(
            `24h Price threshold set to ${value >= 999999 ? 'Disabled' : value + '%'}`,
          );
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('set_vol:1h:')) {
          const value = parseFloat(callbackData.split(':')[2]);
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { volumeThreshold1h: value },
          });
          await ctx.answerCbQuery(
            `1h Volume threshold set to ${value >= 999999 ? 'Disabled' : value + '%'}`,
          );
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('set_vol:24h:')) {
          const value = parseFloat(callbackData.split(':')[2]);
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { volumeThreshold24h: value },
          });
          await ctx.answerCbQuery(
            `24h Volume threshold set to ${value >= 999999 ? 'Disabled' : value + '%'}`,
          );
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'back_to_settings') {
          const { text, keyboard } = this.renderSettingsMenu(config);
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
        } else if (callbackData === 'menu_ema_tf') {
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('1 Hour (H1)', 'set_ema_tf:1h'),
              Markup.button.callback('4 Hours (H4) ⭐', 'set_ema_tf:4h'),
              Markup.button.callback('1 Day (D1) ⭐', 'set_ema_tf:1d'),
            ],
            [Markup.button.callback('⬅️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('⏳ Select EMA & Candlestick Timeframe:', {
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('set_ema_tf:')) {
          const tf = callbackData.split(':')[1];
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { emaTimeframe: tf },
          });
          await ctx.answerCbQuery(`EMA Timeframe set to ${tf.toUpperCase()}`);
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'cycle_min_vol') {
          let nextVol = 1000000;
          if (config.minVolume24h === 1000000) nextVol = 2000000;
          else if (config.minVolume24h === 2000000) nextVol = 3000000;
          else if (config.minVolume24h === 3000000) nextVol = 5000000;
          else if (config.minVolume24h === 5000000) nextVol = 10000000;
          else if (config.minVolume24h === 10000000) nextVol = 0;
          else nextVol = 1000000;

          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { minVolume24h: nextVol },
          });
          const volText =
            nextVol === 0 ? 'Disabled' : `${nextVol / 1000000}M USDT`;
          await ctx.answerCbQuery(`Min 24h Vol set to ${volText}`);
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
              priceThreshold1h: 5.0,
              priceThreshold24h: 15.0,
              volumeThreshold1h: 100.0,
              volumeThreshold24h: 300.0,
              isActive: true,
              isMuted: false,
              emaReversalFilter: false,
              emaTimeframe: '4h',
              minVolume24h: 1000000.0,
              emaTrendFilter: false,
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
    isMuted: boolean;
    priceThreshold1h: number;
    priceThreshold24h: number;
    volumeThreshold1h: number;
    volumeThreshold24h: number;
    emaReversalFilter: boolean;
    emaTimeframe: string;
    minVolume24h: number;
    emaTrendFilter: boolean;
  }) {
    const formatValue = (val: number) =>
      val >= 999999 ? 'Disabled' : `${val}%`;

    const formatMinVolume = (val: number) => {
      if (val === 0) return 'Disabled';
      if (val >= 1000000) return `${val / 1000000}M USDT`;
      return `${val.toLocaleString()} USDT`;
    };

    const reversalStatusText = config.emaReversalFilter
      ? '🟢 Active'
      : '🔴 Inactive';
    const tfText = (config.emaTimeframe || '4h').toUpperCase();

    const text =
      `⚙️ *Real-time Alert Settings*\n\n` +
      `• *Status*: ${config.isActive ? '🟢 Active' : '🔴 Inactive'}\n` +
      `• *Mute Mode*: ${config.isMuted ? '🔕 Muted' : '🔔 Unmuted'}\n` +
      `• *Price Threshold*: 1h: \`±${formatValue(config.priceThreshold1h)}\` | 24h: \`±${formatValue(config.priceThreshold24h)}\`\n` +
      `• *Volume Threshold*: 1h: \`+${formatValue(config.volumeThreshold1h)}\` | 24h: \`+${formatValue(config.volumeThreshold24h)}\`\n` +
      `• *Min 24h Volume*: \`${formatMinVolume(config.minVolume24h)}\`\n` +
      `• *EMA Reversal*: \`${reversalStatusText}\` | *EMA TF*: \`${tfText}\`\n` +
      `• *Trend Filter (EMA)*: \`${config.emaTrendFilter ? '🟢 Active' : '🔴 Inactive'}\`\n\n` +
      `Customize your alerts below:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          config.isActive ? '🔴 Disable Alerts' : '🟢 Enable Alerts',
          'toggle_active',
        ),
        Markup.button.callback(
          config.isMuted ? '🔔 Unmute' : '🔕 Mute',
          'toggle_mute',
        ),
      ],
      [
        Markup.button.callback('📈 Price Threshold', 'menu_price'),
        Markup.button.callback('📊 Volume Threshold', 'menu_vol'),
      ],
      [
        Markup.button.callback(
          config.emaReversalFilter ? '🔴 Stop EMA Filter' : '🟢 Run EMA Filter',
          'toggle_ema_reversal',
        ),
        Markup.button.callback('⏳ EMA Timeframe', 'menu_ema_tf'),
      ],
      [
        Markup.button.callback('💰 Min 24h Vol', 'cycle_min_vol'),
        Markup.button.callback(
          config.emaTrendFilter ? '🔴 Stop Trend Fltr' : '🟢 Run Trend Fltr',
          'toggle_ema_trend',
        ),
      ],
    ]);

    return { text, keyboard };
  }
}
