import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Trigger manual sync backend-interview-challenge
  router.post('/sync', async (_req: Request, res: Response) => {
    try {
      const online = await syncService.checkConnectivity();
      if (!online) return res.status(503).json({ error: 'Server not reachable' });
      const result = await syncService.sync();
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: 'Sync failed' });
    }
  });

  // Check sync status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const pending = await db.all("SELECT COUNT(*) as count FROM sync_queue");
      const lastSync = await db.get("SELECT MAX(last_synced_at) as last FROM tasks");
      const online = await syncService.checkConnectivity();
      return res.json({
        pending: pending[0]?.count || 0,
        last_synced_at: lastSync?.last,
        online,
      });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to get sync status' });
    }
  });

  // Batch sync endpoint (for server-side)
  router.post('/batch', async (req: Request, res: Response) => {
    // Simulate server-side batch sync: echo back processed_items as success
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Invalid batch' });
    const processed_items = items.map((item: any) => ({
      client_id: item.task_id,
      server_id: 'srv_' + item.task_id,
      status: 'success',
    }));
    return res.json({ processed_items });
  });

  // Health check endpoint
  router.get('/health', async (_req: Request, res: Response) => {
    return res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}