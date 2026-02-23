# Druvia - Adapters 层设计

> 创建日期: 2026-02-24
> 父文档: 2026-02-24-druvia-design.md

## 一、Storage Adapters

### 1.1 接口定义

```typescript
// apps/api/src/adapters/storage/interface.ts

export interface UploadOptions {
  contentType?: string;
  cacheControl?: string;
  acl?: 'private' | 'public-read';
  metadata?: Record<string, string>;
}

export interface UploadResult {
  path: string;
  url: string;
  size: number;
  etag?: string;
}

export interface StorageAdapter {
  readonly name: string;  // 'r2' | 'local' | 's3'

  upload(file: Buffer, path: string, options?: UploadOptions): Promise<UploadResult>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  getPublicUrl(path: string): string;
  getSignedUrl(path: string, expiresIn?: number): Promise<string>;
  list(prefix: string): Promise<string[]>;
}
```

### 1.2 目录结构

```
apps/api/src/adapters/storage/
├── interface.ts          # 接口定义
├── r2.adapter.ts         # Cloudflare R2 (优先)
├── local.adapter.ts      # 本地文件系统 (兜底)
├── s3.adapter.ts         # AWS S3 / 兼容存储
└── index.ts              # 工厂函数
```

### 1.3 工厂函数

```typescript
// apps/api/src/adapters/storage/index.ts

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  switch (config.provider) {
    case 'r2':
      return new R2Adapter(config.r2);
    case 'local':
      return new LocalAdapter(config.local);
    case 's3':
      return new S3Adapter(config.s3);
    default:
      throw new Error(`Unknown storage provider: ${config.provider}`);
  }
}
```

### 1.4 R2 Adapter 实现

```typescript
// apps/api/src/adapters/storage/r2.adapter.ts

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export class R2Adapter implements StorageAdapter {
  readonly name = 'r2';
  private client: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor(config: R2Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
    this.bucket = config.bucket;
    this.publicUrl = config.publicUrl || `https://${config.bucket}.r2.dev`;
  }

  async upload(file: Buffer, path: string, options?: UploadOptions): Promise<UploadResult> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: path,
      Body: file,
      ContentType: options?.contentType,
      CacheControl: options?.cacheControl,
    }));

    return {
      path,
      url: this.getPublicUrl(path),
      size: file.length,
    };
  }

  async delete(path: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: path,
    }));
  }

  getPublicUrl(path: string): string {
    return `${this.publicUrl}/${path}`;
  }

  // ... 其他方法
}
```

### 1.5 Local Adapter 实现

```typescript
// apps/api/src/adapters/storage/local.adapter.ts

import fs from 'fs/promises';
import path from 'path';

export class LocalAdapter implements StorageAdapter {
  readonly name = 'local';
  private basePath: string;
  private publicUrl: string;

  constructor(config: LocalConfig) {
    this.basePath = config.basePath || '/data/storage';
    this.publicUrl = config.publicUrl || '/storage';
  }

  async upload(file: Buffer, filePath: string, options?: UploadOptions): Promise<UploadResult> {
    const fullPath = path.join(this.basePath, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file);

    return {
      path: filePath,
      url: this.getPublicUrl(filePath),
      size: file.length,
    };
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await fs.unlink(fullPath);
  }

  getPublicUrl(filePath: string): string {
    return `${this.publicUrl}/${filePath}`;
  }

  // ... 其他方法
}
```

### 1.6 租户级配置

```typescript
// 每个租户可以配置不同的存储后端
interface TenantStorageConfig {
  provider: 'r2' | 'local' | 's3';
  bucketPrefix: string;      // 租户隔离前缀
  maxFileSize: number;       // 最大文件大小限制 (bytes)
  allowedMimeTypes: string[]; // 允许的文件类型
}
```

---

## 二、Auth Adapters

### 2.1 接口定义

```typescript
// apps/api/src/adapters/auth/interface.ts

export interface AuthResult {
  user: {
    providerId: string;      // 第三方平台用户ID (openid/unionid)
    provider: string;        // 'wechat' | 'dingtalk' | 'feishu'
    nickname?: string;
    avatar?: string;
    email?: string;
    phone?: string;
    raw: Record<string, any>; // 原始响应数据
  };
  tokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
  };
}

export interface AuthAdapter {
  readonly provider: string;

  // 用 code 换取用户信息
  exchangeCode(code: string, state?: string): Promise<AuthResult>;

  // 刷新 token（可选）
  refreshToken?(refreshToken: string): Promise<AuthResult>;

  // 获取授权 URL（用于 OAuth 流程）
  getAuthUrl?(redirectUri: string, state?: string): string;
}
```

### 2.2 目录结构

```
apps/api/src/adapters/auth/
├── interface.ts           # 接口定义
├── wechat.adapter.ts      # 微信小程序/公众号
├── dingtalk.adapter.ts    # 钉钉
├── feishu.adapter.ts      # 飞书
├── oidc.adapter.ts        # 通用 OIDC (Google/GitHub/企业SSO)
└── index.ts               # 工厂函数 + 注册表
```

### 2.3 微信 Adapter 实现

```typescript
// apps/api/src/adapters/auth/wechat.adapter.ts

export interface WeChatConfig {
  appId: string;
  appSecret: string;
  type: 'miniprogram' | 'official' | 'web';
}

export class WeChatAdapter implements AuthAdapter {
  readonly provider = 'wechat';

  constructor(private config: WeChatConfig) {}

  async exchangeCode(code: string): Promise<AuthResult> {
    // 小程序使用 jscode2session
    if (this.config.type === 'miniprogram') {
      const url = `https://api.weixin.qq.com/sns/jscode2session?` +
        `appid=${this.config.appId}&secret=${this.config.appSecret}&` +
        `js_code=${code}&grant_type=authorization_code`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.errcode) {
        throw new AuthError(data.errcode, data.errmsg);
      }

      return {
        user: {
          providerId: data.openid,
          provider: 'wechat',
          raw: { openid: data.openid, unionid: data.unionid }
        },
        tokens: {
          accessToken: data.session_key,
          expiresIn: 7200
        }
      };
    }

    // 公众号/网页使用 OAuth
    // ... OAuth 流程实现
  }
}
```

### 2.4 钉钉 Adapter 实现

```typescript
// apps/api/src/adapters/auth/dingtalk.adapter.ts

export class DingTalkAdapter implements AuthAdapter {
  readonly provider = 'dingtalk';

  constructor(private config: DingTalkConfig) {}

  async exchangeCode(code: string): Promise<AuthResult> {
    // 1. 获取 access_token
    const tokenUrl = `https://api.dingtalk.com/v1.0/oauth2/userAccessToken`;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: this.config.appKey,
        clientSecret: this.config.appSecret,
        code,
        grantType: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();

    // 2. 获取用户信息
    const userUrl = `https://api.dingtalk.com/v1.0/contact/users/me`;
    const userRes = await fetch(userUrl, {
      headers: { 'x-acs-dingtalk-access-token': tokenData.accessToken }
    });
    const userData = await userRes.json();

    return {
      user: {
        providerId: userData.openId,
        provider: 'dingtalk',
        nickname: userData.nick,
        avatar: userData.avatarUrl,
        email: userData.email,
        phone: userData.mobile,
        raw: userData
      },
      tokens: {
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresIn: tokenData.expireIn
      }
    };
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    return `https://login.dingtalk.com/oauth2/auth?` +
      `client_id=${this.config.appKey}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&scope=openid&` +
      `state=${state || ''}`;
  }
}
```

### 2.5 OIDC 通用 Adapter

```typescript
// apps/api/src/adapters/auth/oidc.adapter.ts

export class OIDCAdapter implements AuthAdapter {
  readonly provider: string;

  constructor(private config: OIDCConfig) {
    this.provider = config.name || 'oidc';
  }

  async exchangeCode(code: string, state?: string): Promise<AuthResult> {
    // 1. 获取 token
    const tokenRes = await fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri
      })
    });
    const tokenData = await tokenRes.json();

    // 2. 获取用户信息
    const userRes = await fetch(this.config.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    return {
      user: {
        providerId: userData.sub,
        provider: this.provider,
        nickname: userData.name || userData.preferred_username,
        avatar: userData.picture,
        email: userData.email,
        raw: userData
      },
      tokens: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in
      }
    };
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    return `${this.config.authorizationEndpoint}?` +
      `client_id=${this.config.clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&scope=openid profile email&` +
      `state=${state || ''}`;
  }
}
```

### 2.6 认证服务整合

```typescript
// apps/api/src/modules/auth/auth.service.ts

export class AuthService {
  private adapters: Map<string, AuthAdapter> = new Map();

  // 注册适配器
  registerAdapter(adapter: AuthAdapter) {
    this.adapters.set(adapter.provider, adapter);
  }

  // 根据租户配置初始化适配器
  async initTenantAdapters(tenantId: string) {
    const configs = await this.getTenantAuthConfigs(tenantId);

    for (const config of configs) {
      if (!config.enabled) continue;

      const adapter = createAuthAdapter(config.provider, config.config);
      this.adapters.set(`${tenantId}:${config.provider}`, adapter);
    }
  }

  // 第三方登录
  async loginWithProvider(
    provider: string,
    code: string,
    tenantId: string
  ): Promise<Session> {
    const adapter = this.adapters.get(`${tenantId}:${provider}`);
    if (!adapter) throw new Error(`Provider ${provider} not configured`);

    // 1. 换取第三方用户信息
    const authResult = await adapter.exchangeCode(code);

    // 2. 查找或创建本地用户
    const user = await this.findOrCreateUser(tenantId, authResult);

    // 3. 生成 JWT Session
    return this.createSession(user);
  }
}
```

### 2.7 租户级配置

```typescript
// 每个租户可以启用不同的认证方式
interface TenantAuthConfig {
  enabledProviders: string[];  // ['wechat', 'dingtalk']
  providerConfigs: {
    wechat?: { appId: string; appSecret: string; type: string; };
    dingtalk?: { appKey: string; appSecret: string; };
    feishu?: { appId: string; appSecret: string; };
    oidc?: {
      name: string;
      issuer: string;
      clientId: string;
      clientSecret: string;
      // ... OIDC endpoints
    };
  };
}
```

---

## 三、函数体系

不支持用户上传代码，使用以下三层函数体系：

| 类型 | 适用场景 | 示例 |
|------|----------|------|
| **PostgreSQL Functions** | 纯数据操作、高性能计算 | 统计聚合、数据校验 |
| **Hasura Actions** | 需要外部调用的业务逻辑 | 发送通知、调用第三方 API |
| **Event Triggers** | 数据变更后的异步处理 | 数据同步、审计日志 |

### 3.1 Hasura Actions 配置

```yaml
# hasura/metadata/actions.yaml
actions:
  - name: sendNotification
    definition:
      kind: synchronous
      handler: '{{DRUVIA_API_URL}}/api/actions/send-notification'
    permissions:
      - role: user

  - name: processPayment
    definition:
      kind: synchronous
      handler: '{{DRUVIA_API_URL}}/api/actions/process-payment'
    permissions:
      - role: admin
```

### 3.2 Event Triggers 配置

```yaml
# hasura/metadata/databases/default/tables/public_orders.yaml
event_triggers:
  - name: order_created
    definition:
      enable_manual: false
      insert:
        columns: '*'
    retry_conf:
      num_retries: 3
      interval_sec: 10
    webhook: '{{DRUVIA_API_URL}}/api/webhooks/order-created'
```
