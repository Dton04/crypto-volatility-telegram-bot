import { Test, TestingModule } from '@nestjs/testing';
import { TelegramBotController } from './telegram-bot.controller';
import { Response } from 'express';

describe('TelegramBotController', () => {
  let controller: TelegramBotController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TelegramBotController],
    }).compile();

    controller = module.get<TelegramBotController>(TelegramBotController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getHealth', () => {
    it('should return health status with 200 OK', () => {
      const mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;

      controller.getHealth(mockResponse);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'UP',
          service: 'telegram-bot',
        }),
      );
    });
  });
});
