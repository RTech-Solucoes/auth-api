import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DrizzleService } from '../db/drizzle.service';
import { TokenService } from './token.service';
import { users } from '../db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto } from './dto/auth-response.dto';

@Injectable()
export class AuthService {
  private readonly BCRYPT_ROUNDS = 12;

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly tokenService: TokenService,
  ) {}

  /**
   * Register a new user
   */
  async register(
    dto: RegisterDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    // Check if user already exists
    // If tenantId is provided, check for email+tenant uniqueness
    // If no tenantId, check for email uniqueness across users without tenant
    const whereClause = dto.tenantId
      ? and(eq(users.email, dto.email), eq(users.tenantId, dto.tenantId))
      : and(eq(users.email, dto.email), isNull(users.tenantId));

    const existingUser = await this.drizzle.db
      .select()
      .from(users)
      .where(whereClause)
      .limit(1);

    if (existingUser.length > 0) {
      throw new ConflictException(
        dto.tenantId
          ? 'User with this email already exists for this tenant'
          : 'User with this email already exists',
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(dto.password, this.BCRYPT_ROUNDS);

    // Create user with status 'active' (simplified, no email verification for now)
    const [newUser] = await this.drizzle.db
      .insert(users)
      .values({
        email: dto.email,
        passwordHash,
        firstName: dto.firstName || null,
        lastName: dto.lastName || null,
        tenantId: dto.tenantId || null,
        status: 'active', // Simplified - no email verification in basic auth
        emailVerified: true,
        emailVerifiedAt: new Date(),
      })
      .returning({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        tenantId: users.tenantId,
      });

    // Generate token pair
    const tokenPair = await this.tokenService.createTokenPair(
      newUser.id,
      newUser.tenantId,
      ipAddress,
      userAgent,
    );

    return {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      user: {
        id: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
      },
    };
  }

  /**
   * Authenticate a user and return tokens
   */
  async login(
    dto: LoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    // Find user by email and tenantId (or email only if no tenant)
    const whereClause = dto.tenantId
      ? and(eq(users.email, dto.email), eq(users.tenantId, dto.tenantId))
      : and(eq(users.email, dto.email), isNull(users.tenantId));

    const [user] = await this.drizzle.db
      .select()
      .from(users)
      .where(whereClause)
      .limit(1);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      // Increment failed login attempts
      await this.drizzle.db
        .update(users)
        .set({
          failedLoginAttempts: (user.failedLoginAttempts || 0) + 1,
        })
        .where(eq(users.id, user.id));

      throw new UnauthorizedException('Invalid credentials');
    }

    // Check user status
    if (user.status !== 'active') {
      throw new UnauthorizedException(
        `User account is ${user.status}. Please contact support.`,
      );
    }

    // Update last login info and reset failed attempts
    await this.drizzle.db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        lastLoginIp: ipAddress || null,
        failedLoginAttempts: 0,
      })
      .where(eq(users.id, user.id));

    // Generate new token pair
    const tokenPair = await this.tokenService.createTokenPair(
      user.id,
      user.tenantId,
      ipAddress,
      userAgent,
    );

    return {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    };
  }

  /**
   * Logout user by revoking token
   */
  async logout(token: string): Promise<void> {
    const revoked = await this.tokenService.revokeToken(token, 'User logout');

    if (!revoked) {
      throw new NotFoundException('Token not found or already revoked');
    }
  }

  /**
   * Validate token and return user information
   */
  async validateUser(token: string): Promise<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    tenantId: string | null;
  }> {
    // Validate token
    const tokenData = await this.tokenService.validateToken(token);

    if (!tokenData) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Get user info
    const [user] = await this.drizzle.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        tenantId: users.tenantId,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, tokenData.userId))
      .limit(1);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Check if user is still active
    if (user.status !== 'active') {
      throw new UnauthorizedException('User account is no longer active');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      tenantId: user.tenantId,
    };
  }

  /**
   * Refresh access token using refresh token
   * Revokes old tokens and issues new ones
   */
  async refreshToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    // Validate the refresh token
    const tokenData = await this.tokenService.validateToken(refreshToken);

    if (!tokenData) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Get the token record to verify it's a refresh token
    const [tokenRecord] = await this.drizzle.db
      .select()
      .from(users)
      .where(eq(users.id, tokenData.userId))
      .limit(1);

    if (!tokenRecord) {
      throw new UnauthorizedException('User not found');
    }

    // Check if user is still active
    if (tokenRecord.status !== 'active') {
      throw new UnauthorizedException('User account is no longer active');
    }

    // Revoke the old refresh token
    await this.tokenService.revokeToken(refreshToken, 'Token refreshed');

    // Generate new token pair
    const newTokenPair = await this.tokenService.createTokenPair(
      tokenData.userId,
      tokenData.tenantId,
      ipAddress,
      userAgent,
    );

    return {
      accessToken: newTokenPair.accessToken,
      refreshToken: newTokenPair.refreshToken,
      expiresIn: newTokenPair.expiresIn,
      user: {
        id: tokenRecord.id,
        email: tokenRecord.email,
        firstName: tokenRecord.firstName,
        lastName: tokenRecord.lastName,
      },
    };
  }
}
