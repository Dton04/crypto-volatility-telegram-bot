import { Injectable, Logger } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import { DatabaseService } from 'app/database';
import { UserService } from '../user/user.service';

@Injectable()
export class TelegramSettingsService {
  private readonly logger = new Logger(TelegramSettingsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly userService: UserService,
  ) {}

  async handleSettingsCommand(ctx: Context) {
    try {
      const telegramId = ctx.from?.id.toString();
      if (!telegramId) return;

      const user = await this.userService.getOrCreateUser(telegramId, ctx);
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
  }

  async handleCallbackQuery(
    ctx: Context,
    callbackData: string,
    config: {
      id: string;
      isActive: boolean;
      volumeThreshold24h: number;
      emaReversalFilter: boolean;
      emaTimeframe: string;
      minVolume24h: number;
      emaTrendFilter: boolean;
      emaTarget: string;
      candlePattern: string;
    },
  ) {
    try {
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
      } else if (callbackData === 'menu_min_vol') {
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
        await ctx.editMessageText('📊 *Select 24h Volume Change Threshold:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboard.reply_markup,
        });
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
        await ctx.editMessageText('🕯️ *Select Candlestick Reversal Pattern:*', {
          parse_mode: 'Markdown',
          reply_markup: keyboard.reply_markup,
        });
      } else if (callbackData.startsWith('vol_set_')) {
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
              isNone ? '✅ None (Candle Only)' : '⬜️ Nonee (Candle Only)',
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
      `• Status: ${config.isActive ? '🟢 Active' : '🔴 Inactive'}\n` +
      `• Min 24h Volume: *${formatMinVolume(config.minVolume24h)}*\n` +
      `• 24h Vol Threshold: *${formatValue(config.volumeThreshold24h)}*\n` +
      `• EMA Reversal: *${reversalStatusText}* | EMA TF: *${tfText}*\n` +
      `• Target EMA: *${formatEmaTarget(config.emaTarget)}*\n` +
      `• Pattern: *${formatPattern(config.candlePattern)}*\n` +
      `• Trend Filter (EMA): *${config.emaTrendFilter ? '🟢 Active' : '🔴 Inactive'}*\n\n` +
      `Customize your alerts below:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          config.isActive ? '🔴 Disable Alerts' : '🟢 Enable Alerts',
          'toggle_active',
        ),
      ],
      [
        Markup.button.callback('💰 Min 24h Vol', 'menu_min_vol'),
        Markup.button.callback('📊 24h Vol Change', 'menu_vol_24h'),
      ],
      [
        Markup.button.callback(
          config.emaReversalFilter
            ? '🔴 Disable EMA Reversal'
            : '🟢 Enable EMA Reversal',
          'toggle_ema_reversal',
        ),
      ],
      [
        Markup.button.callback('⏳ EMA Scan TFs', 'menu_ema_tf'),
        Markup.button.callback('🎯 Target EMA Touch', 'menu_target_ema'),
      ],
      [
        Markup.button.callback('🕯️ Candle Pattern', 'menu_candle_pattern'),
        Markup.button.callback(
          config.emaTrendFilter ? '🔴 Trend Filter Off' : '🟢 Trend Filter On',
          'toggle_ema_trend',
        ),
      ],
    ]);

    return { text, keyboard };
  }
}
