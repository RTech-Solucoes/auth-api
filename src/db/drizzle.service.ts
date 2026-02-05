// src/db/drizzle.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

@Injectable()
export class DrizzleService implements OnModuleInit, OnModuleDestroy {
  public db!: ReturnType<typeof drizzle>;
  private pool!: Pool;

  onModuleInit() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });

    this.db = drizzle({ client: this.pool, schema });

    console.log('✅ Database connection established');
  }

  async onModuleDestroy() {
    await this.pool.end();
    console.log('🔌 Database connection closed');
  }

  // Helper para transações
  transaction<T>(
    callback: Parameters<typeof this.db.transaction>[0],
  ): Promise<T> {
    return this.db.transaction(callback) as Promise<T>;
  }
}
