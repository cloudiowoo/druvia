import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/auth.js';
import { requireProjectCapability } from '../../lib/project-authorization.js';
import * as controller from './project-members.controller.js';

export async function projectMemberRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/projects/:projectId/access', {
    preHandler: requireProjectCapability('project:read'),
  }, controller.getProjectAccess as never);
  app.get('/projects/:projectId/members', {
    preHandler: requireProjectCapability('members:read'),
  }, controller.listProjectMembers as never);
  app.get('/projects/:projectId/member-candidates', {
    preHandler: requireProjectCapability('members:manage'),
  }, controller.searchProjectMemberCandidates as never);
  app.post('/projects/:projectId/members', {
    preHandler: requireProjectCapability('members:manage'),
  }, controller.createProjectMember as never);
  app.patch('/projects/:projectId/members/:userId', {
    preHandler: requireProjectCapability('members:manage'),
  }, controller.updateProjectMember as never);
  app.delete('/projects/:projectId/members/:userId', {
    preHandler: requireProjectCapability('members:manage'),
  }, controller.deleteProjectMember as never);
}
