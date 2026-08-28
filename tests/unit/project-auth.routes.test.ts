import { describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/lib/redis.js', () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
}));

import { optionalAuth } from '../../apps/api/src/middleware/auth.js';
import { projectAuthRoutes } from '../../apps/api/src/modules/project-auth/project-auth.routes.js';

describe('Project Auth routes', () => {
  it('parses optional platform auth on Apple lifecycle routes', async () => {
    const app = {
      get: vi.fn(),
      post: vi.fn(),
    };

    await projectAuthRoutes(app as never);

    expect(app.get).toHaveBeenCalledWith(
      '/projects/:projectId/auth/lifecycle-events',
      { preHandler: optionalAuth },
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/projects/:projectId/auth/lifecycle-events/:eventId/ack',
      { preHandler: optionalAuth },
      expect.any(Function),
    );
  });
});
