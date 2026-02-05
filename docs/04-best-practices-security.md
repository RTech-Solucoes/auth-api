# Boas Práticas, Segurança e Performance
## Auth Service

## 1. Segurança em Profundidade

### 1.1 Rate Limiting Implementation

```typescript
// src/auth/guards/rate-limit.guard.ts
import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { CacheService } from '../../cache/cache.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private loginLimiter: RateLimiterRedis;
  private introspectionLimiter: RateLimiterRedis;

  constructor(private cache: CacheService) {
    // Rate limiter para login: 10 tentativas por hora
    this.loginLimiter = new RateLimiterRedis({
      storeClient: (cache as any).client,
      keyPrefix: 'rate_limit:login',
      points: 10, // 10 tentativas
      duration: 3600, // por hora
      blockDuration: 3600, // bloquear por 1 hora se exceder
    });

    // Rate limiter para introspection: 1000 requisições por minuto
    this.introspectionLimiter = new RateLimiterRedis({
      storeClient: (cache as any).client,
      keyPrefix: 'rate_limit:introspect',
      points: 1000,
      duration: 60,
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const ip = request.headers['x-forwarded-for'] || request.ip;
    const endpoint = request.route.path;

    try {
      if (endpoint.includes('/login') || endpoint.includes('/register')) {
        await this.loginLimiter.consume(ip);
      } else if (endpoint.includes('/introspect')) {
        await this.introspectionLimiter.consume(ip);
      }
      return true;
    } catch (error) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests',
          retryAfter: error.msBeforeNext / 1000,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
```

### 1.2 Password Security

```typescript
// src/users/user.service.ts
import * as bcrypt from 'bcrypt';
import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class UserService {
  private readonly SALT_ROUNDS = 12;
  
  /**
   * Password strength validation
   */
  validatePasswordStrength(password: string): void {
    const minLength = 8;
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

    if (password.length < minLength) {
      throw new BadRequestException('Password must be at least 8 characters');
    }

    const strength = [hasUpperCase, hasLowerCase, hasNumbers, hasSpecialChar]
      .filter(Boolean).length;

    if (strength < 3) {
      throw new BadRequestException(
        'Password must contain at least 3 of: uppercase, lowercase, numbers, special characters'
      );
    }

    // Check against common passwords
    const commonPasswords = ['password', '12345678', 'qwerty', 'admin'];
    if (commonPasswords.includes(password.toLowerCase())) {
      throw new BadRequestException('Password is too common');
    }
  }

  /**
   * Hash password with bcrypt
   */
  async hashPassword(password: string): Promise<string> {
    this.validatePasswordStrength(password);
    return bcrypt.hash(password, this.SALT_ROUNDS);
  }

  /**
   * Validate password against hash
   */
  async validatePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Check if password has been pwned (Have I Been Pwned API)
   */
  async checkPasswordPwned(password: string): Promise<boolean> {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
      const text = await response.text();
      return text.includes(suffix);
    } catch {
      return false; // Não bloquear se API falhar
    }
  }
}
```

### 1.3 SQL Injection Prevention

```typescript
// src/users/user.service.ts
// Drizzle ORM já previne SQL injection, mas aqui estão boas práticas

import { eq, and, like, ilike } from 'drizzle-orm';
import { users } from '../db/schema';

@Injectable()
export class UserService {
  constructor(private drizzle: DrizzleService) {}

  /**
   * CORRETO: Usando Drizzle operators
   */
  async findByEmailSafe(email: string, tenantId: string) {
    return this.drizzle.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.email, email),
          eq(users.tenantId, tenantId),
        ),
      )
      .limit(1);
  }

  /**
   * INCORRETO: NUNCA faça isso
   */
  async findByEmailUnsafe(email: string) {
    // ❌ SQL injection vulnerability
    return this.drizzle.db.execute(
      `SELECT * FROM users WHERE email = '${email}'`
    );
  }

  /**
   * Search com sanitização
   */
  async searchUsers(query: string, tenantId: string) {
    // Sanitizar entrada
    const sanitized = query.replace(/[%_]/g, '\\$&');
    
    return this.drizzle.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          ilike(users.email, `%${sanitized}%`),
        ),
      );
  }
}
```

### 1.4 XSS Prevention

```typescript
// src/utils/sanitizer.ts
import * as DOMPurify from 'isomorphic-dompurify';

export class Sanitizer {
  /**
   * Sanitize HTML input
   */
  static sanitizeHtml(dirty: string): string {
    return DOMPurify.sanitize(dirty, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong'],
      ALLOWED_ATTR: [],
    });
  }

  /**
   * Escape special characters
   */
  static escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * Validate and sanitize email
   */
  static sanitizeEmail(email: string): string {
    return email.toLowerCase().trim();
  }
}
```

## 2. Performance Optimization

### 2.1 Database Indexing Strategy

```sql
-- Índices críticos para performance

-- Tokens lookup (mais frequente)
CREATE INDEX CONCURRENTLY idx_tokens_hash_active 
ON tokens (token_hash) 
WHERE is_revoked = false;

-- User authentication
CREATE INDEX CONCURRENTLY idx_users_email_tenant 
ON users (email, tenant_id) 
WHERE deleted_at IS NULL;

-- Permissions lookup
CREATE INDEX CONCURRENTLY idx_user_roles_user 
ON user_roles (user_id) 
WHERE expires_at IS NULL OR expires_at > NOW();

-- Audit queries
CREATE INDEX CONCURRENTLY idx_audit_logs_created 
ON audit_logs (created_at DESC);

-- Partial index para tokens ativos
CREATE INDEX CONCURRENTLY idx_active_tokens 
ON tokens (user_id, expires_at) 
WHERE is_revoked = false AND expires_at > NOW();
```

### 2.2 Query Optimization

```typescript
// src/roles/permission.service.ts
@Injectable()
export class PermissionService {
  constructor(
    private drizzle: DrizzleService,
    private cache: CacheService,
  ) {}

  /**
   * Get user permissions with aggressive caching
   */
  async getUserPermissions(userId: string): Promise<Permission[]> {
    return this.cache.remember(
      `permissions:${userId}`,
      300, // 5 minutos
      async () => {
        // Query otimizada com JOINs
        const result = await this.drizzle.db
          .select({
            id: permissions.id,
            resource: permissions.resource,
            action: permissions.action,
            scope: permissions.scope,
          })
          .from(permissions)
          .innerJoin(rolePermissions, eq(rolePermissions.permissionId, permissions.id))
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(userRoles, eq(userRoles.roleId, roles.id))
          .where(
            and(
              eq(userRoles.userId, userId),
              or(
                isNull(userRoles.expiresAt),
                gt(userRoles.expiresAt, new Date()),
              ),
            ),
          )
          .groupBy(permissions.id);

        return result;
      },
    );
  }

  /**
   * Batch permission check
   */
  async checkPermissionsBatch(
    userId: string,
    checks: Array<{ resource: string; action: string }>,
  ): Promise<Map<string, boolean>> {
    const permissions = await this.getUserPermissions(userId);
    const permissionSet = new Set(
      permissions.map((p) => `${p.resource}:${p.action}`),
    );

    const results = new Map<string, boolean>();
    for (const check of checks) {
      const key = `${check.resource}:${check.action}`;
      results.set(key, permissionSet.has(key));
    }

    return results;
  }
}
```

### 2.3 Connection Pooling

```typescript
// src/db/drizzle.service.ts
@Injectable()
export class DrizzleService {
  async onModuleInit() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,

      // Pool settings otimizado
      max: 20, // Máximo de conexões
      idleTimeoutMillis: 20000, // Milissegundos antes de fechar conexão idle
      connectionTimeoutMillis: 10000, // Timeout de conexão

      // Connection management
      application_name: 'auth-service',
      statement_timeout: 30000, // 30 segundos
    });

    this.db = drizzle({ client: this.pool, schema });
  }
}
```

### 2.4 Caching Strategy

```typescript
// src/cache/cache-manager.ts
@Injectable()
export class CacheManager {
  // TTLs diferentes por tipo de dado
  private readonly TTL = {
    TOKEN: 900,              // 15 min (access token)
    INTROSPECTION: 120,      // 2 min
    PERMISSIONS: 300,        // 5 min
    USER: 600,              // 10 min
    TENANT: 3600,           // 1 hora
    ROLE: 1800,             // 30 min
  };

  constructor(private cache: CacheService) {}

  /**
   * Cache warming - pre-populate cache
   */
  async warmCache(userId: string): Promise<void> {
    await Promise.all([
      this.cacheUser(userId),
      this.cachePermissions(userId),
      this.cacheRoles(userId),
    ]);
  }

  /**
   * Invalidate all related caches
   */
  async invalidateUserCache(userId: string): Promise<void> {
    const keys = [
      `user:${userId}`,
      `permissions:${userId}`,
      `roles:${userId}`,
    ];

    await Promise.all(keys.map((key) => this.cache.del(key)));
  }

  /**
   * Multi-level cache get
   */
  async getWithFallback<T>(
    key: string,
    fallback: () => Promise<T>,
    ttl: number,
  ): Promise<T> {
    // L1: Memory cache (local)
    const localCache = this.getFromLocal(key);
    if (localCache) return localCache;

    // L2: Redis cache
    const redisCache = await this.cache.get<T>(key);
    if (redisCache) {
      this.setInLocal(key, redisCache, 60); // Cache local por 1 min
      return redisCache;
    }

    // L3: Database fallback
    const value = await fallback();
    await this.cache.set(key, value, ttl);
    this.setInLocal(key, value, 60);
    
    return value;
  }

  // Simple in-memory cache (para evitar múltiplas chamadas Redis)
  private localCache = new Map<string, { value: any; expiresAt: number }>();

  private getFromLocal(key: string): any {
    const entry = this.localCache.get(key);
    if (!entry) return null;
    
    if (Date.now() > entry.expiresAt) {
      this.localCache.delete(key);
      return null;
    }
    
    return entry.value;
  }

  private setInLocal(key: string, value: any, ttl: number): void {
    this.localCache.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }
}
```

## 3. Monitoring e Observabilidade

### 3.1 Health Check

```typescript
// src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.checkRedis(),
      () => this.checkDiskSpace(),
    ]);
  }

  @Get('ready')
  ready() {
    return { status: 'ready' };
  }

  @Get('live')
  live() {
    return { status: 'live' };
  }

  private async checkRedis() {
    // Implementar verificação Redis
    return { redis: { status: 'up' } };
  }

  private async checkDiskSpace() {
    // Implementar verificação de disco
    return { disk: { status: 'up' } };
  }
}
```

### 3.2 Metrics com Prometheus

```typescript
// src/metrics/metrics.service.ts
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Gauge, register } from 'prom-client';

@Injectable()
export class MetricsService {
  // Counters
  private authenticationAttempts: Counter;
  private authenticationFailures: Counter;
  private tokenGenerations: Counter;
  private introspectionRequests: Counter;

  // Histograms (latência)
  private authenticationDuration: Histogram;
  private introspectionDuration: Histogram;
  private databaseQueryDuration: Histogram;

  // Gauges
  private activeTokens: Gauge;
  private activeSessions: Gauge;

  constructor() {
    // Initialize metrics
    this.authenticationAttempts = new Counter({
      name: 'auth_attempts_total',
      help: 'Total authentication attempts',
      labelNames: ['status', 'tenant_id'],
    });

    this.authenticationDuration = new Histogram({
      name: 'auth_duration_seconds',
      help: 'Authentication duration in seconds',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    });

    this.introspectionDuration = new Histogram({
      name: 'introspection_duration_seconds',
      help: 'Token introspection duration in seconds',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
    });

    this.activeTokens = new Gauge({
      name: 'active_tokens',
      help: 'Number of active tokens',
    });
  }

  // Record authentication attempt
  recordAuthAttempt(status: 'success' | 'failure', tenantId: string) {
    this.authenticationAttempts.labels(status, tenantId).inc();
  }

  // Record duration
  recordAuthDuration(durationSeconds: number) {
    this.authenticationDuration.observe(durationSeconds);
  }

  // Update gauge
  updateActiveTokens(count: number) {
    this.activeTokens.set(count);
  }

  // Get all metrics
  getMetrics() {
    return register.metrics();
  }
}
```

### 3.3 Logging Estruturado

```typescript
// src/logging/logger.service.ts
import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import * as winston from 'winston';

@Injectable()
export class LoggerService implements NestLoggerService {
  private logger: winston.Logger;

  constructor() {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      defaultMeta: {
        service: 'auth-service',
        environment: process.env.NODE_ENV,
      },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple(),
          ),
        }),
      ],
    });

    // Em produção, adicionar transporte para arquivo
    if (process.env.NODE_ENV === 'production') {
      this.logger.add(
        new winston.transports.File({
          filename: 'logs/error.log',
          level: 'error',
        }),
      );
      this.logger.add(
        new winston.transports.File({
          filename: 'logs/combined.log',
        }),
      );
    }
  }

  log(message: string, context?: string, meta?: any) {
    this.logger.info(message, { context, ...meta });
  }

  error(message: string, trace?: string, context?: string, meta?: any) {
    this.logger.error(message, { trace, context, ...meta });
  }

  warn(message: string, context?: string, meta?: any) {
    this.logger.warn(message, { context, ...meta });
  }

  debug(message: string, context?: string, meta?: any) {
    this.logger.debug(message, { context, ...meta });
  }

  // Log estruturado para auditoria
  logAudit(event: {
    action: string;
    userId?: string;
    tenantId?: string;
    resource?: string;
    result: 'success' | 'failure';
    metadata?: any;
  }) {
    this.logger.info('Audit event', {
      type: 'audit',
      ...event,
    });
  }

  // Log de performance
  logPerformance(event: {
    operation: string;
    duration: number;
    metadata?: any;
  }) {
    this.logger.info('Performance metric', {
      type: 'performance',
      ...event,
    });
  }
}
```

## 4. Testes

### 4.1 Unit Tests

```typescript
// src/auth/token.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { TokenService } from './token.service';
import { DrizzleService } from '../db/drizzle.service';
import { CacheService } from '../cache/cache.service';

describe('TokenService', () => {
  let service: TokenService;
  let drizzle: DrizzleService;
  let cache: CacheService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: DrizzleService,
          useValue: {
            db: {
              insert: jest.fn(),
              select: jest.fn(),
              update: jest.fn(),
            },
          },
        },
        {
          provide: CacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
    drizzle = module.get<DrizzleService>(DrizzleService);
    cache = module.get<CacheService>(CacheService);
  });

  describe('generateOpaqueToken', () => {
    it('should generate a unique token', () => {
      const token1 = service.generateOpaqueToken();
      const token2 = service.generateOpaqueToken();

      expect(token1).toBeDefined();
      expect(token2).toBeDefined();
      expect(token1).not.toBe(token2);
      expect(token1.length).toBeGreaterThan(32);
    });
  });

  describe('createToken', () => {
    it('should create and cache access token', async () => {
      const payload = {
        userId: 'user-123',
        tenantId: 'tenant-123',
        scopes: ['read', 'write'],
      };

      jest.spyOn(drizzle.db, 'insert').mockResolvedValue(undefined);
      jest.spyOn(cache, 'set').mockResolvedValue();

      const result = await service.createToken(payload, 'access');

      expect(result.token).toBeDefined();
      expect(result.userId).toBe(payload.userId);
      expect(result.type).toBe('access');
      expect(cache.set).toHaveBeenCalled();
    });
  });
});
```

### 4.2 Integration Tests

```typescript
// test/auth.e2e-spec.ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('/auth/register (POST)', () => {
    it('should register a new user', () => {
      return request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'Test@1234',
          firstName: 'Test',
          lastName: 'User',
          tenantId: 'tenant-123',
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.accessToken).toBeDefined();
          expect(res.body.refreshToken).toBeDefined();
        });
    });
  });

  describe('/auth/login (POST)', () => {
    it('should login and return tokens', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'test@example.com',
          password: 'Test@1234',
          tenantId: 'tenant-123',
        })
        .expect(200)
        .expect((res) => {
          expect(res.body.accessToken).toBeDefined();
          expect(res.body.refreshToken).toBeDefined();
          accessToken = res.body.accessToken;
        });
    });

    it('should reject invalid credentials', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'test@example.com',
          password: 'wrongpassword',
          tenantId: 'tenant-123',
        })
        .expect(401);
    });
  });

  describe('/auth/introspect (POST)', () => {
    it('should validate token', () => {
      return request(app.getHttpServer())
        .post('/auth/introspect')
        .send({ token: accessToken })
        .expect(200)
        .expect((res) => {
          expect(res.body.active).toBe(true);
          expect(res.body.userId).toBeDefined();
        });
    });

    it('should reject invalid token', () => {
      return request(app.getHttpServer())
        .post('/auth/introspect')
        .send({ token: 'invalid-token' })
        .expect(200)
        .expect((res) => {
          expect(res.body.active).toBe(false);
        });
    });
  });
});
```

## 5. Checklist de Produção

### Antes do Deploy

- [ ] Todas as variáveis de ambiente configuradas
- [ ] Secrets rotacionados e seguros
- [ ] Database migrations testadas
- [ ] Backups configurados e testados
- [ ] Monitoramento e alertas ativos
- [ ] Logs centralizados configurados
- [ ] Rate limiting configurado
- [ ] SSL/TLS certificados válidos
- [ ] Health checks respondendo
- [ ] Load tests executados
- [ ] Documentação atualizada
- [ ] Rollback plan definido

### Checklist de Segurança

- [ ] Senhas com hash bcrypt (12+ rounds)
- [ ] Rate limiting em todos endpoints sensíveis
- [ ] CORS configurado corretamente
- [ ] Helmet middleware ativo
- [ ] SQL injection protection (Drizzle)
- [ ] XSS protection
- [ ] CSRF tokens (se aplicável)
- [ ] Input validation com class-validator
- [ ] Audit logs completos
- [ ] Token rotation implementado
- [ ] 2FA disponível
- [ ] IP whitelisting para introspection
- [ ] mTLS entre serviços (produção)

### Performance Checklist

- [ ] Índices de banco criados
- [ ] Connection pooling configurado
- [ ] Cache strategy implementada
- [ ] Query optimization validada
- [ ] CDN para assets (se aplicável)
- [ ] Compression habilitado
- [ ] Keep-alive connections
- [ ] Health checks configurados
