import type { AuthAdapter, AuthResult, WeChatConfig, AuthError } from './interface.js';

export class WeChatAdapter implements AuthAdapter {
  readonly provider = 'wechat';

  constructor(private config: WeChatConfig) {}

  async exchangeCode(code: string): Promise<AuthResult> {
    if (this.config.type === 'miniprogram') {
      return this.exchangeMiniprogramCode(code);
    }
    return this.exchangeOAuthCode(code);
  }

  // 小程序登录
  private async exchangeMiniprogramCode(code: string): Promise<AuthResult> {
    const url = `https://api.weixin.qq.com/sns/jscode2session?` +
      `appid=${this.config.appId}&secret=${this.config.appSecret}&` +
      `js_code=${code}&grant_type=authorization_code`;

    const response = await fetch(url);
    const data = await response.json() as {
      errcode?: number;
      errmsg?: string;
      openid?: string;
      unionid?: string;
      session_key?: string;
    };

    if (data.errcode) {
      throw new Error(`WeChat error ${data.errcode}: ${data.errmsg}`);
    }

    return {
      user: {
        providerId: data.openid!,
        provider: 'wechat',
        raw: {
          openid: data.openid,
          unionid: data.unionid,
        },
      },
      tokens: {
        accessToken: data.session_key!,
        expiresIn: 7200,
      },
    };
  }

  // 公众号/网页 OAuth 登录
  private async exchangeOAuthCode(code: string): Promise<AuthResult> {
    // 1. 获取 access_token
    const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?` +
      `appid=${this.config.appId}&secret=${this.config.appSecret}&` +
      `code=${code}&grant_type=authorization_code`;

    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json() as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      refresh_token?: string;
      openid?: string;
      unionid?: string;
      expires_in?: number;
    };

    if (tokenData.errcode) {
      throw new Error(`WeChat error ${tokenData.errcode}: ${tokenData.errmsg}`);
    }

    // 2. 获取用户信息
    const userUrl = `https://api.weixin.qq.com/sns/userinfo?` +
      `access_token=${tokenData.access_token}&openid=${tokenData.openid}&lang=zh_CN`;

    const userRes = await fetch(userUrl);
    const userData = await userRes.json() as {
      errcode?: number;
      errmsg?: string;
      openid?: string;
      unionid?: string;
      nickname?: string;
      headimgurl?: string;
    };

    if (userData.errcode) {
      throw new Error(`WeChat error ${userData.errcode}: ${userData.errmsg}`);
    }

    return {
      user: {
        providerId: userData.openid!,
        provider: 'wechat',
        nickname: userData.nickname,
        avatar: userData.headimgurl,
        raw: userData,
      },
      tokens: {
        accessToken: tokenData.access_token!,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in || 7200,
      },
    };
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    if (this.config.type === 'miniprogram') {
      throw new Error('Miniprogram does not support OAuth URL');
    }

    const scope = this.config.type === 'official' ? 'snsapi_userinfo' : 'snsapi_login';
    const baseUrl = this.config.type === 'official'
      ? 'https://open.weixin.qq.com/connect/oauth2/authorize'
      : 'https://open.weixin.qq.com/connect/qrconnect';

    return `${baseUrl}?` +
      `appid=${this.config.appId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&scope=${scope}&` +
      `state=${state || ''}#wechat_redirect`;
  }

  async refreshToken(refreshToken: string): Promise<AuthResult> {
    const url = `https://api.weixin.qq.com/sns/oauth2/refresh_token?` +
      `appid=${this.config.appId}&grant_type=refresh_token&` +
      `refresh_token=${refreshToken}`;

    const response = await fetch(url);
    const data = await response.json() as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      refresh_token?: string;
      openid?: string;
      expires_in?: number;
    };

    if (data.errcode) {
      throw new Error(`WeChat error ${data.errcode}: ${data.errmsg}`);
    }

    return {
      user: {
        providerId: data.openid!,
        provider: 'wechat',
        raw: { openid: data.openid },
      },
      tokens: {
        accessToken: data.access_token!,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in || 7200,
      },
    };
  }
}
