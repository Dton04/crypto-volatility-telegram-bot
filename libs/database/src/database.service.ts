import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DatabaseService.name);
  private static pool: Pool;
  private static adapter: PrismaPg;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not defined');
    }

    if (!DatabaseService.pool) {
      DatabaseService.pool = new Pool({ connectionString });
      DatabaseService.adapter = new PrismaPg(DatabaseService.pool);
    }

    super({ adapter: DatabaseService.adapter });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Prisma Client connected to database successfully.');
    } catch (error) {
      this.logger.error(
        'Failed to connect to database via Prisma Client:',
        error,
      );
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
      if (DatabaseService.pool) {
        await DatabaseService.pool.end();
      }
      this.logger.log('Prisma Client disconnected from database successfully.');
    } catch (error) {
      this.logger.error('Error during database disconnection:', error);
    }
  }
}
