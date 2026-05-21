import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from './database.service';

jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => {
      return {
        $connect: jest.fn().mockResolvedValue(true),
        $disconnect: jest.fn().mockResolvedValue(true),
      };
    }),
  };
});

jest.mock('@prisma/adapter-pg', () => {
  return {
    PrismaPg: jest.fn().mockImplementation(() => ({})),
  };
});

jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      end: jest.fn().mockResolvedValue(true),
    })),
  };
});

describe('DatabaseService', () => {
  let service: DatabaseService;

  beforeAll(() => {
    process.env.DATABASE_URL =
      'postgresql://telecrypt:telecrypt_secure_pass_135@localhost:5432/telecrypt_db';
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DatabaseService],
    }).compile();

    service = module.get<DatabaseService>(DatabaseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
