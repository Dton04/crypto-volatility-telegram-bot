import { NestFactory } from '@nestjs/core';
import { BinanceWorkerModule } from './binance-worker.module';

async function bootstrap() {
  const app = await NestFactory.create(BinanceWorkerModule);
  await app.listen(process.env.PORT_BINANCE ?? 3001);
}
void bootstrap();
