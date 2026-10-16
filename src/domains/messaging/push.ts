/**
 * Push notifications addressed by profile id (what domain rows store). The notifications queue's `push` job is keyed by
 * the auth user id, so this resolves it first. Best effort: a failure to enqueue is logged and never fails the caller,
 * because the work the notification announces has already been committed.
 */
import type { Deps } from '../../deps.js';

export interface ProfilePush {
  profileId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Deterministic job id, so a retried completion notifies once. */
  jobId: string;
}

export async function pushToProfile(deps: Deps, p: ProfilePush): Promise<void> {
  try {
    const rows = await deps.db<{ user_id: string }[]>`select user_id::text from public.profiles where id = ${p.profileId}::uuid`;
    const userId = rows[0]?.user_id;
    if (!userId) return;
    await deps.jobs.enqueue(
      'notifications',
      'push',
      { userId, title: p.title, body: p.body, ...(p.data ? { data: p.data } : {}) },
      { jobId: p.jobId },
    );
  } catch (e) {
    deps.log.warn({ err: (e as Error).message, jobId: p.jobId }, 'push enqueue failed');
  }
}
