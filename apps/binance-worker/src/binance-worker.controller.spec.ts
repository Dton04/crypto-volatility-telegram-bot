import { Test, TestingModule } from '@nestjs/testing';
import { BinanceWorkerController } from './binance-worker.controller';
import { Response } from 'express';

describe('BinanceWorkerController', () => {
  let controller: BinanceWorkerController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BinanceWorkerController],
    }).compile();

    controller = module.get<BinanceWorkerController>(BinanceWorkerController);
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
          service: 'binance-worker',
        }),
      );
    });
  });
});
