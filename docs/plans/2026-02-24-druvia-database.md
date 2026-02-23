# Druvia - 数据库设计

> 创建日期: 2026-02-24
> 父文档: 2026-02-24-druvia-design.md

## 一、核心表 (public schema)

### 1.1 原有核心表

```sql
-- 租户表
CREATE TABLE druvia_tenants (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) UNIQUE NOT NULL,
  alias VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  owner_uid INT NOT NULL,
  plan VARCHAR(20) DEFAULT 'free',
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 项目表
CREATE TABLE druvia_projects (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id),
  alias VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  schema_name VARCHAR(128),
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, alias)
);

-- 用户表
CREATE TABLE druvia_users (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  username VARCHAR(128),
  password_hash VARCHAR(255),
  avatar_url VARCHAR(512),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Schema 注册表
CREATE TABLE druvia_schema_registry (
  id SERIAL PRIMARY KEY,
  schema_name VARCHAR(128) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64),
  schema_type VARCHAR(20) NOT NULL,
  table_count INT DEFAULT 0,
  function_count INT DEFAULT 0,
  view_count INT DEFAULT 0,
  size_bytes BIGINT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 1.2 新增核心表

```sql
-- 备份记录表
CREATE TABLE druvia_backups (
  id SERIAL PRIMARY KEY,
  backup_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id),
  project_id VARCHAR(64) REFERENCES druvia_projects(project_id),
  schema_name VARCHAR(128) NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  size_bytes BIGINT DEFAULT 0,
  tables_count INT DEFAULT 0,
  tables_list JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'pending',  -- pending/completed/failed
  error_message TEXT,
  created_by INT REFERENCES druvia_users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX idx_backups_tenant ON druvia_backups(tenant_id);
CREATE INDEX idx_backups_project ON druvia_backups(project_id);
CREATE INDEX idx_backups_status ON druvia_backups(status);

-- 租户认证配置表
CREATE TABLE druvia_tenant_auth_providers (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id),
  provider VARCHAR(32) NOT NULL,  -- wechat/dingtalk/feishu/oidc
  enabled BOOLEAN DEFAULT true,
  config JSONB NOT NULL,  -- 加密存储 appId/appSecret 等
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, provider)
);

CREATE INDEX idx_auth_providers_tenant ON druvia_tenant_auth_providers(tenant_id);

-- 第三方账号绑定表
CREATE TABLE druvia_user_providers (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES druvia_users(id),
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id),
  provider VARCHAR(32) NOT NULL,
  provider_user_id VARCHAR(128) NOT NULL,  -- openid/unionid
  provider_data JSONB DEFAULT '{}',  -- 原始用户信息
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, provider, provider_user_id)
);

CREATE INDEX idx_user_providers_user ON druvia_user_providers(user_id);
CREATE INDEX idx_user_providers_lookup ON druvia_user_providers(tenant_id, provider, provider_user_id);

-- 租户存储配置表
CREATE TABLE druvia_tenant_storage_config (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) UNIQUE NOT NULL REFERENCES druvia_tenants(tenant_id),
  provider VARCHAR(32) NOT NULL DEFAULT 'local',  -- r2/local/s3
  config JSONB NOT NULL DEFAULT '{}',  -- bucket/endpoint/credentials (加密)
  max_file_size BIGINT DEFAULT 10485760,  -- 10MB
  allowed_mime_types TEXT[] DEFAULT '{}',
  total_storage_used BIGINT DEFAULT 0,
  storage_quota BIGINT DEFAULT 1073741824,  -- 1GB
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 文件元数据表
CREATE TABLE druvia_files (
  id SERIAL PRIMARY KEY,
  file_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id),
  project_id VARCHAR(64) REFERENCES druvia_projects(project_id),
  storage_key VARCHAR(512) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128),
  size_bytes BIGINT DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  uploaded_by INT REFERENCES druvia_users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_files_tenant ON druvia_files(tenant_id);
CREATE INDEX idx_files_project ON druvia_files(project_id);
CREATE INDEX idx_files_storage_key ON druvia_files(storage_key);
```

---

## 二、租户 Schema 元数据表

每个租户 Schema 内创建以下元数据表：

```sql
-- 表元数据
CREATE TABLE _meta_tables (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(128) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  columns JSONB NOT NULL,
  indexes JSONB DEFAULT '[]',
  constraints JSONB DEFAULT '[]',
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 函数元数据
CREATE TABLE _meta_functions (
  id SERIAL PRIMARY KEY,
  function_name VARCHAR(128) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  parameters JSONB DEFAULT '[]',
  return_type VARCHAR(64),
  language VARCHAR(20) DEFAULT 'plpgsql',
  definition TEXT NOT NULL,
  is_public BOOLEAN DEFAULT false,
  timeout_ms INT DEFAULT 5000,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 视图元数据
CREATE TABLE _meta_views (
  id SERIAL PRIMARY KEY,
  view_name VARCHAR(128) UNIQUE NOT NULL,
  view_type VARCHAR(20) NOT NULL,  -- view/materialized
  display_name VARCHAR(255),
  description TEXT,
  definition TEXT NOT NULL,
  columns JSONB,
  refresh_schedule VARCHAR(64),
  last_refreshed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## 三、ER 图

```
┌─────────────────────┐
│   druvia_tenants    │
│  (租户)             │
└──────────┬──────────┘
           │
     ┌─────┴─────┬──────────────┬──────────────┬──────────────┐
     │           │              │              │              │
     ▼           ▼              ▼              ▼              ▼
┌─────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│projects │ │auth_providers│ │storage_config│ │  backups    │ │   files     │
│(项目)   │ │(认证配置)    │ │(存储配置)    │ │(备份记录)   │ │(文件元数据) │
└────┬────┘ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
     │
     ▼
┌─────────────────────┐
│ schema_registry     │
│ (Schema 注册)       │
└─────────────────────┘


┌─────────────────────┐
│   druvia_users      │
│  (用户)             │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  user_providers     │
│ (第三方账号绑定)    │
└─────────────────────┘
```

---

## 四、Backup 服务实现

```typescript
// apps/api/src/modules/backup/backup.service.ts

export class BackupService {
  constructor(
    private db: PostgresConnection,
    private storage: StorageAdapter,
  ) {}

  async createBackup(schemaName: string, options?: BackupOptions): Promise<BackupMetadata> {
    const backupId = generateId();

    // 1. 记录备份开始
    await this.db.query(`
      INSERT INTO druvia_backups (backup_id, tenant_id, project_id, schema_name, storage_key, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
    `, [backupId, options?.tenantId, options?.projectId, schemaName, `backups/${schemaName}/${backupId}.dump`]);

    try {
      // 2. 获取表列表
      const tables = await this.getSchemaTableList(schemaName);

      // 3. 执行 pg_dump
      const dumpFile = await this.executePgDump(schemaName, {
        format: 'custom',
        excludePatterns: options?.excludePatterns || ['_meta_*'],
      });

      // 4. 上传到 Storage
      const storageKey = `backups/${schemaName}/${backupId}.dump`;
      await this.storage.upload(dumpFile, storageKey);

      // 5. 更新备份记录
      await this.db.query(`
        UPDATE druvia_backups
        SET status = 'completed',
            size_bytes = $1,
            tables_count = $2,
            tables_list = $3,
            completed_at = NOW()
        WHERE backup_id = $4
      `, [dumpFile.length, tables.length, JSON.stringify(tables), backupId]);

      return this.getBackupMetadata(backupId);
    } catch (error) {
      // 记录失败
      await this.db.query(`
        UPDATE druvia_backups
        SET status = 'failed', error_message = $1
        WHERE backup_id = $2
      `, [error.message, backupId]);
      throw error;
    }
  }

  async restoreBackup(backupId: string, targetSchema?: string): Promise<void> {
    // 1. 获取备份元数据
    const backup = await this.getBackupMetadata(backupId);
    if (backup.status !== 'completed') {
      throw new Error('Backup is not completed');
    }

    // 2. 从 Storage 下载
    const dumpFile = await this.storage.download(backup.storageKey);

    // 3. 执行 pg_restore
    const schema = targetSchema || backup.schemaName;
    await this.executePgRestore(dumpFile, schema);
  }

  private async executePgDump(schemaName: string, options: DumpOptions): Promise<Buffer> {
    const { execSync } = require('child_process');
    const tempFile = `/tmp/backup_${Date.now()}.dump`;

    const cmd = `pg_dump -Fc -n ${schemaName} -f ${tempFile} ${this.getConnectionString()}`;
    execSync(cmd);

    const fs = require('fs');
    const buffer = fs.readFileSync(tempFile);
    fs.unlinkSync(tempFile);

    return buffer;
  }

  private async executePgRestore(dumpFile: Buffer, schemaName: string): Promise<void> {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const tempFile = `/tmp/restore_${Date.now()}.dump`;

    fs.writeFileSync(tempFile, dumpFile);

    const cmd = `pg_restore -n ${schemaName} -d ${this.getConnectionString()} ${tempFile}`;
    execSync(cmd);

    fs.unlinkSync(tempFile);
  }
}
```

---

## 五、数据迁移脚本

### 5.1 初始化脚本

```sql
-- migrations/001_init_druvia.sql

-- 创建核心表
CREATE TABLE IF NOT EXISTS druvia_tenants (...);
CREATE TABLE IF NOT EXISTS druvia_projects (...);
CREATE TABLE IF NOT EXISTS druvia_users (...);
CREATE TABLE IF NOT EXISTS druvia_schema_registry (...);
CREATE TABLE IF NOT EXISTS druvia_backups (...);
CREATE TABLE IF NOT EXISTS druvia_tenant_auth_providers (...);
CREATE TABLE IF NOT EXISTS druvia_user_providers (...);
CREATE TABLE IF NOT EXISTS druvia_tenant_storage_config (...);
CREATE TABLE IF NOT EXISTS druvia_files (...);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_backups_tenant ON druvia_backups(tenant_id);
-- ... 其他索引
```

### 5.2 租户 Schema 初始化模板

```sql
-- templates/tenant_schema_init.sql

CREATE SCHEMA IF NOT EXISTS {{schema_name}};

SET search_path TO {{schema_name}};

CREATE TABLE _meta_tables (...);
CREATE TABLE _meta_functions (...);
CREATE TABLE _meta_views (...);

RESET search_path;
```
