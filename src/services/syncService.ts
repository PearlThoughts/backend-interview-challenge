import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
//import { TaskService } from './taskService';  // Uncomment if TaskService methods are needed

export class SyncService {
  private apiUrl: string;
  private batchSize: number;
  private maxRetries: number;

  constructor(
    private db: Database,
    //private taskService: TaskService,  // Uncomment if TaskService methods are needed
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
    this.batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '50');
    this.maxRetries = parseInt(process.env.SYNC_RETRY_ATTEMPTS || '3');
  }

  async sync(): Promise<SyncResult> {
    if (!(await this.checkConnectivity())) {
      throw new Error('Server not reachable');
    }

    const queueItems = await this.db.all(
      `SELECT * FROM sync_queue ORDER BY created_at ASC`
    );

    const result: SyncResult = {
      success: true,
      synced_items: 0,
      failed_items: 0,
      errors: [],
    };

    for (let i = 0; i < queueItems.length; i += this.batchSize) {
      const batch = queueItems.slice(i, i + this.batchSize);
      try {
        const batchResponse = await this.processBatch(batch);
        for (const item of batchResponse.processed_items) {
          if (item.status === 'success' || item.status === 'conflict') {
            await this.updateSyncStatus(item.client_id, 'synced', item.resolved_data);
            result.synced_items++;
          } else {
            await this.handleSyncError(
              batch.find(q => q.task_id === item.client_id)!,
              new Error(item.error || 'Batch sync failed')
            );
            result.failed_items++;
            result.errors.push({
              task_id: item.client_id,
              operation: batch.find(q => q.task_id === item.client_id)!.operation,
              error: item.error || 'Unknown error',
              timestamp: new Date(),
            });
          }
        }
      } catch (error) {
        for (const item of batch) {
          await this.handleSyncError(item, error as Error);
          result.failed_items++;
          result.errors.push({
            task_id: item.task_id,
            operation: item.operation,
            error: (error as Error).message,
            timestamp: new Date(),
          });
        }
        result.success = false;
      }
    }

    return result;
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const queueItem: SyncQueueItem = {
      id: uuidv4(),
      task_id: taskId,
      operation,
      data,
      created_at: new Date(),
      retry_count: 0,
      error_message: undefined, // Changed from null to undefined
    };

    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        queueItem.id,
        queueItem.task_id,
        queueItem.operation,
        JSON.stringify(queueItem.data),
        queueItem.created_at.toISOString(),
        queueItem.retry_count,
        queueItem.error_message,
      ]
    );
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const batchRequest: BatchSyncRequest = {
      items: items.map(item => ({
        ...item,
        data: JSON.parse(item.data as string),
        created_at: new Date(item.created_at),
      })),
      client_timestamp: new Date(),
    };

    try {
      const response = await axios.post(`${this.apiUrl}/batch`, batchRequest, { timeout: 10000 });
      return response.data as BatchSyncResponse;
    } catch (error) {
      throw new Error(`Batch sync failed: ${(error as Error).message}`);
    }
  }

  public async resolveTaskConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localTime = new Date(localTask.updated_at).getTime();
    const serverTime = new Date(serverTask.updated_at).getTime();
    console.log(`Conflict detected for task ${localTask.id}. Local: ${localTask.updated_at}, Server: ${serverTask.updated_at}`);

    const resolvedTask = localTime > serverTime ? localTask : serverTask;
    console.log(`Resolved conflict using last-write-wins: Keeping ${localTime > serverTime ? 'local' : 'server'} version`);

    return resolvedTask;
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    await this.db.run(
      `UPDATE tasks SET sync_status = ?, server_id = ?, last_synced_at = ?
       WHERE id = ?`,
      [
        status,
        serverData?.server_id || undefined,
        status === 'synced' ? new Date().toISOString() : undefined,
        taskId,
      ]
    );

    if (status === 'synced') {
      await this.db.run(`DELETE FROM sync_queue WHERE task_id = ?`, [taskId]);
    }
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const newRetryCount = item.retry_count + 1;
    const errorMessage = error.message;

    if (newRetryCount >= this.maxRetries) {
      await this.db.run(
        `UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`,
        [newRetryCount, errorMessage, item.id]
      );
      await this.db.run(
        `UPDATE tasks SET sync_status = 'error' WHERE id = ?`,
        [item.task_id]
      );
    } else {
      await this.db.run(
        `UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`,
        [newRetryCount, errorMessage, item.id]
      );
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