import { Test, TestingModule } from '@nestjs/testing';
import { TelegramBotService } from './telegram-bot.service';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'app/database';

jest.mock('telegraf', () => {
  return {
    Telegraf: jest.fn().mockImplementation(() => {
      return {
        command: jest.fn(),
        on: jest.fn(),
        launch: jest.fn().mockResolvedValue(true),
        stop: jest.fn(),
      };
    }),
    Markup: {
      inlineKeyboard: jest.fn().mockReturnValue({ reply_markup: {} }),
      button: {
        callback: jest.fn(),
      },
    },
  };
});

describe('TelegramBotService', () => {
  let service: TelegramBotService;

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'TELEGRAM_BOT_TOKEN') return 'mock-bot-token';
      return null;
    }),
  };

  const mockDatabaseService = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramBotService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DatabaseService, useValue: mockDatabaseService },
      ],
    }).compile();

    service = module.get<TelegramBotService>(TelegramBotService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
