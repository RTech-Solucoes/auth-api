# Database Schema - Auth Service
## Drizzle ORM + PostgreSQL

### Schema Completo

```typescript
// src/db/schema.ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ============================================
// ENUMS
// ============================================

export const userStatusEnum = pgEnum('user_status', [
  'active',
  'inactive',
  'suspended',
  'pending_verification',
]);

export const tenantStatusEnum = pgEnum('tenant_status', [
  'active',
  'trial',
  'suspended',
  'cancelled',
]);

export const tokenTypeEnum = pgEnum('token_type', [
  'access',
  'refresh',
  'reset_password',
  'email_verification',
]);

export const permissionTypeEnum = pgEnum('permission_type', [
  'read',
  'write',
  'delete',
  'admin',
]);

// ============================================
// TENANTS (Clientes)
// ============================================

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull().unique(),
    domain: varchar('domain', { length: 255 }),
    status: tenantStatusEnum('status').notNull().default('trial'),
    
    // Configurações
    settings: jsonb('settings').default({}),
    features: jsonb('features').default({}),
    
    // Limites
    maxUsers: integer('max_users').default(10),
    maxProjects: integer('max_projects').default(5),
    
    // Datas
    trialEndsAt: timestamp('trial_ends_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    slugIdx: uniqueIndex('tenant_slug_idx').on(table.slug),
    statusIdx: index('tenant_status_idx').on(table.status),
  })
);

// ============================================
// USERS (Usuários)
// ============================================

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    
    // Credenciais
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    
    // Informações pessoais
    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    phoneNumber: varchar('phone_number', { length: 20 }),
    avatar: text('avatar'),
    
    // Status
    status: userStatusEnum('status').notNull().default('pending_verification'),
    emailVerified: boolean('email_verified').notNull().default(false),
    emailVerifiedAt: timestamp('email_verified_at'),
    
    // Segurança
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    twoFactorSecret: varchar('two_factor_secret', { length: 255 }),
    
    // Metadata
    lastLoginAt: timestamp('last_login_at'),
    lastLoginIp: varchar('last_login_ip', { length: 45 }),
    failedLoginAttempts: integer('failed_login_attempts').default(0),
    lockedUntil: timestamp('locked_until'),
    
    // Datas
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    emailTenantIdx: uniqueIndex('user_email_tenant_idx').on(table.email, table.tenantId),
    tenantIdx: index('user_tenant_idx').on(table.tenantId),
    statusIdx: index('user_status_idx').on(table.status),
  })
);

// ============================================
// PROJECTS (Projetos por Tenant)
// ============================================

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    slug: varchar('slug', { length: 100 }).notNull(),
    
    // Configurações
    settings: jsonb('settings').default({}),
    
    // Status
    isActive: boolean('is_active').notNull().default(true),
    
    // Datas
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    slugTenantIdx: uniqueIndex('project_slug_tenant_idx').on(table.slug, table.tenantId),
    tenantIdx: index('project_tenant_idx').on(table.tenantId),
  })
);

// ============================================
// ROLES (Perfis)
// ============================================

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' }),
    
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    description: text('description'),
    
    // Tipo de role
    isSystemRole: boolean('is_system_role').notNull().default(false), // ex: super_admin
    isDefault: boolean('is_default').notNull().default(false), // role padrão ao criar usuário
    
    // Hierarquia
    priority: integer('priority').default(0), // Maior = mais poder
    
    // Datas
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    slugTenantIdx: uniqueIndex('role_slug_tenant_idx').on(table.slug, table.tenantId),
    tenantIdx: index('role_tenant_idx').on(table.tenantId),
  })
);

// ============================================
// PERMISSIONS (Permissões)
// ============================================

export const permissions = pgTable(
  'permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    
    resource: varchar('resource', { length: 100 }).notNull(), // ex: 'users', 'projects'
    action: varchar('action', { length: 50 }).notNull(), // ex: 'read', 'write', 'delete'
    scope: varchar('scope', { length: 100 }), // ex: 'own', 'team', 'all'
    
    description: text('description'),
    
    // Datas
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    resourceActionIdx: uniqueIndex('permission_resource_action_idx').on(
      table.resource,
      table.action,
      table.scope
    ),
  })
);

// ============================================
// ROLE_PERMISSIONS (Permissões dos Perfis)
// ============================================

export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    
    // Condições adicionais (ABAC)
    conditions: jsonb('conditions').default({}),
    
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    rolePermissionIdx: uniqueIndex('role_permission_idx').on(table.roleId, table.permissionId),
    roleIdx: index('role_permission_role_idx').on(table.roleId),
    permissionIdx: index('role_permission_permission_idx').on(table.permissionId),
  })
);

// ============================================
// USER_ROLES (Usuários x Perfis)
// ============================================

export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .references(() => projects.id, { onDelete: 'cascade' }), // Opcional: role por projeto
    
    // Datas
    assignedAt: timestamp('assigned_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at'), // Role temporária
  },
  (table) => ({
    userRoleIdx: uniqueIndex('user_role_idx').on(table.userId, table.roleId, table.projectId),
    userIdx: index('user_role_user_idx').on(table.userId),
    roleIdx: index('user_role_role_idx').on(table.roleId),
  })
);

// ============================================
// USER_PROJECT_ACCESS (Acesso a Projetos)
// ============================================

export const userProjectAccess = pgTable(
  'user_project_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    
    // Permissões específicas do projeto
    canRead: boolean('can_read').notNull().default(true),
    canWrite: boolean('can_write').notNull().default(false),
    canDelete: boolean('can_delete').notNull().default(false),
    canAdmin: boolean('can_admin').notNull().default(false),
    
    // Datas
    grantedAt: timestamp('granted_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at'),
  },
  (table) => ({
    userProjectIdx: uniqueIndex('user_project_idx').on(table.userId, table.projectId),
    userIdx: index('user_project_access_user_idx').on(table.userId),
    projectIdx: index('user_project_access_project_idx').on(table.projectId),
  })
);

// ============================================
// TOKENS (Opaque Tokens)
// ============================================

export const tokens = pgTable(
  'tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    
    // Token
    token: varchar('token', { length: 255 }).notNull().unique(),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    type: tokenTypeEnum('type').notNull().default('access'),
    
    // Metadata
    scopes: jsonb('scopes').default([]),
    metadata: jsonb('metadata').default({}),
    
    // Segurança
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    
    // Refresh token (se type = access)
    refreshTokenId: uuid('refresh_token_id'),
    
    // Status
    isRevoked: boolean('is_revoked').notNull().default(false),
    revokedAt: timestamp('revoked_at'),
    revokedReason: text('revoked_reason'),
    
    // Datas
    expiresAt: timestamp('expires_at').notNull(),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    tokenIdx: uniqueIndex('token_idx').on(table.token),
    tokenHashIdx: index('token_hash_idx').on(table.tokenHash),
    userIdx: index('token_user_idx').on(table.userId),
    expiresIdx: index('token_expires_idx').on(table.expiresAt),
    typeIdx: index('token_type_idx').on(table.type),
  })
);

// ============================================
// AUDIT_LOGS (Auditoria)
// ============================================

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    
    // Ação
    action: varchar('action', { length: 100 }).notNull(), // ex: 'user.login', 'permission.granted'
    resource: varchar('resource', { length: 100 }), // ex: 'user', 'role'
    resourceId: uuid('resource_id'),
    
    // Detalhes
    details: jsonb('details').default({}),
    changes: jsonb('changes').default({}), // Before/after
    
    // Request info
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    
    // Status
    status: varchar('status', { length: 20 }).notNull(), // success, failed
    errorMessage: text('error_message'),
    
    // Data
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index('audit_tenant_idx').on(table.tenantId),
    userIdx: index('audit_user_idx').on(table.userId),
    actionIdx: index('audit_action_idx').on(table.action),
    createdIdx: index('audit_created_idx').on(table.createdAt),
  })
);

// ============================================
// SESSIONS (Sessões Ativas)
// ============================================

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    
    // Session data
    sessionToken: varchar('session_token', { length: 255 }).notNull().unique(),
    
    // Metadata
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    deviceInfo: jsonb('device_info').default({}),
    
    // Status
    isActive: boolean('is_active').notNull().default(true),
    
    // Datas
    lastActivityAt: timestamp('last_activity_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    sessionTokenIdx: uniqueIndex('session_token_idx').on(table.sessionToken),
    userIdx: index('session_user_idx').on(table.userId),
    activeIdx: index('session_active_idx').on(table.isActive),
  })
);

// ============================================
// RELATIONS
// ============================================

export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  projects: many(projects),
  roles: many(roles),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
  userRoles: many(userRoles),
  tokens: many(tokens),
  sessions: many(sessions),
  projectAccess: many(userProjectAccess),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [projects.tenantId],
    references: [tenants.id],
  }),
  userAccess: many(userProjectAccess),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [roles.tenantId],
    references: [tenants.id],
  }),
  userRoles: many(userRoles),
  rolePermissions: many(rolePermissions),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, {
    fields: [rolePermissions.roleId],
    references: [roles.id],
  }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, {
    fields: [userRoles.userId],
    references: [users.id],
  }),
  role: one(roles, {
    fields: [userRoles.roleId],
    references: [roles.id],
  }),
  project: one(projects, {
    fields: [userRoles.projectId],
    references: [projects.id],
  }),
}));
```

### Índices e Performance

**Principais otimizações:**

1. **Índices Únicos Compostos**: Garantem integridade e performance
2. **Índices de Busca**: Otimizam queries frequentes
3. **Soft Deletes**: `deletedAt` para auditoria
4. **JSONB**: Flexibilidade sem comprometer performance
5. **Timestamps**: Rastreamento completo de mudanças

### Estimativa de Volume

| Tabela | Registros Estimados | Tamanho Médio |
|--------|-------------------|---------------|
| tenants | 1.000 | ~5 KB |
| users | 100.000 | ~2 KB |
| projects | 5.000 | ~1 KB |
| roles | 50 | ~500 B |
| permissions | 200 | ~500 B |
| tokens | 200.000 (ativos) | ~1 KB |
| audit_logs | 10M+ | ~2 KB |
| sessions | 50.000 (ativos) | ~1 KB |

**Total Estimado**: ~50 GB (incluindo índices e logs)
