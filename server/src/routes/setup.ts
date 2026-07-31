/**
 * First-run setup.
 *
 * `GET /api/setup` is unauthenticated by necessity — the browser has to know
 * whether to show the wizard before anyone can log in. It returns a single
 * boolean and nothing else.
 *
 * `POST /api/setup` is unauthenticated for the same reason, which makes the
 * completion guard the most security-sensitive line in the file: an endpoint
 * that sets the admin password and stays open is a full takeover of every
 * existing install. It refuses the moment a credential exists, whatever else
 * is true.
 */
import type { FastifyInstance } from 'fastify';

import {
  hasAdminCredential,
  isSetupComplete,
  markSetupComplete,
  setAdminPassword,
} from '../auth/credentials.js';
import { isAcceptablePassword, MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { issueSession } from '../auth/session.js';
import { updateSettings } from '../settings/settings.js';
import { DEFAULT_HUB_TITLE } from '../settings/types.js';

export function setupRequired(): boolean {
  return !hasAdminCredential() && !isSetupComplete();
}

interface SetupBody {
  password?: string;
  confirmPassword?: string;
  hubTitle?: string;
}

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/setup', async () => ({ required: setupRequired() }));

  app.post<{ Body: SetupBody }>('/api/setup', async (request, reply) => {
    // Belt and braces: either an existing credential or a completion marker is
    // enough to refuse. They are set together, but a partially-written state
    // must fail closed rather than open.
    if (hasAdminCredential() || isSetupComplete()) {
      return reply.code(409).send({
        error: 'Setup has already been completed. Sign in instead.',
      });
    }

    const body = request.body ?? {};
    const password = String(body.password ?? '');
    const confirmPassword = String(body.confirmPassword ?? '');
    const hubTitle = String(body.hubTitle ?? '').trim();

    if (!isAcceptablePassword(password)) {
      return reply.code(400).send({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }
    if (password !== confirmPassword) {
      return reply.code(400).send({ error: 'Passwords do not match.' });
    }
    if (hubTitle.length > 60) {
      return reply.code(400).send({ error: 'Hub name must be 60 characters or fewer.' });
    }

    await setAdminPassword(password, 'wizard');
    markSetupComplete();

    updateSettings({ hubTitle: hubTitle === '' ? DEFAULT_HUB_TITLE : hubTitle });

    // Log the operator straight in. Making them retype the password they just
    // chose adds nothing: they have already proved they can set it.
    issueSession(reply);
    request.log.info({ ip: request.ip }, 'first-run setup completed');

    return { ok: true };
  });
}
