import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Trigger manual sync
  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const online = await syncService.checkConnectivity();
      if (!online) {
        return res.status(503).json({ error: 'Server unreachable. Try again later.' });
      }
      const result = await syncService.sync();
      return res.json(result);
    } catch (error) {
      console.error('POST /api/sync error', error);
      return res.status(500).json({ error: 'Sync failed' });
    }
  });

  // Check sync status
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const pending = await db.get(`SELECT COUNT(1) as cnt FROM sync_queue WHERE status IN ('pending', 'error')`);
      const lastSynced = await db.get(`SELECT MAX(last_synced_at) as last FROM tasks WHERE last_synced_at IS NOT NULL`);
      const online = await syncService.checkConnectivity();
      return res.json({
        pending: pending?.cnt ?? 0,
        last_synced_at: lastSynced?.last ?? null,
        online,
      });
    } catch (error) {
      console.error('GET /api/status error', error);
      return res.status(500).json({ error: 'Failed to fetch sync status' });
    }
  });

  // Batch sync endpoint (intended for server side)
  // For testing local end-to-end, we implement a simple handler that applies incoming tasks
  router.post('/batch', async (req: Request, res: Response) => {
    // Expected body: { tasks: Task[] }
    try {
      const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
      const applied: any[] = [];
      const conflicts: any[] = [];
      const rejected: any[] = [];

      for (const incoming of tasks) {
        // naive server-side merge: if task id exists and server updated_at > incoming then it's a conflict
        const existingRow = await db.get(`SELECT * FROM tasks WHERE id = ?`, [incoming.id]);
        if (!existingRow) {
          // create new server task
          await db.run(
            `INSERT INTO tasks (id, title, description, completed, is_deleted, sync_status, created_at, updated_at, server_id, server_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              incoming.id,
              incoming.title ?? '',
              incoming.description ?? '',
              incoming.completed ? 1 : 0,
              incoming.is_deleted ? 1 : 0,
              'synced',
              incoming.created_at ?? new Date().toISOString(),
              incoming.updated_at ?? new Date().toISOString(),
              incoming.id,
              incoming.server_version ?? 1,
            ]
          );
          applied.push(incoming);
          continue;
        }

        // both exist -> compare updated_at
        const serverTs = new Date(existingRow.updated_at).getTime();
        const incomingTs = incoming.updated_at ? new Date(incoming.updated_at).getTime() : Date.now();

        if (incomingTs >= serverTs) {
          // apply incoming, update server copy
          await db.run(
            `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = 'synced', server_version = COALESCE(?, server_version) WHERE id = ?`,
            [incoming.title ?? existingRow.title, incoming.description ?? existingRow.description, incoming.completed ? 1 : 0, incoming.updated_at ?? new Date().toISOString(), incoming.server_version ?? existingRow.server_version, incoming.id]
          );
          applied.push(incoming);
        } else {
          // conflict: server has newer
          conflicts.push({ incoming, server: existingRow });
        }
      }

      const response = { applied, conflicts, rejected };
      return res.json(response);
    } catch (error) {
      console.error('POST /api/batch error', error);
      return res.status(500).json({ error: 'Batch processing failed' });
    }
  });

  // Health check endpoint
  router.get('/health', async (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}
