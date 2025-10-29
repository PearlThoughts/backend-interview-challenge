import axios from 'axios';
import { Task, SyncQueueItem, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

const DEFAULT_BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '25', 10);
const MAX_RETRIES = parseInt(process.env.SYNC_MAX_RETRIES || '3', 10);
const nowIso = () => new Date().toISOString();

export class SyncService {
  private apiUrl: string;

  constructor(private db: Database, private taskService: TaskService, apiUrl?: string) {
    this.apiUrl = apiUrl ?? process.env.API_BASE_URL ?? 'http://localhost:3000/api';
  }

  /**
   * Return shape expected by tests:
   * { success: boolean, synced_items: number, failed_items: number, applied: Task[], conflicts: [], rejected: [] }
   */
  async sync(): Promise<{
    success: boolean;
    synced_items: number;
    failed_items: number;
    applied: Task[];
    conflicts: Array<{ incoming: Task; server: Task }>;
    rejected: Task[];
  }> {
    const appliedAll: Task[] = [];
    const conflictsAll: Array<{ incoming: Task; server: Task }> = [];
    const rejectedAll: Task[] = [];
    let syncedCount = 0;
    let failedCount = 0;

    // fetch pending items from sync_queue
    const pendingRows: any[] = await this.db.all(
      `SELECT * FROM sync_queue WHERE status IN ('pending', 'error') ORDER BY created_at ASC`
    );

    if (!pendingRows || pendingRows.length === 0) {
      return {
        success: true,
        synced_items: 0,
        failed_items: 0,
        applied: [],
        conflicts: [],
        rejected: [],
      };
    }

    const items: SyncQueueItem[] = pendingRows.map((r: any) => ({
      id: r.id,
      task_id: r.task_id,
      operation: r.operation,
      data: JSON.parse(r.data || '{}'),
      retries: r.retries ?? r.retry_count ?? 0,
      status: r.status,
      error: r.error,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

    for (let i = 0; i < items.length; i += DEFAULT_BATCH_SIZE) {
      const batch = items.slice(i, i + DEFAULT_BATCH_SIZE);

      // Build payload for server
      const payloadTasks = batch.map((it) => {
        const p: any = { ...(it.data || {}), id: it.data?.id ?? it.task_id };
        if (!p.updated_at) p.updated_at = nowIso();
        return p;
      });

      try {
        const url = `${this.apiUrl}/batch`;
        const resp = await axios.post(url, { tasks: payloadTasks } as BatchSyncRequest, { timeout: 15000 });
        const data: BatchSyncResponse = resp.data;

        // Ensure arrays exist
        const applied = Array.isArray(data.applied) ? data.applied : [];
        const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
        const rejected = Array.isArray(data.rejected) ? data.rejected : [];

        // For robust behavior, reconcile each original batch item against server response
        for (const qItem of batch) {
          const taskId = qItem.task_id;
          // Did server explicitly apply this task?
          const matchedApplied = applied.find((t: any) => String(t.id || t.task_id) === String(taskId));
          if (matchedApplied) {
            // Mark as synced locally
            appliedAll.push(matchedApplied);
            try {
              await this.updateSyncStatus(taskId, 'synced', matchedApplied);
            } catch (e) {
              console.error('updateSyncStatus failed for applied', taskId, e);
            }
            syncedCount += 1;
            continue;
          }

          // Did server report a conflict for this task?
          const matchedConflict = conflicts.find((c: any) => String((c.incoming && c.incoming.id) || c.incoming?.id || c.incoming?.task_id) === String(taskId) || String((c.server && c.server.id) || c.server?.id) === String(taskId));
          if (matchedConflict) {
            conflictsAll.push(matchedConflict);
            try {
              // Resolve using last-write-wins
              const resolved = await this.resolveConflict(matchedConflict.incoming, matchedConflict.server);
              // Update local store
              await this.taskService.updateTask(resolved.id, {
                title: resolved.title,
                description: resolved.description,
                completed: resolved.completed,
                updated_at: resolved.updated_at,
                client_version: resolved.client_version,
                server_version: resolved.server_version,
              });
              await this.updateSyncStatus(resolved.id, 'synced', resolved);
              syncedCount += 1;
            } catch (e) {
              console.error('error resolving conflict for', taskId, e);
              failedCount += 1;
            }
            continue;
          }

          // Did server explicitly reject this task?
          const matchedRejected = rejected.find((t: any) => String(t.id || t.task_id) === String(taskId));
          if (matchedRejected) {
            rejectedAll.push(matchedRejected);
            // mark queue entry for retry/error
            const queueRows = await this.db.all(`SELECT * FROM sync_queue WHERE task_id = ?`, [taskId]);
            for (const qr of queueRows) {
              await this.handleSyncError(qr, new Error('Rejected by server'));
            }
            failedCount += 1;
            continue;
          }

          // Fallback: if server returned 200 and didn't classify this item, assume it accepted it.
          // Mark as synced locally (best-effort)
          try {
            await this.updateSyncStatus(taskId, 'synced', { id: taskId });
            syncedCount += 1;
          } catch (e) {
            console.error('fallback updateSyncStatus failed for', taskId, e);
            failedCount += 1;
          }
        }
      } catch (err) {
        // Batch-level failure (network/server)
        for (const item of batch) {
          await this.handleSyncError(item as SyncQueueItem, err as Error);
          failedCount += 1;
        }
      }
    }

    const success = failedCount === 0;

    return {
      success,
      synced_items: syncedCount,
      failed_items: failedCount,
      applied: appliedAll,
      conflicts: conflictsAll,
      rejected: rejectedAll,
    };
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const id = (Math.random() + 1).toString(36).substring(2, 9);
    const created_at = nowIso();
    const updated_at = created_at;
    const retries = 0;
    const status = 'pending';
    const error = null;
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, retries, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, taskId, operation, JSON.stringify(data), retries, status, error, created_at, updated_at]
    );
  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localT = new Date(localTask.updated_at).getTime();
    const serverT = new Date(serverTask.updated_at).getTime();
    if (serverT >= localT) return serverTask;
    return localTask;
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const last_synced_at = nowIso();
    if (status === 'synced') {
      const server_id = serverData?.server_id ?? serverData?.id ?? null;
      const server_version = serverData?.server_version ?? null;
      await this.db.run(
        `UPDATE tasks SET sync_status = 'synced', last_synced_at = ?, server_id = COALESCE(?, server_id), server_version = COALESCE(?, server_version) WHERE id = ?`,
        [last_synced_at, server_id, server_version, taskId]
      );
      await this.db.run(`DELETE FROM sync_queue WHERE task_id = ?`, [taskId]);
    } else {
      await this.db.run(`UPDATE tasks SET sync_status = 'error' WHERE id = ?`, [taskId]);
    }
  }

  private async handleSyncError(item: SyncQueueItem, error: any): Promise<void> {
    try {
      const retries = (item.retries ?? 0) + 1;
      const errorMessage = (error && error.message) || String(error);

      if (retries >= MAX_RETRIES) {
        await this.db.run(
          `UPDATE sync_queue SET retries = ?, status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
          [retries, errorMessage, nowIso(), item.id]
        );
        await this.db.run(`UPDATE tasks SET sync_status = 'error' WHERE id = ?`, [item.task_id]);
      } else {
        await this.db.run(
          `UPDATE sync_queue SET retries = ?, status = 'error', error = ?, updated_at = ? WHERE id = ?`,
          [retries, errorMessage, nowIso(), item.id]
        );
      }
    } catch (err) {
      console.error('handleSyncError failed', err);
    }
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
