import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';
import { DatabaseService } from 'app/database';
import { AlertType, Timeframe } from '@prisma/client';

interface AlertJobData {
  userId: string;
  telegramId: string;
  symbol: string;
  alertType: AlertType;
  timeframe: Timeframe;
  oldValue: number;
  newValue: number;
  percentageChange: number;
  currentPrice?: number;
  emaTimeframe?: string;
  touchEma?: number | null;
  emaName?: string | null;
  touchDiff?: number | null;
  pattern?: string | null;
  nearestEmaName?: string;
  nearestEmaVal?: number;
  nearestEmaDiff?: number;
  ema34?: number;
  ema89?: number;
  ema200?: number;
  setupDirection?: 'LONG' | 'SHORT' | null;
  rsi?: number;
}

@Processor('telegram-alerts')
export class AlertsConsumer extends WorkerHost {
  private readonly logger = new Logger(AlertsConsumer.name);

  constructor(
    private readonly telegramBotService: TelegramBotService,
    private readonly databaseService: DatabaseService,
  ) {
    super();
  }

  async process(job: Job<AlertJobData, any, string>): Promise<any> {
    const data = job.data;
    const {
      userId,
      telegramId,
      symbol,
      alertType,
      timeframe,
      oldValue,
      newValue,
      percentageChange,
      currentPrice,
      emaTimeframe,
      touchEma,
      emaName,
      touchDiff,
      pattern,
      nearestEmaName,
      nearestEmaVal,
      nearestEmaDiff,
      ema34,
      ema89,
      ema200,
      setupDirection,
      rsi,
    } = data;

    this.logger.log(
      `Processing alert job for user ${userId}, symbol ${symbol}`,
    );

    // Format the message
    const formattedChange =
      percentageChange > 0
        ? `+${percentageChange.toFixed(2)}%`
        : `${percentageChange.toFixed(2)}%`;
    const emoji = percentageChange > 0 ? '🟢 🚀' : '🔴 📉';
    const chartLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}`;

    let message = '';
    if (alertType === 'PRICE_VOLATILITY') {
      message =
        `🚨 *[PRICE ALERT] ${symbol}* ${emoji}\n\n` +
        `• *Timeframe*: ${timeframe === 'H1' ? '1 Hour' : '24 Hours'}\n` +
        `• *Change*: *${formattedChange}*\n` +
        `• *Old Price*: \`$${oldValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\`\n` +
        `• *New Price*: \`$${newValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}\`\n\n` +
        `📊 [View Chart on TradingView](${chartLink})`;
    } else {
      const isReversal = !!pattern;
      const tfText = (emaTimeframe || '4h').toUpperCase();

      if (isReversal) {
        const priceStr = currentPrice
          ? currentPrice.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 6,
            })
          : 'N/A';

        let titleEmoji = '🔥';
        let directionText = 'REVERSAL';
        if (setupDirection === 'LONG') {
          titleEmoji = '🟢 🚀';
          directionText = 'LONG';
        } else if (setupDirection === 'SHORT') {
          titleEmoji = '🔴 📉';
          directionText = 'SHORT';
        }

        const showVolumeInfo = newValue > 0;
        const volumeLines = showVolumeInfo
          ? `• *Volume Increase*: *${formattedChange}*\n` +
            `• *Volume (${timeframe === 'H1' ? '1h' : '24h'})*: \`${newValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDT\`\n`
          : '';

        const hasTouch = touchEma !== undefined && touchEma !== null;
        const titleLine = hasTouch
          ? `${titleEmoji} *[EMA ${tfText} ${directionText} SETUP] ${symbol}* ${titleEmoji}`
          : `${titleEmoji} *[CANDLE ${tfText} ${directionText} REVERSAL] ${symbol}* ${titleEmoji}`;

        const setupLine = hasTouch
          ? `• *Setup*: \`${pattern}\` at EMA ${emaName} (\`$${touchEma}\`)\n• *Touch Diff*: \`${touchDiff}%\`\n`
          : `• *Pattern*: \`${pattern}\` detected (No EMA constraint)\n`;

        const rsiStatus =
          rsi !== undefined
            ? rsi <= 30
              ? 'Oversold 🟢 (Quá Bán)'
              : rsi >= 70
                ? 'Overbought 🔴 (Quá Mua)'
                : 'Neutral ⚪'
            : '';
        const rsiLine =
          rsi !== undefined
            ? `• *RSI*: \`${rsi.toFixed(2)}\` (${rsiStatus})\n`
            : '';

        message =
          `${titleLine}\n\n` +
          setupLine +
          volumeLines +
          `• *Price*: \`$${priceStr}\`\n` +
          rsiLine +
          `\n📈 *EMA Status (${tfText})*:\n` +
          `  - EMA 34: \`$${ema34}\`\n` +
          `  - EMA 89: \`$${ema89}\`\n` +
          `  - EMA 200: \`$${ema200}\`\n\n` +
          `📊 [View Chart on TradingView](${chartLink})`;
      } else {
        let emaFooter = '';
        if (nearestEmaName && nearestEmaVal !== undefined) {
          const rsiStatus =
            rsi !== undefined
              ? rsi <= 30
                ? 'Oversold 🟢'
                : rsi >= 70
                  ? 'Overbought 🔴'
                  : 'Neutral ⚪'
              : '';
          const rsiLine =
            rsi !== undefined
              ? `  - RSI: \`${rsi.toFixed(2)}\` (${rsiStatus})\n`
              : '';

          emaFooter =
            `📈 *EMA Info (${tfText})*:\n` +
            rsiLine +
            `  - Nearest: EMA ${nearestEmaName} (\`$${nearestEmaVal}\`) | Diff: \`${nearestEmaDiff}%\`\n` +
            `  - EMA 34: \`$${ema34}\` | EMA 89: \`$${ema89}\` | EMA 200: \`$${ema200}\`\n\n`;
        }

        message =
          `🚨 *[VOLUME ALERT] ${symbol}* 📊\n\n` +
          `• *Timeframe*: ${timeframe === 'H1' ? '1 Hour' : '24 Hours'}\n` +
          `• *Increase*: *${formattedChange}*\n` +
          `• *Old Volume*: \`${oldValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDT\`\n` +
          `• *New Volume*: \`${newValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDT\`\n\n` +
          emaFooter +
          `📊 [View Chart on TradingView](${chartLink})`;
      }
    }

    try {
      // Check if bot is initialized
      if (!this.telegramBotService.bot) {
        throw new Error('Telegram Bot is not initialized yet.');
      }

      // Send telegram alert
      await this.telegramBotService.bot.telegram.sendMessage(
        telegramId,
        message,
        {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
        },
      );

      // Save AlertLog in database asynchronously
      await this.databaseService.alertLog.create({
        data: {
          userId,
          symbol,
          alertType,
          timeframe,
          oldValue,
          newValue,
          percentageChange,
        },
      });

      this.logger.log(
        `Successfully sent alert to user ${userId} for ${symbol}`,
      );
    } catch (error: unknown) {
      this.logger.error(`Failed to send alert to user ${userId}:`, error);

      // Handle user blocking the bot
      const isBlocked =
        error &&
        typeof error === 'object' &&
        (('description' in error &&
          typeof error.description === 'string' &&
          error.description.includes('bot was blocked by the user')) ||
          ('code' in error && error.code === 403));

      if (isBlocked) {
        this.logger.warn(
          `User ${userId} blocked the bot. Disabling alerts config...`,
        );
        await this.databaseService.alertsConfig.update({
          where: { userId },
          data: { isActive: false },
        });
      }

      throw error; // Propagate error back to BullMQ for potential retry/fail marking
    }
  }
}
