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
          // Show Price options
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('2%', 'set_price:2'),
              Markup.button.callback('5%', 'set_price:5'),
            ],
            [
              Markup.button.callback('10%', 'set_price:10'),
              Markup.button.callback('15%', 'set_price:15'),
            ],
            [Markup.button.callback('⬅️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('📈 Choose Price Change Threshold (1h):', {
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData === 'menu_vol') {
          // Show Volume options
          const keyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback('50%', 'set_vol:50'),
              Markup.button.callback('100%', 'set_vol:100'),
            ],
            [
              Markup.button.callback('200%', 'set_vol:200'),
              Markup.button.callback('500%', 'set_vol:500'),
            ],
            [Markup.button.callback('⬅️ Back', 'back_to_settings')],
          ]);
          await ctx.editMessageText('📊 Choose 1h Volume Increase Threshold:', {
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('set_price:')) {
          const value = parseFloat(callbackData.split(':')[1]);
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { priceThreshold1h: value },
          });
          await ctx.answerCbQuery(`Price threshold set to ${value}%`);
          const { text, keyboard } = this.renderSettingsMenu(updated);
          await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup,
          });
        } else if (callbackData.startsWith('set_vol:')) {
          const value = parseFloat(callbackData.split(':')[1]);
          const updated = await this.databaseService.alertsConfig.update({
            where: { id: config.id },
            data: { volumeThreshold1h: value },
          });
          await ctx.answerCbQuery(`Volume threshold set to ${value}%`);
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
    volumeThreshold1h: number;
  }) {
    const text =
      `⚙️ *Real-time Alert Settings*\n\n` +
      `• *Status*: ${config.isActive ? '🟢 Active' : '🔴 Inactive'}\n` +
      `• *Mute Mode*: ${config.isMuted ? '🔕 Muted' : '🔔 Unmuted'}\n` +
      `• *Price Alert Threshold (1h)*: \`±${config.priceThreshold1h}%\`\n` +
      `• *Volume Alert Threshold (1h)*: \`+${config.volumeThreshold1h}%\`\n\n` +
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
    ]);

    return { text, keyboard };
  }
}
