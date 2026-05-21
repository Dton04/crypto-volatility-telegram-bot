import { NestFactory } from '@nestjs/core';
import { BinanceWorkerModule } from './binance-worker.module';

async function bootstrap() {
  const app = await NestFactory.create(BinanceWorkerModule);
  await app.listen(process.env.port ?? 3000);
}
void bootstrap();
