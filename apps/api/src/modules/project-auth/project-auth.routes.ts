import type { FastifyInstance } from 'fastify';
import { authenticate, authenticateAccountDeletion, optionalAuth } from '../../middleware/auth.js';
import {
  appleLoginRateLimiter,
  appleNotificationRateLimiter,
  appleRevokeRateLimiter,
} from '../../middleware/ratelimit.js';
import * as controller from './project-auth.controller.js';
import * as accountDeletionController from './project-account-deletion.controller.js';
import * as deviceWipeController from './project-device-wipe.controller.js';
import {
  deviceWipeBindingRateLimiter,
  deviceWipeLookupRateLimiter,
} from '../../middleware/ratelimit.js';

export async function projectAuthRoutes(app: FastifyInstance) {
  app.post('/projects/:projectId/device-wipe/bindings', {
    preHandler: [authenticate, deviceWipeBindingRateLimiter],
  }, deviceWipeController.registerBinding as never);
  app.post('/projects/:projectId/device-wipe/bindings/:bindingHandle/mandates/query', {
    preHandler: deviceWipeLookupRateLimiter,
  }, deviceWipeController.queryMandates as never);
  app.post('/projects/:projectId/device-wipe/bindings/:bindingHandle/mandates/:deletionId/receipts', {
    preHandler: deviceWipeLookupRateLimiter,
  }, deviceWipeController.acknowledgeMandate as never);
  app.get('/projects/:projectId/device-wipe/verification-keys', {
    preHandler: deviceWipeLookupRateLimiter,
  }, deviceWipeController.verificationKeys as never);
  app.get('/projects/:projectId/device-wipe', {
    preHandler: authenticate,
  }, deviceWipeController.getConfig as never);
  app.put('/projects/:projectId/device-wipe', {
    preHandler: authenticate,
  }, deviceWipeController.updateConfig as never);
  app.post('/projects/:projectId/device-wipe/signing-keys/rotate', {
    preHandler: authenticate,
  }, deviceWipeController.rotateSigningKey as never);
  app.post('/projects/:projectId/device-wipe/signing-keys/:keyId/retire', {
    preHandler: authenticate,
  }, deviceWipeController.retireSigningKey as never);
  app.post('/projects/:projectId/auth/account-deletions/intents', {
    preHandler: [authenticate, appleLoginRateLimiter],
  }, accountDeletionController.createIntent as never);
  app.post('/projects/:projectId/auth/account-deletions/:deletionId/confirm', {
    preHandler: [authenticateAccountDeletion, appleLoginRateLimiter],
  }, accountDeletionController.confirm as never);
  app.get('/projects/:projectId/auth/account-deletions/:deletionId', {
    preHandler: appleLoginRateLimiter,
  }, accountDeletionController.status as never);
  app.get('/projects/:projectId/auth/account-deletion', {
    preHandler: authenticate,
  }, accountDeletionController.getConfig as never);
  app.put('/projects/:projectId/auth/account-deletion', {
    preHandler: authenticate,
  }, accountDeletionController.updateConfig as never);
  app.post('/projects/:projectId/auth/apple/login', {
    preHandler: appleLoginRateLimiter,
  }, controller.appleLogin as never);
  app.post('/projects/:projectId/auth/apple/revoke', {
    preHandler: [authenticate, appleRevokeRateLimiter],
  }, controller.appleRevoke as never);
  app.post('/projects/:projectId/auth/apple/notifications', {
    preHandler: appleNotificationRateLimiter,
  }, controller.appleNotification as never);
  app.post('/projects/:projectId/auth/apple/identities/:identityId/retry-revoke', {
    preHandler: [authenticate, appleRevokeRateLimiter],
  }, controller.retryAppleRevoke as never);
  app.get('/projects/:projectId/auth/apple/identities', {
    preHandler: authenticate,
  }, controller.listAppleIdentities as never);
  app.get('/projects/:projectId/auth/lifecycle-events', {
    preHandler: optionalAuth,
  }, controller.listAppleLifecycleEvents as never);
  app.post('/projects/:projectId/auth/lifecycle-events/:eventId/ack', {
    preHandler: optionalAuth,
  }, controller.acknowledgeAppleLifecycle as never);
  app.post('/projects/:projectId/auth/:provider/login', controller.providerLogin as never);
  app.post('/projects/:projectId/auth/:provider/silent-login', controller.providerSilentLogin as never);
  app.post('/projects/:projectId/auth/trusted/issue-session', controller.issueTrustedSession as never);
  app.post('/projects/:projectId/auth/wechat/login', controller.wechatLogin as never);
  app.post('/projects/:projectId/auth/wechat/silent-login', controller.wechatSilentLogin as never);
  app.post('/projects/:projectId/auth/refresh', controller.refresh as never);
  app.post('/projects/:projectId/auth/logout', { preHandler: authenticate }, controller.logout as never);
}
