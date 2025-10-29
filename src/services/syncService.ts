import { v4 as uuidv4 } from 'uuid';
import { Database } from '../db/database';
import { Task, SyncQueueItem, SyncResult, SyncError } from '../types';
import { CHALLENGE_CONSTRAINTS } from '../utils/challenge-constraints';

/**
 * SyncService
 * - Orchestrates syncing sync_queue items to remote server in batches
 * - Applies conflict resolution (last-write-wins + operation priority) when necessary
 * - Retries failed items up to 3 attempts and marks them as error after that
 */
export class SyncService {
  private apiUrl: string;

  constructor(private db: Database, private taskService: any, apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api') {
    this.apiUrl = apiUrl;
  }

  // Basic connectivity check used in tests
  async checkConnectivity(): Promise<boolean> {
    try {
      const res = await (global as any).fetch?.(`${this.apiUrl}/health`) ?? null;
      if (!res) return false;
      return (await res).ok;
    } catch {
      return false;
    }
  }

  async sync(): Promise<SyncResult> {
    const result: SyncResult = { success: true, synced_items: 0, failed_items: 0, errors: [] };
    // fetch all pending sync queue items ordered by created_at to preserve per-task chronological order
    const items = await this.db.all<SyncQueueItem[]>('SELECT * FROM sync_queue ORDER BY created_at ASC');
    if (!items || items.length === 0) return result;

    const batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      try {
        const batchResp = await this.processBatch(batch);
        // apply successful updates and remove processed queue items
        for (const ok of batchResp.successful || []) {
          await this.db.run('DELETE FROM sync_queue WHERE id = ?', [ok.queue_id]);
          result.synced_items++;
        }
        for (const failed of batchResp.failed || []) {
          result.failed_items++;
          result.errors.push({
            task_id: failed.task_id,
            operation: failed.operation,
            error: failed.error,
            timestamp: new Date(),
          } as SyncError);
        }
      } catch (err: any) {
        // If entire batch fails (network error), increment retries and possibly mark error
        for (const item of batch) {
          await this.handleSyncError(item, err);
          result.failed_items++;
          result.errors.push({ task_id: item.task_id, operation: item.operation, error: String(err), timestamp: new Date() });
        }
      }
    }

    result.success = result.failed_items === 0;
    return result;
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, retry_count) VALUES (?, ?, ?, ?, 0)`,
      [uuidv4(), taskId, operation, JSON.stringify(data)]
    );
  }

  private async processBatch(items: SyncQueueItem[]): Promise<{ successful: Array<{ queue_id: string }>; failed: Array<{ task_id: string; operation: string; error: string }> }> {
    // send batch to server sync endpoint
    const payload = items.map((it) => ({ queue_id: it.id, task_id: it.task_id, operation: it.operation, data: JSON.parse(it.data as any) }));
    const endpoint = `${this.apiUrl}/sync/batch`;

    let fetchFn = (global as any).fetch;
    if (!fetchFn) {
      // dynamic require for environments without global fetch
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fetchFn = require('node-fetch');
    }

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: payload }),
    });

    if (!res.ok) {
      throw new Error(`Sync batch failed with status ${res.status}`);
    }

    const resJson = await res.json();
    // Expected response shape:
    // { results: [ { queue_id, task_id, status: 'ok'|'conflict'|'error', server_task?: {...}, error?: '...' } ] }

    const successful: Array<{ queue_id: string }> = [];
    const failed: Array<{ task_id: string; operation: string; error: string }> = [];

    for (const r of resJson.results || []) {
      const matching = items.find((it) => it.id === r.queue_id);
      if (!matching) continue;

      if (r.status === 'ok') {
        // Update local task with server data (server_id, last_synced_at, sync_status)
        const serverTask = r.server_task;
        const now = new Date().toISOString();
        await this.db.run(
          `UPDATE tasks SET server_id = ?, last_synced_at = ?, sync_status = ? WHERE id = ?`,
          [serverTask?.server_id || null, now, 'synced', matching.task_id]
        );
        successful.push({ queue_id: matching.id });
      } else if (r.status === 'conflict') {
        // Attempt to resolve conflict
        const localRow = await this.db.get<any>('SELECT * FROM tasks WHERE id = ?', [matching.task_id]);
        const localTask: Task = localRow ? {
          id: localRow.id,
          title: localRow.title,
          description: localRow.description,
          completed: !!localRow.completed,
          created_at: new Date(localRow.created_at),
          updated_at: new Date(localRow.updated_at),
          is_deleted: !!localRow.is_deleted,
          sync_status: localRow.sync_status,
          server_id: localRow.server_id,
          last_synced_at: localRow.last_synced_at ? new Date(localRow.last_synced_at) : undefined,
        } : (JSON.parse(matching.data as any) as Task);

        const serverTask: Task = r.server_task;
        const resolved = await this.resolveConflict(localTask, serverTask, matching.operation);

        // Persist resolved result locally and mark synced
        const now = new Date().toISOString();
        await this.db.run(
          `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, is_deleted = ?, server_id = ?, last_synced_at = ?, sync_status = ? WHERE id = ?`,
          [resolved.title, resolved.description, resolved.completed ? 1 : 0, resolved.updated_at.toISOString(), resolved.is_deleted ? 1 : 0, resolved.server_id || null, now, 'synced', resolved.id]
        );

        successful.push({ queue_id: matching.id });
      } else {
        // error
        failed.push({ task_id: matching.task_id, operation: matching.operation, error: r.error || 'unknown error' });
        await this.handleSyncError(matching, new Error(r.error || 'sync error'));
      }
    }

    return { successful, failed };
  }

  private async resolveConflict(localTask: Task, serverTask: Task, operation: string): Promise<Task> {
    // last-write-wins based on updated_at; if equal, prefer operation priority as defined in constraints
    const localTs = new Date(localTask.updated_at).getTime();
    const serverTs = new Date(serverTask.updated_at).getTime();

    if (serverTs > localTs) return serverTask;
    if (localTs > serverTs) return localTask;

    // timestamps equal -> use operation priority (delete > update > create)
    const priority = CHALLENGE_CONSTRAINTS.CONFLICT_PRIORITY || { delete: 3, update: 2, create: 1 };
    const localOpPriority = priority[operation] ?? 0;
    const serverOpPriority = priority[serverTask.is_deleted ? 'delete' : 'update'] ?? 0;

    if (serverOpPriority > localOpPriority) return serverTask;
    return localTask;
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(`UPDATE tasks SET sync_status = ?, last_synced_at = ? WHERE id = ?`, [status, now, taskId]);
    if (serverData?.server_id) {
      await this.db.run(`UPDATE tasks SET server_id = ? WHERE id = ?`, [serverData.server_id, taskId]);
    }
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const retryLimit = 3;
    const existing = await this.db.get<any>('SELECT retry_count FROM sync_queue WHERE id = ?', [item.id]);
    const currentRetry = existing ? existing.retry_count : 0;
    const nextRetry = currentRetry + 1;

    if (nextRetry >= retryLimit) {
      // mark task sync_status as error and save error message (dead letter behavior)
      await this.db.run(`UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`, [nextRetry, String(error), item.id]);
      await this.db.run(`UPDATE tasks SET sync_status = ? WHERE id = ?`, ['error', item.task_id]);
      // leave the item in queue for inspection (dead-letter style)
    } else {
      // increment retry_count and keep in queue to be retried
      await this.db.run(`UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`, [nextRetry, String(error), item.id]);
    }
  }
}