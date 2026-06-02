import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from 'app/database';
import { BinanceWorkerController } from './binance-worker.controller';
import { BinanceWorkerService } from './binance-worker.service';
import { TechnicalIndicatorsService } from './indicators/technical-indicators.service';
import { KlineScannerService } from './scanner/kline-scanner.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const password = configService.get<string>('REDIS_PASSWORD');
        const connection: { host: string; port: number; password?: string } = {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
        };
        if (password && password.trim() !== '') {
          connection.password = password;
        }
        return { connection };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: 'telegram-alerts',
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: { count: 50 },
      },
    }),
  ],
  controllers: [BinanceWorkerController],
  providers: [
    BinanceWorkerService,
    TechnicalIndicatorsService,
    KlineScannerService,
  ],
})
export class BinanceWorkerModule {}
