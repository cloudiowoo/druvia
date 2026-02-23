---
name: adapters-guide
description: This skill should be used when the user asks about "Storage adapter", "Auth adapter", "R2", "S3", "local storage", "WeChat login", "DingTalk", "Feishu", "OIDC", or mentions "pluggable adapters", "third-party authentication", "file upload".
---

# Adapters Development Guide

Druvia 平台可插拔适配器开发指南。

## 适配器架构

```
apps/api/src/adapters/
├── storage/
│   ├── interface.ts      # StorageAdapter 接口
│   ├── r2.adapter.ts     # Cloudflare R2
│   ├── local.adapter.ts  # 本地文件系统
│   ├── s3.adapter.ts     # AWS S3
│   └── index.ts          # 工厂函数
│
└── auth/
    ├── interface.ts      # AuthAdapter 接口
    ├── wechat.adapter.ts # 微信
    ├── dingtalk.adapter.ts # 钉钉
    ├── feishu.adapter.ts # 飞书
    ├── oidc.adapter.ts   # 通用 OIDC
    └── index.ts          # 工厂函数
```

## Storage Adapter

### 接口定义

```typescript
export interface StorageAdapter {
  readonly name: string;  // 'r2' | 'local' | 's3'

  upload(file: Buffer, path: string, options?: UploadOptions): Promise<UploadResult>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  getPublicUrl(path: string): string;
  getSignedUrl(path: string, expiresIn?: number): Promise<string>;
  list(prefix: string): Promise<string[]>;
}

export interface UploadOptions {
  contentType?: string;
  cacheControl?: string;
  acl?: 'private' | 'public-read';
}

export interface UploadResult {
  path: string;
  url: string;
  size: number;
}
```

### 使用示例

```typescript
import { createStorageAdapter } from './adapters/storage';

// 创建适配器
const storage = createStorageAdapter({
  provider: 'r2',
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKey: process.env.R2_ACCESS_KEY,
    secretKey: process.env.R2_SECRET_KEY,
    bucket: 'druvia-storage',
  },
});

// 上传文件
const result = await storage.upload(fileBuffer, 'images/avatar.jpg', {
  contentType: 'image/jpeg',
});
console.log(result.url);  // https://bucket.r2.dev/images/avatar.jpg

// 删除文件
await storage.delete('images/avatar.jpg');
```

### 降级策略

```typescript
// R2 不可用时自动降级到 Local
async function uploadWithFallback(file: Buffer, path: string) {
  try {
    return await r2Adapter.upload(file, path);
  } catch (error) {
    console.warn('R2 upload failed, falling back to local:', error);
    return await localAdapter.upload(file, path);
  }
}
```

## Auth Adapter

### 接口定义

```typescript
export interface AuthAdapter {
  readonly provider: string;

  exchangeCode(code: string, state?: string): Promise<AuthResult>;
  refreshToken?(refreshToken: string): Promise<AuthResult>;
  getAuthUrl?(redirectUri: string, state?: string): string;
}

export interface AuthResult {
  user: {
    providerId: string;   // openid/unionid
    provider: string;
    nickname?: string;
    avatar?: string;
    email?: string;
    raw: Record<string, any>;
  };
  tokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
  };
}
```

### 微信适配器

```typescript
const wechatAdapter = createAuthAdapter('wechat', {
  appId: process.env.WECHAT_APP_ID,
  appSecret: process.env.WECHAT_APP_SECRET,
  type: 'miniprogram',  // miniprogram | official | web
});

// 小程序登录
const result = await wechatAdapter.exchangeCode(code);
console.log(result.user.providerId);  // openid
```

### OIDC 通用适配器

```typescript
const googleAdapter = createAuthAdapter('oidc', {
  name: 'google',
  issuer: 'https://accounts.google.com',
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: 'https://api.druvia.com/auth/callback/google',
});

// 获取授权 URL
const authUrl = googleAdapter.getAuthUrl(redirectUri, state);

// 换取用户信息
const result = await googleAdapter.exchangeCode(code);
```

## 租户级配置

每个租户可以配置不同的适配器：

```typescript
// 获取租户存储配置
const storageConfig = await getTenantStorageConfig(tenantId);
const storage = createStorageAdapter(storageConfig);

// 获取租户认证配置
const authConfigs = await getTenantAuthProviders(tenantId);
for (const config of authConfigs) {
  if (config.enabled) {
    const adapter = createAuthAdapter(config.provider, config.config);
    authService.registerAdapter(`${tenantId}:${config.provider}`, adapter);
  }
}
```
