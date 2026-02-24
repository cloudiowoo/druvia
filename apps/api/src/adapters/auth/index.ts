import type { AuthAdapter, AuthProviderConfig } from './interface.js';
import { WeChatAdapter } from './wechat.adapter.js';
import { OIDCAdapter } from './oidc.adapter.js';

export * from './interface.js';
export { WeChatAdapter } from './wechat.adapter.js';
export { OIDCAdapter } from './oidc.adapter.js';

export function createAuthAdapter(providerConfig: AuthProviderConfig): AuthAdapter {
  switch (providerConfig.provider) {
    case 'wechat':
      return new WeChatAdapter(providerConfig.config);
    case 'oidc':
      return new OIDCAdapter(providerConfig.config);
    case 'dingtalk':
      throw new Error('DingTalk adapter not yet implemented');
    case 'feishu':
      throw new Error('Feishu adapter not yet implemented');
    default:
      throw new Error(`Unknown auth provider: ${(providerConfig as AuthProviderConfig).provider}`);
  }
}

// Auth adapter registry for multi-tenant support
export class AuthAdapterRegistry {
  private adapters: Map<string, AuthAdapter> = new Map();

  register(key: string, adapter: AuthAdapter): void {
    this.adapters.set(key, adapter);
  }

  get(key: string): AuthAdapter | undefined {
    return this.adapters.get(key);
  }

  getForTenant(tenantId: string, provider: string): AuthAdapter | undefined {
    return this.adapters.get(`${tenantId}:${provider}`);
  }

  registerForTenant(tenantId: string, adapter: AuthAdapter): void {
    this.adapters.set(`${tenantId}:${adapter.provider}`, adapter);
  }

  unregisterTenant(tenantId: string): void {
    for (const key of this.adapters.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.adapters.delete(key);
      }
    }
  }
}

// Global registry instance
export const authRegistry = new AuthAdapterRegistry();
