/**
 * gRPC server for the Auth Service.
 * Exposes ValidateToken and GetUserClaims for internal service-to-service calls.
 *
 * Start this alongside the HTTP server when GRPC_ENABLED=true.
 */

const { createGrpcServer } = require('../../../shared/grpc/client');
const authService = require('./services/auth.service');

function createAuthGrpcServer(logger) {
  const port = Number(process.env.GRPC_PORT || 9001);
  const enabled = String(process.env.GRPC_ENABLED || 'false').toLowerCase() === 'true';

  if (!enabled) {
    logger?.info('grpc_server_disabled', { service: 'auth-service', reason: 'GRPC_ENABLED=false' });
    return { enabled: false, start: async () => {}, stop: async () => {} };
  }

  const server = createGrpcServer('AuthService', {
    async ValidateToken({ token }) {
      try {
        const claims = await authService.validateToken(token);
        return {
          valid: true,
          claims: {
            userId: claims.userId,
            tenantId: claims.tenantId,
            tenantSlug: claims.tenantSlug,
            email: claims.email,
            role: claims.role,
          },
          error: '',
        };
      } catch (error) {
        return { valid: false, claims: null, error: error.message };
      }
    },

    async GetUserClaims({ token }) {
      const claims = await authService.validateToken(token);
      return {
        userId: claims.userId,
        tenantId: claims.tenantId,
        tenantSlug: claims.tenantSlug,
        email: claims.email,
        role: claims.role,
      };
    },
  }, { port });

  return {
    enabled: server.enabled,
    async start() {
      if (!server.enabled) return;
      const boundPort = await server.start();
      logger?.info('grpc_server_started', { service: 'auth-service', port: boundPort });
    },
    async stop() {
      if (!server.enabled) return;
      await server.stop();
      logger?.info('grpc_server_stopped', { service: 'auth-service' });
    },
  };
}

module.exports = { createAuthGrpcServer };
