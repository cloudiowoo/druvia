import type { FastifyInstance } from 'fastify';
import * as controller from './user.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function userRoutes(app: FastifyInstance) {
  // Public routes
  app.post('/auth/register', controller.register);
  app.post('/auth/login', controller.login);

  // Protected routes (current user)
  app.get('/users/me', { preHandler: authenticate }, controller.getProfile);
  app.patch('/users/me', { preHandler: authenticate }, controller.updateProfile as never);
  app.post('/users/me/password', { preHandler: authenticate }, controller.changePassword as never);

  // Admin routes (user management)
  app.get('/users', { preHandler: authenticate }, controller.listUsers);
  app.get('/users/:userId', { preHandler: authenticate }, controller.getUser as never);
  app.delete('/users/:userId', { preHandler: authenticate }, controller.deleteUser as never);
  app.patch('/users/:userId/status', { preHandler: authenticate }, controller.updateUserStatus as never);
}
