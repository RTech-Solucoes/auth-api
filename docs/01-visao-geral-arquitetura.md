# Arquitetura do Microserviço de Autenticação
## RTech Solution - Auth Service

### 1. Visão Geral

Sistema centralizado de autenticação e autorização baseado em **Opaque Tokens** com introspection para múltiplos serviços SaaS multi-tenant.

### 2. Objetivos Principais

- ✅ Centralizar gerenciamento de usuários, tenants, projetos, perfis e permissões
- ✅ Evitar sobrecarga do JWT com permissões extensas
- ✅ Implementar autenticação baseada em Opaque Tokens + Introspection
- ✅ Garantir escalabilidade horizontal
- ✅ Implementar cache inteligente para reduzir latência
- ✅ Suportar multi-tenancy com isolamento de dados
- ✅ Segurança em múltiplas camadas

### 3. Stack Tecnológico

**Backend:**
- Node.js 20 LTS
- NestJS 10.x (Framework)
- Drizzle ORM (Database)
- PostgreSQL 16 (Database principal)
- Redis 7.x (Cache & Session Store)

**Segurança:**
- bcrypt (Hash de senhas)
- crypto (Geração de tokens opacos)
- helmet (Segurança HTTP)
- rate-limiter-flexible (Rate limiting)

**Infraestrutura:**
- Docker & Docker Compose
- Prometheus + Grafana (Monitoramento)

### 4. Componentes Principais

#### 4.1 Auth Service (Core)
Responsável por:
- Autenticação de usuários
- Geração e validação de Opaque Tokens
- Endpoint de Introspection
- Gerenciamento de sessões

#### 4.2 User Management Service
Responsável por:
- CRUD de usuários
- Gerenciamento de perfis
- Atribuição de permissões
- Auditoria de acessos

#### 4.3 Tenant Management Service
Responsável por:
- CRUD de clientes (tenants)
- Configurações por tenant
- Projetos por tenant
- Isolamento de dados

#### 4.4 Authorization Service
Responsável por:
- Gerenciamento de perfis (roles)
- Gerenciamento de permissões
- Avaliação de políticas (RBAC + ABAC)
- Cache de permissões

### 5. Modelo de Autenticação: Opaque Token + Introspection

#### 5.1 Fluxo de Autenticação

```
1. Cliente envia credenciais → Auth Service
2. Auth Service valida credenciais
3. Auth Service gera Opaque Token (UUID v4 + hash)
4. Token armazenado no Redis com metadados mínimos
5. Cliente recebe: { access_token, refresh_token, expires_in }
```

#### 5.2 Fluxo de Introspection

```
1. Serviço recebe request com Opaque Token
2. Serviço consulta Auth Service /introspect endpoint
3. Auth Service verifica token no Redis/DB
4. Auth Service retorna: { active, user_id, tenant_id, scopes }
5. Serviço consulta cache local de permissões
6. Serviço processa request baseado em permissões
```

#### 5.3 Vantagens do Opaque Token

- ✅ **Revogação instantânea**: Tokens podem ser invalidados imediatamente
- ✅ **JWT leve**: Não carrega permissões, apenas identificadores
- ✅ **Flexibilidade**: Permissões podem mudar sem re-emitir tokens
- ✅ **Auditoria**: Cada uso do token pode ser registrado
- ✅ **Segurança**: Token não expõe informações sensíveis

### 6. Estratégia de Cache Multi-Camada

#### Camada 1: Redis Centralizado
```
- Tokens ativos (TTL baseado em expiração)
- Sessões de usuários
- Rate limiting
- TTL: 15 minutos (access_token)
```

#### Camada 2: Cache de Permissões (Redis)
```
- Permissões por usuário/tenant
- Perfis e suas permissões
- TTL: 5 minutos
- Invalidação em mudanças
```

#### Camada 3: Cache Local (Serviços)
```
- Resultados de introspection (1-2 minutos)
- Reduz chamadas ao Auth Service
- In-memory cache (Node.js)
```

### 7. Segurança

#### 7.1 Camadas de Segurança

1. **Rate Limiting**: 
   - 10 tentativas de login por IP/hora
   - 100 requisições de introspection por serviço/minuto

2. **Token Security**:
   - Tokens criptograficamente seguros (crypto.randomBytes)
   - Refresh token rotation
   - Token binding (IP + User-Agent)

3. **Database Security**:
   - Row-level security (RLS) no PostgreSQL
   - Criptografia em repouso
   - Conexões SSL/TLS

4. **Network Security**:
   - mTLS entre serviços
   - API Gateway com WAF
   - Allowlist de IPs para introspection

5. **Auditoria**:
   - Log de todas autenticações
   - Log de mudanças de permissões
   - Detecção de anomalias

### 8. Escalabilidade

#### 8.1 Horizontal Scaling

- **Stateless Services**: Todas instâncias são intercambiáveis
- **Load Balancing**: NGINX com least-connections
- **Database Read Replicas**: Leitura distribuída
- **Redis Cluster**: Sharding automático

#### 8.2 Performance

- **Connection Pooling**: 
  - PostgreSQL: 20 conexões por instância (recomendado)
  - Redis: 10 conexões por instância (recomendado)

- **Batch Operations**: 
  - Introspection de múltiplos tokens
  - Bulk permission checks

- **Async Processing**: 
  - Auditoria assíncrona
  - Email/notificações em background

### 9. Métricas e Observabilidade

**Métricas Chave:**
- Latência de autenticação (target: < 100ms)
- Latência de introspection (target: < 50ms)
- Taxa de cache hit (target: > 90%)
- Taxa de erro (target: < 0.1%)
- Tokens ativos simultâneos
- Requisições por segundo (RPS)

**Logs Estruturados:**
- Formato JSON
- Correlation IDs
- Níveis: ERROR, WARN, INFO, DEBUG

**Alertas:**
- Alta latência (> 500ms)
- Taxa de erro > 1%
- Cache miss rate > 20%
- Uso de memória > 80%

### 10. Infraestrutura Proposta

#### 10.1 Ambientes

**Desenvolvimento:**
- Docker Compose local
- 1 instância de cada serviço
- Redis single node
- PostgreSQL single node

**Staging/Produção:**
- Infraestrutura gerenciada pelo time de DevOps

#### 10.2 Recursos Estimados (Por Instância)

**Auth Service:**
- CPU: 500m (0.5 core)
- Memory: 512Mi
- Auto-scaling: 2-10 réplicas

**Database:**
- CPU: 2 cores
- Memory: 4Gi
- Storage: 100Gi SSD

**Redis:**
- CPU: 1 core
- Memory: 2Gi

### 11. Roadmap de Implementação

**Fase 1 :**
- Setup projeto NestJS
- Configuração Drizzle + PostgreSQL
- Schema do banco de dados
- Modelos e migrações

**Fase 2 :**
- Implementação de autenticação
- Geração de Opaque Tokens
- Endpoint de introspection
- Integração com Redis

**Fase 3 :**
- User Management Service
- Tenant Management Service
- Authorization Service
- RBAC implementation

**Fase 4 :**
- Cache multi-camada
- Rate limiting
- Auditoria e logs
- Testes automatizados

**Fase 5 :**
- Docker configs
- CI/CD pipeline
- Monitoramento
- Documentação

### 12. Considerações Finais

Este microserviço centralizado oferece:

- **Escalabilidade**: Suporta crescimento horizontal sem limite
- **Performance**: Cache inteligente reduz latência
- **Segurança**: Múltiplas camadas de proteção
- **Flexibilidade**: Fácil adicionar novos serviços
- **Manutenibilidade**: Código limpo com NestJS
- **Observabilidade**: Métricas e logs completos

O modelo de Opaque Token com introspection resolve o problema de JWT pesado mantendo performance através de cache agressivo e arquitetura bem planejada.
