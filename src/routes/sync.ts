import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  // Create services first and inject them
  const taskService = new TaskService(db, null as any); // Temporarily pass null to break the cycle
  const syncService = new SyncService(db, taskService);
  // Now set the correct syncService on taskService
  (taskService as any).syncService = syncService;

  // Trigger manual sync
  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const isOnline = await syncService.checkConnectivity();
      if (!isOnline) {
        return res.status(503).json({ error: 'Server is currently unreachable' });
      }
      const syncResult = await syncService.sync();
      res.json(syncResult);
    } catch (error) {
      console.error('Sync failed:', error);
      res.status(500).json({ error: 'Failed to perform sync' });
    }
  });

  // Check sync status
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const pendingCount = await db.get(`SELECT COUNT(*) as count FROM sync_queue`);
      const lastSync = await db.get(`SELECT MAX(last_synced_at) as last_synced FROM tasks`);
      const isOnline = await syncService.checkConnectivity();

      res.json({
        status: isOnline ? 'online' : 'offline',
        pending_tasks: pendingCount.count,
        last_sync_at: lastSync.last_synced,
      });
    } catch (error) {
      console.error('Failed to get sync status:', error);
      res.status(500).json({ error: 'Failed to get sync status' });
    }
  });

  // Batch sync endpoint (for server-side)
  router.post('/batch', async (req: Request, res: Response) => {
    res.status(501).json({ error: 'Not implemented on client' });
  });

  // Health check endpoint
  router.get('/health', async (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}