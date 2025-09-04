import axios from 'axios';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse, SyncError } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

export class SyncService {
  private apiUrl: string;
  
  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      const res = await axios.get(`${this.apiUrl}/sync/health`);
      return !!(res.data && typeof res.data === 'object' && 'status' in res.data && (res.data as any).status === 'ok');
    } catch {
      return false;
    }
  }

  async sync(): Promise<SyncResult> {
    const queueItems: SyncQueueItem[] = await this.db.all(
      'SELECT * FROM sync_queue ORDER BY created_at ASC'
    );
    if (!queueItems.length) {
      return { success: true, synced_items: 0, failed_items: 0, errors: [] };
    }
    const batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);
    let synced = 0, failed = 0;
    const errors: SyncError[] = [];
    for (let i = 0; i < queueItems.length; i += batchSize) {
      const batch = queueItems.slice(i, i + batchSize);
      try {
        const resp = await this.processBatch(batch);
        for (const item of resp.processed_items) {
          if (item.status === 'success') {
            await this.updateSyncStatus(item.client_id, 'synced', { server_id: item.server_id });
            synced++;
          } else if (item.status === 'conflict') {
            const localTask = await this.taskService.getTask(item.client_id);
            if (localTask && item.resolved_data) {
              const resolved = await this.resolveConflict(localTask, item.resolved_data);
              await this.taskService.updateTask(localTask.id, resolved);
              await this.updateSyncStatus(localTask.id, 'synced', { server_id: item.server_id });
              synced++;
            } else {
              failed++;
              errors.push({ task_id: item.client_id, operation: 'conflict', error: 'Could not resolve', timestamp: new Date() });
            }
          } else {
            failed++;
            errors.push({ task_id: item.client_id, operation: 'sync', error: item.error || 'Unknown error', timestamp: new Date() });
            await this.updateSyncStatus(item.client_id, 'error');
          }
        }
      } catch (err: any) {
        for (const item of batch) {
          failed++;
          errors.push({ task_id: item.task_id, operation: item.operation, error: err.message || 'Batch error', timestamp: new Date() });
          await this.updateSyncStatus(item.task_id, 'error');
        }
      }
    }
    return { success: failed === 0, synced_items: synced, failed_items: failed, errors };
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const { v4: uuidv4 } = require('uuid');
    const now = new Date();
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count) VALUES (?, ?, ?, ?, ?, 0)`,
      [uuidv4(), taskId, operation, JSON.stringify(data), now.toISOString()]
    );
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const checksum = items.map(i => i.id).join('');
    const req: BatchSyncRequest = {
      items,
      client_timestamp: new Date(),
    };
    const resp = await axios.post(`${this.apiUrl}/sync/batch`, { ...req, checksum });
    return resp.data as BatchSyncResponse;
  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localTime = new Date(localTask.updated_at).getTime();
    const serverTime = new Date(serverTask.updated_at).getTime();
    if (localTime > serverTime) {
      return localTask;
    } else if (serverTime > localTime) {
      return serverTask;
    } else {
      if (localTask.is_deleted && !serverTask.is_deleted) return localTask;
      if (!localTask.is_deleted && serverTask.is_deleted) return serverTask;
      return serverTask;
    }
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const now = new Date();
    let setStr = 'sync_status = ?';
    const params: any[] = [status];
    if (status === 'synced') {
      setStr += ', last_synced_at = ?';
      params.push(now.toISOString());
    }
    if (serverData && serverData.server_id) {
      setStr += ', server_id = ?';
      params.push(serverData.server_id);
    }
    params.push(taskId);
    await this.db.run(`UPDATE tasks SET ${setStr} WHERE id = ?`, params);
    if (status === 'synced') {
      await this.db.run('DELETE FROM sync_queue WHERE task_id = ?', [taskId]);
    }
  }




}