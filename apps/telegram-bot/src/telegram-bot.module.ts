import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from 'app/database';
import { TelegramBotController } from './telegram-bot.controller';
import { TelegramBotService } from './telegram-bot.service';
import { AlertsConsumer } from './alerts/alerts.consumer';
import { UserService } from './user/user.service';
import { TelegramSettingsService } from './settings/telegram-settings.service';
import { TelegramTestService } from './test-command/telegram-test.service';

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
  controllers: [TelegramBotController],
  providers: [
    TelegramBotService,
    AlertsConsumer,
    UserService,
    TelegramSettingsService,
    TelegramTestService,
  ],
})
export class TelegramBotModule {}
