import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';
import { AppError } from '../middleware/errorHandler';
import { Task, BatchSyncRequest, BatchSyncResponse } from '../types';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db /*,taskService*/);

  // Trigger manual sync
  router.post('/sync', async (_req: Request, res: Response) => {
    try {
      if (!(await syncService.checkConnectivity())) {
        const error: AppError = new Error('Server not reachable');
        error.statusCode = 503;
        throw error;
      }
      const result = await syncService.sync();
      res.json(result);
    } catch (error) {
      const appError = error as AppError;
      appError.statusCode = appError.statusCode || 500;
      throw appError;
    }
  });

  // Check sync status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const pendingCount = (await db.all(`SELECT COUNT(*) as count FROM sync_queue`))[0].count;
      const lastSyncedTask = await db.get(
        `SELECT last_synced_at FROM tasks WHERE last_synced_at IS NOT NULL ORDER BY last_synced_at DESC LIMIT 1`
      );
      const isOnline = await syncService.checkConnectivity();

      res.json({
        pending_sync_count: pendingCount,
        last_sync_timestamp: lastSyncedTask?.last_synced_at || null,
        is_online: isOnline,
      });
    } catch (error) {
      const appError = error as AppError;
      appError.statusCode = 500;
      throw appError;
    }
  });

  // Batch sync endpoint (server-side)
  router.post('/batch', async (req: Request, res: Response) => {
    try {
      const batchRequest: BatchSyncRequest = req.body;
      const response: BatchSyncResponse = { processed_items: [] };

      for (const item of batchRequest.items) {
        try {
          let serverTask: Task | null = null;
          if (item.operation !== 'create') {
            serverTask = await taskService.getTask(item.data.server_id || item.task_id);
          }

          if (item.operation === 'create') {
            const newTask = await taskService.createTask(item.data);
            response.processed_items.push({
              client_id: item.task_id,
              server_id: newTask.id,
              status: 'success',
              resolved_data: newTask,
            });
          } else if (item.operation === 'update' && serverTask) {
            // Use a public method to resolve conflict
            const resolvedTask = await syncService.resolveTaskConflict(item.data as Task, serverTask);
            const updatedTask = await taskService.updateTask(item.task_id, resolvedTask);
            response.processed_items.push({
              client_id: item.task_id,
              server_id: resolvedTask.server_id || item.task_id,
              status: resolvedTask.id === item.task_id ? 'success' : 'conflict',
              resolved_data: updatedTask || undefined,
            });
          } else if (item.operation === 'delete' && serverTask) {
            await taskService.deleteTask(item.task_id);
            response.processed_items.push({
              client_id: item.task_id,
              server_id: item.data.server_id || item.task_id,
              status: 'success',
            });
          } else {
            throw new Error('Invalid operation or task not found');
          }
        } catch (error) {
          response.processed_items.push({
            client_id: item.task_id,
            server_id: item.data.server_id || item.task_id,
            status: 'error',
            error: (error as Error).message,
          });
        }
      }

      res.json(response);
    } catch (error) {
      const appError = error as AppError;
      appError.statusCode = 500;
      throw appError;
    }
  });

  // Health check endpoint
  router.get('/health', async (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}