import { Controller, Get, Inject } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';

/**
 * 认证配置发现（生产 P0）：**无需鉴权**，前端启动时调用，
 * 据此决定是直接进入（dev）还是跳转 OIDC 授权码流程。
 * 只暴露公开参数（issuer / clientId），不含任何密钥。
 */
@Controller('api/v1/auth')
export class AuthConfigController {
  constructor(@Inject(CONFIG) private config: AppConfig) {}

  @Get('config')
  config_() {
    if (this.config.authMode === 'dev') {
      return { mode: 'dev' as const };
    }
    return {
      mode: 'oidc' as const,
      issuer: process.env.OIDC_ISSUER ?? '',
      clientId: process.env.OIDC_CLIENT_ID ?? 'apolla-web',
      // 前端用授权码 + PKCE，无需 client secret
      scope: process.env.OIDC_SCOPE ?? 'openid profile email',
    };
  }
}
