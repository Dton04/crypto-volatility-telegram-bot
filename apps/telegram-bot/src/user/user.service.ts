import { Injectable } from '@nestjs/common';
import { Context } from 'telegraf';
import { DatabaseService } from 'app/database';

@Injectable()
export class UserService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getOrCreateUser(telegramId: string, ctx: Context) {
    let user = await this.databaseService.user.findUnique({
      where: { telegramId },
    });

    if (!user && ctx.from) {
      user = await this.databaseService.user.create({
        data: {
          telegramId,
          username: ctx.from.username || null,
          firstName: ctx.from.first_name || '',
          lastName: ctx.from.last_name || '',
          alertsConfig: {
            create: {
              volumeThreshold24h: 300.0,
              isActive: true,
              emaReversalFilter: false,
              emaTimeframe: '4h',
              minVolume24h: 1000000.0,
              emaTrendFilter: false,
              emaTarget: 'all',
              candlePattern: 'all',
            },
          },
        },
      });
    }
    return user;
  }
}
