// Auth Adapter Interface

export interface AuthUser {
  providerId: string;      // 第三方平台用户ID (openid/unionid/sub)
  provider: string;        // 'wechat' | 'dingtalk' | 'feishu' | 'oidc'
  nickname?: string;
  avatar?: string;
  email?: string;
  phone?: string;
  raw: Record<string, unknown>; // 原始响应数据
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export interface AuthResult {
  user: AuthUser;
  tokens?: AuthTokens;
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

// Configuration types
export interface WeChatConfig {
  appId: string;
  appSecret: string;
  type: 'miniprogram' | 'official' | 'web';
}

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export interface OIDCConfig {
  name: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  redirectUri: string;
  scopes?: string[];
}

export type AuthProviderConfig =
  | { provider: 'wechat'; config: WeChatConfig }
  | { provider: 'dingtalk'; config: DingTalkConfig }
  | { provider: 'feishu'; config: FeishuConfig }
  | { provider: 'oidc'; config: OIDCConfig };

// Auth Error
export class AuthError extends Error {
  constructor(
    public code: string | number,
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
