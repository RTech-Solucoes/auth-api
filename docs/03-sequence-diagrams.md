# Diagramas de Sequência - Fluxos de Execução
## Auth Service

## 1. Fluxo de Login e Autenticação

```mermaid
sequenceDiagram
    participant Client as Cliente
    participant Gateway as API Gateway
    participant AuthCtrl as AuthController
    participant AuthSvc as AuthService
    participant UserSvc as UserService
    participant TokenSvc as TokenService
    participant Redis as Redis Cache
    participant DB as PostgreSQL
    participant AuditSvc as AuditService
    
    Client->>Gateway: POST /auth/login<br/>{email, password}
    Gateway->>AuthCtrl: login(dto)
    
    AuthCtrl->>AuthSvc: validateUser(email, password)
    AuthSvc->>UserSvc: findByEmail(email, tenantId)
    UserSvc->>DB: SELECT * FROM users
    DB-->>UserSvc: user data
    
    UserSvc->>UserSvc: validatePassword(password, hash)
    UserSvc-->>AuthSvc: validated user
    
    AuthSvc->>TokenSvc: generateOpaqueToken()
    TokenSvc->>TokenSvc: crypto.randomBytes(32)
    TokenSvc-->>AuthSvc: opaqueToken
    
    AuthSvc->>TokenSvc: createToken(user, metadata)
    TokenSvc->>DB: INSERT INTO tokens
    DB-->>TokenSvc: token saved
    
    TokenSvc->>Redis: SET token:{token}<br/>{userId, tenantId, scopes}<br/>EX 900
    Redis-->>TokenSvc: OK
    
    TokenSvc-->>AuthSvc: token created
    
    AuthSvc->>AuditSvc: logLogin(userId, ip, success)
    AuditSvc->>DB: INSERT INTO audit_logs (async)
    
    AuthSvc-->>AuthCtrl: {access_token, refresh_token}
    AuthCtrl-->>Gateway: 200 OK
    Gateway-->>Client: AuthResponse
    
    Note over Client,DB: Token válido por 15 minutos<br/>Refresh token válido por 7 dias
```

## 2. Fluxo de Introspection (Token Validation)

```mermaid
sequenceDiagram
    participant Service as Microserviço
    participant Gateway as API Gateway
    participant IntrospectCtrl as IntrospectionController
    participant IntrospectSvc as IntrospectionService
    participant TokenSvc as TokenService
    participant PermSvc as PermissionService
    participant Redis as Redis Cache
    participant DB as PostgreSQL
    
    Service->>Gateway: POST /auth/introspect<br/>{token}
    Gateway->>IntrospectCtrl: introspect(token)
    
    IntrospectCtrl->>IntrospectSvc: introspectToken(token)
    
    %% Verificação em cache
    IntrospectSvc->>Redis: GET introspect:{token}
    alt Cache Hit
        Redis-->>IntrospectSvc: cached response
        IntrospectSvc-->>IntrospectCtrl: IntrospectionResponse
        IntrospectCtrl-->>Gateway: 200 OK
        Gateway-->>Service: {active: true, user_id, tenant_id}
    else Cache Miss
        Redis-->>IntrospectSvc: null
        
        %% Validação do token
        IntrospectSvc->>TokenSvc: validateToken(token)
        TokenSvc->>Redis: GET token:{token}
        
        alt Token em Redis
            Redis-->>TokenSvc: token data
        else Token não em Redis
            TokenSvc->>DB: SELECT * FROM tokens WHERE token=?
            DB-->>TokenSvc: token record
        end
        
        TokenSvc->>TokenSvc: checkExpiration()
        TokenSvc->>TokenSvc: checkRevoked()
        TokenSvc-->>IntrospectSvc: validated token
        
        %% Buscar permissões
        IntrospectSvc->>PermSvc: getUserPermissions(userId)
        PermSvc->>Redis: GET permissions:{userId}
        
        alt Permissions cached
            Redis-->>PermSvc: cached permissions
        else Permissions not cached
            PermSvc->>DB: SELECT permissions<br/>JOIN user_roles, role_permissions
            DB-->>PermSvc: permissions list
            PermSvc->>Redis: SET permissions:{userId}<br/>EX 300
        end
        
        PermSvc-->>IntrospectSvc: user permissions
        
        %% Construir resposta
        IntrospectSvc->>IntrospectSvc: buildResponse(token, permissions)
        
        %% Cachear resposta
        IntrospectSvc->>Redis: SET introspect:{token}<br/>{active, user_id, tenant_id, scopes}<br/>EX 120
        
        IntrospectSvc-->>IntrospectCtrl: IntrospectionResponse
        IntrospectCtrl-->>Gateway: 200 OK
        Gateway-->>Service: {active: true, ...}
    end
    
    Note over Service,DB: Cache de introspection: 2 minutos<br/>Cache de permissões: 5 minutos
```

## 3. Fluxo de Request com Autorização

```mermaid
sequenceDiagram
    participant Client as Cliente
    participant Gateway as API Gateway
    participant Service as Microserviço
    participant LocalCache as Cache Local
    participant AuthService as Auth Service
    participant PermSvc as PermissionService
    
    Client->>Gateway: GET /api/users<br/>Authorization: Bearer {token}
    Gateway->>Service: request with token
    
    Service->>LocalCache: get(introspect:{token})
    alt Cache Hit (local)
        LocalCache-->>Service: cached introspection
    else Cache Miss (local)
        Service->>AuthService: POST /introspect {token}
        AuthService-->>Service: {active, user_id, tenant_id, scopes}
        Service->>LocalCache: set(introspect:{token}, data, 60s)
    end
    
    Service->>Service: extract required permission<br/>("users:read")
    
    Service->>LocalCache: get(permissions:{user_id})
    alt Permissions cached
        LocalCache-->>Service: cached permissions
    else Permissions not cached
        Service->>AuthService: GET /permissions/{user_id}
        AuthService->>PermSvc: getUserPermissions(user_id)
        PermSvc-->>AuthService: permissions array
        AuthService-->>Service: permissions
        Service->>LocalCache: set(permissions:{user_id}, data, 300s)
    end
    
    Service->>Service: checkPermission("users:read")
    
    alt Has Permission
        Service->>Service: process request
        Service-->>Gateway: 200 OK + data
        Gateway-->>Client: response
    else No Permission
        Service-->>Gateway: 403 Forbidden
        Gateway-->>Client: error response
    end
    
    Note over Client,PermSvc: Cache local evita chamadas<br/>desnecessárias ao Auth Service
```

## 4. Fluxo de Refresh Token

```mermaid
sequenceDiagram
    participant Client as Cliente
    participant Gateway as API Gateway
    participant AuthCtrl as AuthController
    participant AuthSvc as AuthService
    participant TokenSvc as TokenService
    participant Redis as Redis Cache
    participant DB as PostgreSQL
    
    Client->>Gateway: POST /auth/refresh<br/>{refresh_token}
    Gateway->>AuthCtrl: refresh(refreshToken)
    
    AuthCtrl->>AuthSvc: refreshAccessToken(refreshToken)
    AuthSvc->>TokenSvc: validateToken(refreshToken, 'refresh')
    
    TokenSvc->>DB: SELECT * FROM tokens<br/>WHERE token=? AND type='refresh'
    DB-->>TokenSvc: refresh token record
    
    TokenSvc->>TokenSvc: checkExpiration()
    TokenSvc->>TokenSvc: checkRevoked()
    
    alt Token válido
        TokenSvc-->>AuthSvc: validated refresh token
        
        %% Revogar refresh token antigo (rotation)
        AuthSvc->>TokenSvc: revokeToken(oldRefreshToken)
        TokenSvc->>DB: UPDATE tokens SET is_revoked=true
        TokenSvc->>Redis: DEL token:{oldRefreshToken}
        
        %% Gerar novos tokens
        AuthSvc->>TokenSvc: generateOpaqueToken()
        TokenSvc-->>AuthSvc: new access token
        
        AuthSvc->>TokenSvc: generateOpaqueToken()
        TokenSvc-->>AuthSvc: new refresh token
        
        %% Salvar novos tokens
        AuthSvc->>TokenSvc: createToken(userId, 'access')
        TokenSvc->>DB: INSERT INTO tokens
        TokenSvc->>Redis: SET token:{newAccessToken}
        
        AuthSvc->>TokenSvc: createToken(userId, 'refresh')
        TokenSvc->>DB: INSERT INTO tokens
        
        AuthSvc-->>AuthCtrl: {access_token, refresh_token}
        AuthCtrl-->>Gateway: 200 OK
        Gateway-->>Client: new tokens
    else Token inválido
        TokenSvc-->>AuthSvc: invalid token error
        AuthSvc-->>AuthCtrl: error
        AuthCtrl-->>Gateway: 401 Unauthorized
        Gateway-->>Client: error response
    end
    
    Note over Client,DB: Refresh token rotation<br/>previne reutilização
```

## 5. Fluxo de Atribuição de Permissões

```mermaid
sequenceDiagram
    participant Admin as Admin User
    participant Gateway as API Gateway
    participant RoleCtrl as RoleController
    participant RoleSvc as RoleService
    participant PermSvc as PermissionService
    participant Redis as Redis Cache
    participant DB as PostgreSQL
    participant AuditSvc as AuditService
    
    Admin->>Gateway: POST /roles/{roleId}/permissions<br/>{permission_ids}
    Gateway->>RoleCtrl: assignPermissions(roleId, dto)
    
    RoleCtrl->>RoleSvc: assignPermissions(roleId, permissionIds)
    
    %% Iniciar transação
    RoleSvc->>DB: BEGIN TRANSACTION
    
    loop Para cada permissionId
        RoleSvc->>PermSvc: findById(permissionId)
        PermSvc->>DB: SELECT * FROM permissions
        DB-->>PermSvc: permission
        PermSvc-->>RoleSvc: validated permission
        
        RoleSvc->>DB: INSERT INTO role_permissions<br/>(role_id, permission_id)
    end
    
    RoleSvc->>DB: COMMIT TRANSACTION
    DB-->>RoleSvc: success
    
    %% Invalidar cache de permissões
    RoleSvc->>PermSvc: invalidatePermissionsCache(roleId)
    
    PermSvc->>DB: SELECT user_id FROM user_roles<br/>WHERE role_id=?
    DB-->>PermSvc: affected user IDs
    
    loop Para cada userId
        PermSvc->>Redis: DEL permissions:{userId}
        Redis-->>PermSvc: OK
    end
    
    %% Auditoria
    RoleSvc->>AuditSvc: logPermissionChange(roleId, permissions)
    AuditSvc->>DB: INSERT INTO audit_logs (async)
    
    RoleSvc-->>RoleCtrl: success
    RoleCtrl-->>Gateway: 200 OK
    Gateway-->>Admin: success response
    
    Note over Admin,DB: Cache invalidado para<br/>forçar reload das permissões
```

## 6. Fluxo de Logout e Revogação de Token

```mermaid
sequenceDiagram
    participant Client as Cliente
    participant Gateway as API Gateway
    participant AuthCtrl as AuthController
    participant AuthSvc as AuthService
    participant TokenSvc as TokenService
    participant SessionSvc as SessionService
    participant Redis as Redis Cache
    participant DB as PostgreSQL
    
    Client->>Gateway: POST /auth/logout<br/>Authorization: Bearer {token}
    Gateway->>AuthCtrl: logout(token)
    
    AuthCtrl->>AuthSvc: logout(token)
    
    %% Revogar access token
    AuthSvc->>TokenSvc: revokeToken(token)
    TokenSvc->>DB: UPDATE tokens<br/>SET is_revoked=true, revoked_at=NOW()
    TokenSvc->>Redis: DEL token:{token}
    TokenSvc->>Redis: DEL introspect:{token}
    
    %% Buscar e revogar refresh token relacionado
    TokenSvc->>DB: SELECT refresh_token_id FROM tokens<br/>WHERE token=?
    DB-->>TokenSvc: refresh_token_id
    
    TokenSvc->>DB: UPDATE tokens<br/>SET is_revoked=true WHERE id=?
    TokenSvc->>Redis: DEL token:{refreshToken}
    
    %% Revogar sessão
    AuthSvc->>SessionSvc: revokeSession(userId, sessionToken)
    SessionSvc->>DB: UPDATE sessions<br/>SET is_active=false
    SessionSvc->>Redis: DEL session:{sessionToken}
    
    AuthSvc-->>AuthCtrl: logout successful
    AuthCtrl-->>Gateway: 200 OK
    Gateway-->>Client: logged out
    
    Note over Client,DB: Logout revoga todos tokens<br/>e invalida cache imediatamente
```

## Tempos de Resposta Esperados

| Operação | Target | Máximo Aceitável |
|----------|--------|------------------|
| Login | < 100ms | 300ms |
| Introspection (cache hit) | < 10ms | 50ms |
| Introspection (cache miss) | < 50ms | 150ms |
| Refresh Token | < 80ms | 200ms |
| Logout | < 50ms | 150ms |
| Permission Check | < 20ms | 100ms |

## Estratégias de Otimização

### 1. Cache Multi-Camada
- **L1**: Cache local nos microserviços (1-2 min)
- **L2**: Redis centralizado (5-15 min)
- **L3**: Banco de dados

### 2. Connection Pooling
- PostgreSQL: pool de 20 conexões
- Redis: pool de 10 conexões

### 3. Batch Operations
- Introspection de múltiplos tokens em uma chamada
- Verificação de múltiplas permissões simultaneamente

### 4. Async Processing
- Auditoria em background (não bloqueia response)
- Notificações assíncronas
- Limpeza de tokens expirados

### 5. Query Optimization
- Índices estratégicos
- Materialized views para permissões
- Prepared statements
