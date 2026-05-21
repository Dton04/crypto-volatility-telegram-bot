import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import * as express from 'express';

@Controller('health')
export class BinanceWorkerController {
  @Get()
  getHealth(@Res() res: express.Response) {
    return res.status(HttpStatus.OK).json({
      status: 'UP',
      timestamp: new Date().toISOString(),
      service: 'binance-worker',
    });
  }
}
