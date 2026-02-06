import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { DrizzleService } from '../db/drizzle.service';
import { tokens } from '../db/schema';
import { eq, and } from 'drizzle-orm';

@Injectable()
export class TokenService {
  constructor(private readonly drizzle: DrizzleService) {}

  /**
   * Generate a cryptographically secure opaque token
   * Returns a 32-byte random token encoded as base64url (256 bits)
   */
  generateOpaqueToken(): string {
    const token = randomBytes(32).toString('base64url');
    return token;
  }

  /**
   * Create SHA-256 hash of the token for secure storage
   * We store the hash in the database, not the actual token
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Create an access and refresh token pair for a user
   * Access token: 15 minutes expiry
   * Refresh token: 7 days expiry
   */
  async createTokenPair(
    userId: string,
    tenantId: string | null,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    // Generate tokens
    const accessToken = this.generateOpaqueToken();
    const refreshToken = this.generateOpaqueToken();

    // Hash tokens for storage
    const accessTokenHash = this.hashToken(accessToken);
    const refreshTokenHash = this.hashToken(refreshToken);

    // Calculate expiration times
    const accessTokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    const refreshTokenExpiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ); // 7 days

    // Insert tokens into database
    // First create the refresh token
    const [refreshTokenRecord] = await this.drizzle.db
      .insert(tokens)
      .values({
        userId,
        tenantId,
        token: refreshToken,
        tokenHash: refreshTokenHash,
        type: 'refresh',
        expiresAt: refreshTokenExpiresAt,
        ipAddress,
        userAgent,
      })
      .returning({ id: tokens.id });

    // Then create the access token with reference to refresh token
    await this.drizzle.db.insert(tokens).values({
      userId,
      tenantId,
      token: accessToken,
      tokenHash: accessTokenHash,
      type: 'access',
      expiresAt: accessTokenExpiresAt,
      refreshTokenId: refreshTokenRecord.id,
      ipAddress,
      userAgent,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 15 * 60, // 15 minutes in seconds
    };
  }

  /**
   * Validate a token and return the associated user info
   * Returns null if token is invalid, expired, or revoked
   */
  async validateToken(
    token: string,
  ): Promise<{ userId: string; tenantId: string | null } | null> {
    const tokenHash = this.hashToken(token);

    // Find token by hash
    const [tokenRecord] = await this.drizzle.db
      .select()
      .from(tokens)
      .where(eq(tokens.tokenHash, tokenHash))
      .limit(1);

    if (!tokenRecord) {
      return null;
    }

    // Check if token is revoked
    if (tokenRecord.isRevoked) {
      return null;
    }

    // Check if token is expired
    if (tokenRecord.expiresAt < new Date()) {
      return null;
    }

    // Update last used timestamp
    await this.drizzle.db
      .update(tokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(tokens.id, tokenRecord.id));

    return {
      userId: tokenRecord.userId,
      tenantId: tokenRecord.tenantId,
    };
  }

  /**
   * Revoke a token by marking it as revoked in the database
   */
  async revokeToken(token: string, reason?: string): Promise<boolean> {
    const tokenHash = this.hashToken(token);

    const result = await this.drizzle.db
      .update(tokens)
      .set({
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: reason || 'User logout',
      })
      .where(and(eq(tokens.tokenHash, tokenHash), eq(tokens.isRevoked, false)));

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Revoke all tokens for a specific user
   * Useful for logout from all devices or security incidents
   */
  async revokeAllUserTokens(userId: string, reason?: string): Promise<number> {
    const result = await this.drizzle.db
      .update(tokens)
      .set({
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: reason || 'Revoke all tokens',
      })
      .where(and(eq(tokens.userId, userId), eq(tokens.isRevoked, false)));

    return result.rowCount ?? 0;
  }
}
