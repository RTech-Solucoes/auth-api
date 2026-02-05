# Guia de Implementação - Auth Service
## Exemplos de Código NestJS + Drizzle

## 1. Setup Inicial do Projeto

### 1.1 Estrutura de Diretórios
```bash
auth-service/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── db/
│   │   └── schema.ts
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── introspection.service.ts
│   │   ├── token.service.ts
│   │   ├── guards/
│   │   └── dto/
│   ├── users/
│   ├── tenants/
│   ├── roles/
│   ├── projects/
│   ├── audit/
│   └── cache/
├── drizzle/
├── test/
├── docker/
├── .env
├── .env.example
├── package.json
├── drizzle.config.ts
├── tsconfig.json
└── README.md
```

### 1.2 package.json
```json
{
  "name": "auth-service",
  "version": "1.0.0",
  "scripts": {
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main",
    "build": "nest build",
    "test": "jest",
    "test:e2e": "jest --config ./test/jest-e2e.json",
    "db:seed": "tsx src/db/seed.ts"
  },
  "dependencies": {
    "@nestjs/common": "^10.3.0",
    "@nestjs/core": "^10.3.0",
    "@nestjs/platform-express": "^10.3.0",
    "@nestjs/config": "^3.1.1",
    "@nestjs/swagger": "^7.1.17",
    "drizzle-orm": "^0.29.3",
    "pg": "^8.13.0",
    "ioredis": "^5.3.2",
    "bcrypt": "^5.1.1",
    "class-validator": "^0.14.0",
    "class-transformer": "^0.5.1",
    "helmet": "^7.1.0",
    "rate-limiter-flexible": "^4.0.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.2.1",
    "@nestjs/testing": "^10.3.0",
    "@types/node": "^20.10.6",
    "@types/bcrypt": "^5.0.2",
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.20.9",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

## 2. Configuração do Database (Drizzle)

### 2.1 drizzle.config.ts
```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

### 2.2 Database Service
```typescript
// src/db/drizzle.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

@Injectable()
export class DrizzleService implements OnModuleInit, OnModuleDestroy {
  public db: ReturnType<typeof drizzle>;
  private pool: Pool;

  async onModuleInit() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });

    this.db = drizzle({ client: this.pool, schema });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  // Helper para transações
  async transaction<T>(callback: (tx: typeof this.db) => Promise<T>): Promise<T> {
    return this.db.transaction(callback);
  }
}
```

## 3. Token Service (Opaque Tokens)

```typescript
// src/auth/token.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DrizzleService } from '../db/drizzle.service';
import { CacheService } from '../cache/cache.service';
import { tokens } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import * as crypto from 'crypto';

export interface TokenPayload {
  userId: string;
  tenantId: string;
  scopes?: string[];
  metadata?: Record<string, any>;
}

export interface TokenInfo extends TokenPayload {
  token: string;
  type: 'access' | 'refresh';
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  private readonly ACCESS_TOKEN_TTL = 15 * 60; // 15 minutos
  private readonly REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 dias

  constructor(
    private drizzle: DrizzleService,
    private cache: CacheService,
    private config: ConfigService,
  ) {}

  /**
   * Gera um Opaque Token criptograficamente seguro
   */
  generateOpaqueToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Cria hash do token para armazenamento seguro
   */
  private hashToken(token: string): string {
    return crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');
  }

  /**
   * Cria um novo token (access ou refresh)
   */
  async createToken(
    payload: TokenPayload,
    type: 'access' | 'refresh' = 'access',
    metadata?: Record<string, any>,
  ): Promise<TokenInfo> {
    const token = this.generateOpaqueToken();
    const tokenHash = this.hashToken(token);
    const ttl = type === 'access' ? this.ACCESS_TOKEN_TTL : this.REFRESH_TOKEN_TTL;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    // Salvar no banco de dados
    await this.drizzle.db.insert(tokens).values({
      token,
      tokenHash,
      userId: payload.userId,
      tenantId: payload.tenantId,
      type,
      scopes: payload.scopes || [],
      metadata: { ...metadata, ...payload.metadata },
      expiresAt,
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
    });

    // Cachear no Redis apenas se for access token
    if (type === 'access') {
      await this.cacheToken(token, payload, ttl);
    }

    return {
      token,
      userId: payload.userId,
      tenantId: payload.tenantId,
      scopes: payload.scopes,
      type,
      expiresAt,
    };
  }

  /**
   * Valida um token
   */
  async validateToken(token: string): Promise<TokenInfo> {
    // Primeiro, verificar no cache
    const cached = await this.getFromCache(token);
    if (cached) {
      return cached;
    }

    // Se não estiver no cache, buscar no banco
    const tokenHash = this.hashToken(token);
    const [tokenRecord] = await this.drizzle.db
      .select()
      .from(tokens)
      .where(
        and(
          eq(tokens.tokenHash, tokenHash),
          eq(tokens.isRevoked, false),
        ),
      )
      .limit(1);

    if (!tokenRecord) {
      throw new UnauthorizedException('Invalid token');
    }

    // Verificar expiração
    if (new Date() > tokenRecord.expiresAt) {
      throw new UnauthorizedException('Token expired');
    }

    // Atualizar último uso
    await this.drizzle.db
      .update(tokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(tokens.id, tokenRecord.id));

    const tokenInfo: TokenInfo = {
      token,
      userId: tokenRecord.userId,
      tenantId: tokenRecord.tenantId,
      scopes: tokenRecord.scopes as string[],
      type: tokenRecord.type as 'access' | 'refresh',
      expiresAt: tokenRecord.expiresAt,
    };

    // Re-cachear se for access token
    if (tokenRecord.type === 'access') {
      const remainingTTL = Math.floor(
        (tokenRecord.expiresAt.getTime() - Date.now()) / 1000,
      );
      if (remainingTTL > 0) {
        await this.cacheToken(token, tokenInfo, remainingTTL);
      }
    }

    return tokenInfo;
  }

  /**
   * Revoga um token
   */
  async revokeToken(token: string, reason?: string): Promise<void> {
    const tokenHash = this.hashToken(token);

    // Revogar no banco
    await this.drizzle.db
      .update(tokens)
      .set({
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: reason,
      })
      .where(eq(tokens.tokenHash, tokenHash));

    // Remover do cache
    await this.cache.del(`token:${token}`);
    await this.cache.del(`introspect:${token}`);
  }

  /**
   * Cacheia token no Redis
   */
  private async cacheToken(
    token: string,
    payload: TokenPayload,
    ttl: number,
  ): Promise<void> {
    await this.cache.set(
      `token:${token}`,
      JSON.stringify(payload),
      ttl,
    );
  }

  /**
   * Busca token do cache
   */
  private async getFromCache(token: string): Promise<TokenInfo | null> {
    const cached = await this.cache.get<string>(`token:${token}`);
    if (!cached) return null;

    const payload = JSON.parse(cached) as TokenPayload;
    return {
      token,
      ...payload,
      type: 'access',
      expiresAt: new Date(Date.now() + this.ACCESS_TOKEN_TTL * 1000),
    };
  }

  /**
   * Cria par de tokens (access + refresh)
   */
  async createTokenPair(
    payload: TokenPayload,
    metadata?: Record<string, any>,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    const accessToken = await this.createToken(payload, 'access', metadata);
    const refreshToken = await this.createToken(
      payload,
      'refresh',
      metadata,
    );

    // Vincular refresh token ao access token
    await this.drizzle.db
      .update(tokens)
      .set({ refreshTokenId: refreshToken.token })
      .where(eq(tokens.token, accessToken.token));

    return {
      accessToken: accessToken.token,
      refreshToken: refreshToken.token,
      expiresIn: this.ACCESS_TOKEN_TTL,
    };
  }

  /**
   * Refresh de token
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    // Validar refresh token
    const tokenInfo = await this.validateToken(refreshToken);
    
    if (tokenInfo.type !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Revogar o refresh token antigo (token rotation)
    await this.revokeToken(refreshToken, 'Token rotated');

    // Criar novo par de tokens
    return this.createTokenPair({
      userId: tokenInfo.userId,
      tenantId: tokenInfo.tenantId,
      scopes: tokenInfo.scopes,
    });
  }
}
```

## 4. Introspection Service

```typescript
// src/auth/introspection.service.ts
import { Injectable } from '@nestjs/common';
import { TokenService } from './token.service';
import { PermissionService } from '../roles/permission.service';
import { CacheService } from '../cache/cache.service';

export interface IntrospectionResponse {
  active: boolean;
  userId?: string;
  tenantId?: string;
  scopes?: string[];
  permissions?: string[];
  expiresAt?: number;
  iat?: number;
}

@Injectable()
export class IntrospectionService {
  private readonly INTROSPECTION_CACHE_TTL = 120; // 2 minutos

  constructor(
    private tokenService: TokenService,
    private permissionService: PermissionService,
    private cache: CacheService,
  ) {}

  /**
   * Introspect token (endpoint principal)
   */
  async introspect(token: string): Promise<IntrospectionResponse> {
    // Verificar cache de introspection
    const cached = await this.cache.get<IntrospectionResponse>(
      `introspect:${token}`,
    );
    if (cached) {
      return cached;
    }

    try {
      // Validar token
      const tokenInfo = await this.tokenService.validateToken(token);

      // Buscar permissões do usuário (com cache)
      const permissions = await this.permissionService.getUserPermissions(
        tokenInfo.userId,
      );

      const response: IntrospectionResponse = {
        active: true,
        userId: tokenInfo.userId,
        tenantId: tokenInfo.tenantId,
        scopes: tokenInfo.scopes,
        permissions: permissions.map((p) => `${p.resource}:${p.action}`),
        expiresAt: Math.floor(tokenInfo.expiresAt.getTime() / 1000),
        iat: Math.floor(Date.now() / 1000),
      };

      // Cachear resposta
      await this.cache.set(
        `introspect:${token}`,
        response,
        this.INTROSPECTION_CACHE_TTL,
      );

      return response;
    } catch (error) {
      return { active: false };
    }
  }

  /**
   * Batch introspection (múltiplos tokens)
   */
  async introspectBatch(tokens: string[]): Promise<Map<string, IntrospectionResponse>> {
    const results = new Map<string, IntrospectionResponse>();

    await Promise.all(
      tokens.map(async (token) => {
        const result = await this.introspect(token);
        results.set(token, result);
      }),
    );

    return results;
  }
}
```

## 5. Auth Controller

```typescript
// src/auth/auth.controller.ts
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Request,
  Headers,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { IntrospectionService } from './introspection.service';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoginDto, RegisterDto, RefreshDto, IntrospectDto } from './dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private introspectionService: IntrospectionService,
  ) {}

  @Post('register')
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register new user' })
  async register(
    @Body() dto: RegisterDto,
    @Headers('x-forwarded-for') ip?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.register(dto, { ip, userAgent });
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login user' })
  async login(
    @Body() dto: LoginDto,
    @Headers('x-forwarded-for') ip?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.login(dto, { ip, userAgent });
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout user' })
  async logout(@Request() req) {
    await this.authService.logout(req.token);
  }

  @Post('refresh')
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(@Body() dto: RefreshDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  @Post('introspect')
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Introspect token (for services)' })
  async introspect(@Body() dto: IntrospectDto) {
    return this.introspectionService.introspect(dto.token);
  }
}
```

## 6. Cache Service (Redis)

```typescript
// src/cache/cache.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class CacheService implements OnModuleInit {
  private client: Redis;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.config.get('REDIS_HOST'),
      port: this.config.get('REDIS_PORT'),
      password: this.config.get('REDIS_PASSWORD'),
      db: this.config.get('REDIS_DB', 0),
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        return Math.min(times * 50, 2000);
      },
    });
  }

  async get<T = any>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) return null;

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const serialized = typeof value === 'string' 
      ? value 
      : JSON.stringify(value);

    if (ttl) {
      await this.client.setex(key, ttl, serialized);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  async flush(): Promise<void> {
    await this.client.flushdb();
  }

  /**
   * Remember pattern: get from cache or execute callback
   */
  async remember<T>(
    key: string,
    ttl: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await callback();
    await this.set(key, value, ttl);
    return value;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
```

## 7. Environment Variables

```env
# .env.example

# Application
NODE_ENV=development
PORT=3000
APP_NAME=auth-service

# Database (PostgreSQL)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/auth_service

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Security
JWT_SECRET=your-secret-key-change-this
BCRYPT_ROUNDS=10

# Rate Limiting
RATE_LIMIT_LOGIN=10
RATE_LIMIT_WINDOW=3600

# Tokens
ACCESS_TOKEN_TTL=900
REFRESH_TOKEN_TTL=604800
```

## 8. Docker Compose (Development)

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: auth_service
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  auth-service:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://postgres:postgres@postgres:5432/auth_service
      - REDIS_HOST=redis
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - .:/app
      - /app/node_modules

volumes:
  postgres_data:
```

Este guia continua no próximo documento com mais exemplos práticos...
