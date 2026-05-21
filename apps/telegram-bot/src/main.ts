import { NestFactory } from '@nestjs/core';
import { TelegramBotModule } from './telegram-bot.module';

async function bootstrap() {
  const app = await NestFactory.create(TelegramBotModule);
  await app.listen(process.env.port ?? 3000);
}
void bootstrap();
