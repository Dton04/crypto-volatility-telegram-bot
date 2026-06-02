import { Test, TestingModule } from '@nestjs/testing';
import { AlertsConsumer } from './alerts/alerts.consumer';
import { TelegramBotService } from './telegram-bot.service';
import { DatabaseService } from 'app/database';
import { Job } from 'bullmq';
import { AlertType, Timeframe } from '@prisma/client';

describe('AlertsConsumer', () => {
  let consumer: AlertsConsumer;

  const mockTelegramSendMessage = jest.fn().mockResolvedValue({});
  const mockTelegramBotService = {
    bot: {
      telegram: {
        sendMessage: mockTelegramSendMessage,
      },
    },
  };

  const mockAlertLogCreate = jest.fn().mockResolvedValue({});
  const mockDatabaseService = {
    alertLog: {
      create: mockAlertLogCreate,
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertsConsumer,
        { provide: TelegramBotService, useValue: mockTelegramBotService },
        { provide: DatabaseService, useValue: mockDatabaseService },
      ],
    }).compile();

    consumer = module.get<AlertsConsumer>(AlertsConsumer);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(consumer).toBeDefined();
  });

  describe('process', () => {
    it('should format and send a price volatility alert and log it to DB', async () => {
      const mockJob = {
        data: {
          userId: 'user-uuid',
          telegramId: '123456789',
          symbol: 'BTCUSDT',
          alertType: 'PRICE_VOLATILITY' as AlertType,
          timeframe: 'H1' as Timeframe,
          oldValue: 60000,
          newValue: 63000,
          percentageChange: 5,
        },
      } as unknown as Job;

      await consumer.process(mockJob);

      // Verify telegram message is sent
      expect(mockTelegramSendMessage).toHaveBeenCalledWith(
        '123456789',
        expect.stringContaining('PRICE ALERT'),
        expect.any(Object),
      );

      // Verify alert log is created in db
      expect(mockAlertLogCreate).toHaveBeenCalledWith({
        data: {
          userId: 'user-uuid',
          symbol: 'BTCUSDT',
          alertType: 'PRICE_VOLATILITY',
          timeframe: 'H1',
          oldValue: 60000,
          newValue: 63000,
          percentageChange: 5,
        },
      });
    });
  });
});
