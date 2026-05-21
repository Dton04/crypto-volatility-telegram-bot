import { Test, TestingModule } from '@nestjs/testing';
import { BinanceWorkerService } from './binance-worker.service';
import { DatabaseService } from 'app/database';
import { getQueueToken } from '@nestjs/bullmq';

describe('BinanceWorkerService', () => {
  let service: BinanceWorkerService;

  const mockDatabaseService = {
    alertsConfig: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const mockQueue = {
    add: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BinanceWorkerService,
        { provide: DatabaseService, useValue: mockDatabaseService },
        { provide: getQueueToken('telegram-alerts'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<BinanceWorkerService>(BinanceWorkerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
