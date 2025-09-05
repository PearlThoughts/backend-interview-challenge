import axios from 'axios';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse, SyncError } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';
import { v4 as uuidv4 } from 'uuid';

const SYNC_BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '10', 10);
const SYNC_RETRY_LIMIT = parseInt(process.env.SYNC_RETRY_LIMIT || '5', 10);

export class SyncService {
  private apiUrl: string;
  
  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }

  async sync(): Promise<SyncResult> {
    const syncResult: SyncResult = {
      success: true,
      synced_items: 0,
      failed_items: 0,
      errors: [],
    };

    try {
      const queueItems: SyncQueueItem[] = await this.db.all('SELECT * FROM sync_queue ORDER BY created_at ASC');
      const batches = this.chunkArray(queueItems, SYNC_BATCH_SIZE);
      
      for (const batch of batches) {
        try {
          const response = await this.processBatch(batch);
          for (const processedItem of response.processed_items) {
            const originalItem = batch.find(item => item.id === processedItem.client_id);
            if (!originalItem) continue;

            if (processedItem.status === 'success' || processedItem.status === 'conflict') {
              syncResult.synced_items++;
              await this.updateSyncStatus(originalItem.task_id, 'synced', processedItem.resolved_data);
              await this.db.run('DELETE FROM sync_queue WHERE id = ?', [originalItem.id]);
            } else {
              syncResult.failed_items++;
              const error = new Error(processedItem.error || 'Unknown error');
              await this.handleSyncError(originalItem, error);
              syncResult.errors.push({
                task_id: originalItem.task_id,
                operation: originalItem.operation,
                error: error.message,
                timestamp: new Date(),
              });
            }
          }
        } catch (error) {
          console.error('Batch sync failed:', error);
          syncResult.success = false;
          syncResult.failed_items += batch.length;
          for (const item of batch) {
            await this.handleSyncError(item, error as Error);
            syncResult.errors.push({
              task_id: item.task_id,
              operation: item.operation,
              error: (error as Error).message,
              timestamp: new Date(),
            });
          }
        }
      }
      return syncResult;
    } catch (error) {
      console.error('Sync failed:', error);
      return {
        success: false,
        synced_items: 0,
        failed_items: 0,
        errors: [{ task_id: 'n/a', operation: 'sync', error: (error as Error).message, timestamp: new Date() }],
      };
    }
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const id = uuidv4();
    const serializedData = JSON.stringify(data);
    const sql = `
      INSERT INTO sync_queue (id, task_id, operation, data)
      VALUES (?, ?, ?, ?)
    `;
    await this.db.run(sql, [id, taskId, operation, serializedData]);
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    const batchRequest: BatchSyncRequest = {
      items,
      client_timestamp: new Date(),
    };

    const response = await axios.post<BatchSyncResponse>(`${this.apiUrl}/batch`, batchRequest, { timeout: 10000 });
    return response.data;
  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localTimestamp = new Date(localTask.updated_at).getTime();
    const serverTimestamp = new Date(serverTask.updated_at).getTime();
    
    if (serverTimestamp > localTimestamp) {
      console.log(`Conflict resolved: Server version for task ${localTask.id} is more recent.`);
      return serverTask;
    }
    
    console.log(`Conflict resolved: Local version for task ${localTask.id} is more recent.`);
    return localTask;
  }

  async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const now = new Date().toISOString();
    let sql = '';
    let params = [];

    if (status === 'synced') {
      sql = `
        UPDATE tasks
        SET sync_status = 'synced', last_synced_at = ?, server_id = COALESCE(?, server_id)
        WHERE id = ?
      `;
      params = [now, serverData?.server_id, taskId];
    } else {
      sql = `
        UPDATE tasks
        SET sync_status = 'error'
        WHERE id = ?
      `;
      params = [taskId];
    }

    await this.db.run(sql, params);
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const newRetryCount = item.retry_count + 1;
    const errorMessage = error.message;

    if (newRetryCount > SYNC_RETRY_LIMIT) {
      console.error(`Max retries exceeded for task ${item.task_id}. Marking as permanent failure.`);
      await this.db.run(
        `UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`,
        [newRetryCount, errorMessage, item.id]
      );
      await this.updateSyncStatus(item.task_id, 'error');
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
    } catch (error) {
      console.error('Connectivity check failed:', (error as Error).message);
      return false;
    }
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunkedArr: T[][] = [];
    let index = 0;
    while (index < array.length) {
      chunkedArr.push(array.slice(index, index + size));
      index += size;
    }
    return chunkedArr;
  }
}
