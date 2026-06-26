import { Test, TestingModule } from '@nestjs/testing';
import { BinanceWorkerService } from './binance-worker.service';
import { DatabaseService } from 'app/database';
import { getQueueToken } from '@nestjs/bullmq';
import { KlineScannerService } from './scanner/kline-scanner.service';

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

  const mockTicksCounter = {
    inc: jest.fn(),
  };

  const mockTrackedSymbolsGauge = {
    set: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BinanceWorkerService,
        { provide: DatabaseService, useValue: mockDatabaseService },
        { provide: getQueueToken('telegram-alerts'), useValue: mockQueue },
        { provide: KlineScannerService, useValue: {} },
        { provide: 'PROM_METRIC_BINANCE_WEBSOCKET_TICKS_TOTAL', useValue: mockTicksCounter },
        { provide: 'PROM_METRIC_TELECRYPT_TRACKED_SYMBOLS', useValue: mockTrackedSymbolsGauge },
      ],
    }).compile();

    service = module.get<BinanceWorkerService>(BinanceWorkerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
