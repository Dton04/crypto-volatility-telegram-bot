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
    let connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      const dbUser = process.env.DB_USER || 'telecrypt';
      const dbPass = process.env.DB_PASSWORD || 'telecrypt_secure_pass_135';
      const dbHost = process.env.DB_HOST || 'localhost';
      const dbPort = process.env.DB_PORT || '5432';
      const dbName = process.env.DB_NAME || 'telecrypt_db';
      connectionString = `postgresql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}?schema=public`;
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
