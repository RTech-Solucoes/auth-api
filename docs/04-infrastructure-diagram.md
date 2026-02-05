# Diagrama de Infraestrutura
## Auth Service - Docker Compose

```mermaid
graph TB
    subgraph Internet["Internet"]
        Client[Cliente Web/Mobile]
        Service1[Microserviço 1]
        Service2[Microserviço 2]
        ServiceN[Microserviço N]
    end

    subgraph DockerCompose["Docker Compose"]

        subgraph AppContainer["Auth Service Container"]
            AuthApp[Auth Service<br/>NestJS + Node.js 20<br/>Port: 3000]
        end

        subgraph PostgresContainer["PostgreSQL Container"]
            Postgres[PostgreSQL 16 Alpine<br/>Port: 5432<br/>Volume: postgres_data]
        end

        subgraph RedisContainer["Redis Container"]
            Redis[Redis 7 Alpine<br/>Port: 6379]
        end
    end

    %% Conexões
    Client --> AuthApp
    Service1 --> AuthApp
    Service2 --> AuthApp
    ServiceN --> AuthApp

    AuthApp --> Postgres
    AuthApp --> Redis

    style AppContainer fill:#4ecdc4
    style PostgresContainer fill:#95e1d3
    style RedisContainer fill:#f38181
```

## Dockerfile

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 3000

USER node

CMD ["node", "dist/main"]
```

## Docker Compose

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
      - REDIS_PORT=6379
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

## Arquitetura de Rede

```mermaid
graph LR
    subgraph External["Rede Externa"]
        Clients[Clientes / Microserviços]
    end

    subgraph DockerNetwork["Docker Network (bridge)"]
        AuthApp[Auth Service<br/>:3000]
        Postgres[PostgreSQL<br/>:5432]
        Redis[Redis<br/>:6379]
    end

    Clients --> AuthApp
    AuthApp --> Postgres
    AuthApp --> Redis

    style External fill:#ff6b6b
    style DockerNetwork fill:#4ecdc4
```

> Em produção, a infraestrutura de rede (load balancer, WAF, API Gateway, etc.) fica por conta do time de DevOps.

## Health Checks

A aplicação expõe endpoints de health check que podem ser usados pelo Docker Compose e por qualquer orquestrador:

| Endpoint | Descrição |
|----------|-----------|
| `GET /health` | Verifica se a aplicação, banco e Redis estão saudáveis |
| `GET /health/ready` | Indica que a aplicação está pronta para receber tráfego |
| `GET /health/live` | Indica que a aplicação está ativa |
