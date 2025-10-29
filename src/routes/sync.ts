import express from 'express';
import { Database } from '../db/database';
import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem } from '../types';
import { CHALLENGE_CONSTRAINTS } from '../utils/challenge-constraints';
import { SyncService } from '../services/syncService';

/**
 * Server-side sync routes.
 *
 * - POST /api/sync/trigger -> triggers local sync orchestration (calls SyncService.sync)
 * - GET  /api/sync/status  -> returns basic sync queue stats
 * - POST /api/sync/batch   -> receives a batch of items from a client and acts as the authoritative server side.
 *
 * Notes:
 * - The batch endpoint implements a simple last-write-wins approach and returns per-item results:
 *   { queue_id, task_id, status: 'ok'|'conflict'|'error', server_task?, error? }
 */
export function createSyncRouter(db: Database, syncService?: SyncService) {
  const router = express.Router();
  const svc = syncService ?? new SyncService(db as any, null as any);

  // Trigger local sync orchestration (this will cause the server to POST to /api/sync/batch if applicable)
  router.post('/trigger', async (_req, res) => {
    try {
      const result = await svc.sync();
      res.json({ data: result });
    } catch (err: any) {
      console.error('POST /api/sync/trigger error', err);
      res.status(500).json({ error: 'Failed to run sync' });
    }
  });

  // Basic status for debugging: counts in sync_queue
  router.get('/status', async (_req, res) => {
    try {
      const total = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM sync_queue', []);
      const failed = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM sync_queue WHERE retry_count >= 3', []);
      res.json({ data: { pending: total?.count ?? 0, dead_letter: failed?.count ?? 0 } });
    } catch (err: any) {
      console.error('GET /api/sync/status error', err);
      res.status(500).json({ error: 'Failed to fetch sync status' });
    }
  });

  // Batch endpoint: accepts array of items and returns per-item result
  router.post('/batch', express.json(), async (req, res) => {
    try {
      const body = req.body;
      if (!body || !Array.isArray(body.items)) return res.status(400).json({ error: 'Invalid payload: items[] required' });

      const results: any[] = [];

      for (const raw of body.items) {
        const { queue_id, task_id, operation, data } = raw;
        try {
          const clientTask: Task = {
            id: data.id,
            title: data.title,
            description: data.description,
            completed: !!data.completed,
            created_at: new Date(data.created_at),
            updated_at: new Date(data.updated_at),
            is_deleted: !!data.is_deleted,
            sync_status: data.sync_status,
            server_id: data.server_id,
            last_synced_at: data.last_synced_at ? new Date(data.last_synced_at) : undefined,
          };

          // match by server_id first, then by id
          const serverRowByServerId = clientTask.server_id
            ? await db.get<any>('SELECT * FROM tasks WHERE server_id = ?', [clientTask.server_id])
            : null;
          const serverRowById = await db.get<any>('SELECT * FROM tasks WHERE id = ?', [clientTask.id]);

          const serverRow = serverRowByServerId ?? serverRowById;

          if (!serverRow) {
            // No server record: create if client operation is not an update/delete conflict
            if (operation === 'delete') {
              // deleting something server doesn't have: treat as ok (idempotent)
              results.push({ queue_id, task_id, status: 'ok', server_task: null });
              continue;
            }

            const serverId = uuidv4();
            const now = new Date().toISOString();
            await db.run(
              `INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status, server_id, last_synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                clientTask.id,
                clientTask.title,
                clientTask.description,
                clientTask.completed ? 1 : 0,
                clientTask.created_at.toISOString(),
                clientTask.updated_at.toISOString(),
                clientTask.is_deleted ? 1 : 0,
                'synced',
                serverId,
                now,
              ]
            );

            const serverTask = { ...clientTask, server_id: serverId, last_synced_at: new Date() };
            results.push({ queue_id, task_id, status: 'ok', server_task: serverTask });
            continue;
          }

          // serverRow exists: determine conflict based on updated_at
          const serverTask: Task = {
            id: serverRow.id,
            title: serverRow.title,
            description: serverRow.description,
            completed: !!serverRow.completed,
            created_at: new Date(serverRow.created_at),
            updated_at: new Date(serverRow.updated_at),
            is_deleted: !!serverRow.is_deleted,
            sync_status: serverRow.sync_status,
            server_id: serverRow.server_id,
            last_synced_at: serverRow.last_synced_at ? new Date(serverRow.last_synced_at) : undefined,
          };

          const clientTs = clientTask.updated_at.getTime();
          const serverTs = serverTask.updated_at.getTime();

          if (clientTs > serverTs) {
            // client newer: apply client's change to server
            const now = new Date().toISOString();
            await db.run(
              `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, is_deleted = ?, sync_status = ?, last_synced_at = ? WHERE server_id = ?`,
              [
                clientTask.title,
                clientTask.description,
                clientTask.completed ? 1 : 0,
                clientTask.updated_at.toISOString(),
                clientTask.is_deleted ? 1 : 0,
                'synced',
                now,
                serverTask.server_id,
              ]
            );
            const updatedServerTask = { ...clientTask, server_id: serverTask.server_id, last_synced_at: new Date() };
            results.push({ queue_id, task_id, status: 'ok', server_task: updatedServerTask });
          } else if (serverTs > clientTs) {
            // server newer: conflict
            results.push({ queue_id, task_id, status: 'conflict', server_task: serverTask });
          } else {
            // timestamps equal -> use operation priority (delete > update > create)
            const priority = CHALLENGE_CONSTRAINTS.CONFLICT_PRIORITY || { delete: 3, update: 2, create: 1 };
            const clientPriority = priority[operation] ?? 0;
            // server operation: infer from server is_deleted flag
            const serverOp = serverTask.is_deleted ? 'delete' : 'update';
            const serverPriority = priority[serverOp] ?? 0;

            if (clientPriority > serverPriority) {
              // client wins
              const now = new Date().toISOString();
              await db.run(
                `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, is_deleted = ?, sync_status = ?, last_synced_at = ? WHERE server_id = ?`,
                [
                  clientTask.title,
                  clientTask.description,
                  clientTask.completed ? 1 : 0,
                  clientTask.updated_at.toISOString(),
                  clientTask.is_deleted ? 1 : 0,
                  'synced',
                  now,
                  serverTask.server_id,
                ]
              );
              const updatedServerTask = { ...clientTask, server_id: serverTask.server_id, last_synced_at: new Date() };
              results.push({ queue_id, task_id, status: 'ok', server_task: updatedServerTask });
            } else {
              // server wins
              results.push({ queue_id, task_id, status: 'conflict', server_task: serverTask });
            }
          }
        } catch (err: any) {
          console.error('Error processing batch item', raw, err);
          results.push({ queue_id: raw.queue_id, task_id: raw.task_id, status: 'error', error: String(err) });
        }
      }

      res.json({ results });
    } catch (err: any) {
      console.error('POST /api/sync/batch error', err);
      res.status(500).json({ error: 'Failed to process batch' });
    }
  });

  return router;
}