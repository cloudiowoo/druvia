import type { AuthAdapter, AuthResult, OIDCConfig } from './interface.js';

export class OIDCAdapter implements AuthAdapter {
  readonly provider: string;

  constructor(private config: OIDCConfig) {
    this.provider = config.name || 'oidc';
  }

  async exchangeCode(code: string): Promise<AuthResult> {
    // 1. 获取 token
    const tokenRes = await fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const error = await tokenRes.text();
      throw new Error(`OIDC token error: ${error}`);
    }

    const tokenData = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
    };

    // 2. 获取用户信息
    const userRes = await fetch(this.config.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      const error = await userRes.text();
      throw new Error(`OIDC userinfo error: ${error}`);
    }

    const userData = await userRes.json() as {
      sub: string;
      name?: string;
      preferred_username?: string;
      picture?: string;
      email?: string;
      phone_number?: string;
    };

    return {
      user: {
        providerId: userData.sub,
        provider: this.provider,
        nickname: userData.name || userData.preferred_username,
        avatar: userData.picture,
        email: userData.email,
        phone: userData.phone_number,
        raw: userData,
      },
      tokens: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in || 3600,
      },
    };
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    const scopes = this.config.scopes || ['openid', 'profile', 'email'];
    return `${this.config.authorizationEndpoint}?` +
      `client_id=${this.config.clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(scopes.join(' '))}&` +
      `state=${state || ''}`;
  }

  async refreshToken(refreshToken: string): Promise<AuthResult> {
    const tokenRes = await fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!tokenRes.ok) {
      const error = await tokenRes.text();
      throw new Error(`OIDC refresh error: ${error}`);
    }

    const tokenData = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // 获取用户信息
    const userRes = await fetch(this.config.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const userData = await userRes.json() as {
      sub: string;
      name?: string;
      preferred_username?: string;
      picture?: string;
      email?: string;
    };

    return {
      user: {
        providerId: userData.sub,
        provider: this.provider,
        nickname: userData.name || userData.preferred_username,
        avatar: userData.picture,
        email: userData.email,
        raw: userData,
      },
      tokens: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshToken,
        expiresIn: tokenData.expires_in || 3600,
      },
    };
  }
}
