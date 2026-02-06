import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthResponseDto } from './dto/auth-response.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Extract Bearer token from Authorization header
   */
  private extractTokenFromHeader(authorization?: string): string {
    if (!authorization) {
      throw new UnauthorizedException('Authorization header is required');
    }

    const [type, token] = authorization.split(' ');

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization header format');
    }

    return token;
  }

  /**
   * Extract IP address from request
   */
  private getIpAddress(req: Request): string | undefined {
    return (
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress
    );
  }

  /**
   * POST /auth/register
   * Register a new user
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() registerDto: RegisterDto,
    @Req() req: Request,
  ): Promise<AuthResponseDto> {
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    return this.authService.register(registerDto, ipAddress, userAgent);
  }

  /**
   * POST /auth/login
   * Login user
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
  ): Promise<AuthResponseDto> {
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    return this.authService.login(loginDto, ipAddress, userAgent);
  }

  /**
   * POST /auth/logout
   * Logout user (revoke token)
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Headers('authorization') authorization: string): Promise<void> {
    const token = this.extractTokenFromHeader(authorization);
    await this.authService.logout(token);
  }

  /**
   * POST /auth/refresh
   * Refresh access token using refresh token
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<AuthResponseDto> {
    const ipAddress = this.getIpAddress(req);
    const userAgent = req.headers['user-agent'];

    return this.authService.refreshToken(
      refreshTokenDto.refreshToken,
      ipAddress,
      userAgent,
    );
  }

  /**
   * GET /auth/me
   * Get current user info
   */
  @Get('me')
  @HttpCode(HttpStatus.OK)
  async getMe(@Headers('authorization') authorization: string): Promise<{
    user: {
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      tenantId: string | null;
    };
  }> {
    const token = this.extractTokenFromHeader(authorization);
    const user = await this.authService.validateUser(token);

    return { user };
  }
}
