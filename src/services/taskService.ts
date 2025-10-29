import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';

const nowIso = () => new Date().toISOString();

export class TaskService {
  constructor(private db: Database) {}

  private mapRowToTask(row: any): Task {
    if (!row) return null as any;
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? '',
      completed: !!row.completed,
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status ?? 'pending',
      created_at: row.created_at,
      updated_at: row.updated_at,
      server_id: row.server_id ?? null,
      client_version: row.client_version ?? 0,
      server_version: row.server_version ?? 0,
      last_synced_at: row.last_synced_at ?? null,
    } as Task;
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const id = taskData.id ?? uuidv4();
    const title = taskData.title ?? 'Untitled';
    const description = taskData.description ?? '';
    const completed = taskData.completed ? 1 : 0;
    const is_deleted = 0;
    const sync_status = 'pending';
    const created_at = taskData.created_at ?? nowIso();
    const updated_at = taskData.updated_at ?? created_at;
    const client_version = taskData.client_version ?? 0;
    const server_version = taskData.server_version ?? 1;
    const last_synced_at = taskData.last_synced_at ?? null;
    const server_id = taskData.server_id ?? null;

    const sql = `
      INSERT INTO tasks (id, title, description, completed, is_deleted, sync_status, created_at, updated_at, client_version, server_version, last_synced_at, server_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.run(sql, [
      id,
      title,
      description,
      completed,
      is_deleted,
      sync_status,
      created_at,
      updated_at,
      client_version,
      server_version,
      last_synced_at,
      server_id,
    ]);

    // Optionally add to sync_queue
    await this.addToSyncQueue(id, 'create', {
      id,
      title,
      description,
      completed: !!completed,
      updated_at,
      client_version,
      server_version,
    });

    const row = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    return this.mapRowToTask(row);
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existingRow = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!existingRow) return null;

    const title = updates.title ?? existingRow.title;
    const description = updates.description ?? existingRow.description;
    const completed = typeof updates.completed === 'boolean' ? (updates.completed ? 1 : 0) : existingRow.completed;
    const updated_at = updates.updated_at ?? nowIso();
    const client_version = (updates.client_version ?? existingRow.client_version ?? 0) + 1;
    const server_version = (existingRow.server_version ?? 0) + 1;
    const sync_status = 'pending';

    const sql = `
      UPDATE tasks SET
        title = ?,
        description = ?,
        completed = ?,
        updated_at = ?,
        client_version = ?,
        server_version = ?,
        sync_status = ?
      WHERE id = ?
    `;
    await this.db.run(sql, [title, description, completed, updated_at, client_version, server_version, sync_status, id]);

    // add to sync queue
    await this.addToSyncQueue(id, 'update', {
      id,
      title,
      description,
      completed: !!completed,
      updated_at,
      client_version,
      server_version,
    });

    const row = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    return this.mapRowToTask(row);
  }

  async deleteTask(id: string): Promise<boolean> {
    const existingRow = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!existingRow) return false;

    const updated_at = nowIso();
    const sync_status = 'pending';
    await this.db.run(
      `UPDATE tasks SET is_deleted = 1, updated_at = ?, sync_status = ?, server_version = server_version + 1 WHERE id = ?`,
      [updated_at, sync_status, id]
    );

    // add to sync queue
    await this.addToSyncQueue(id, 'delete', {
      id,
      updated_at,
    });

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!row) return null;
    if (row.is_deleted) return null;
    return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all(`SELECT * FROM tasks WHERE is_deleted = 0 ORDER BY updated_at DESC`);
    return (rows || []).map((r: any) => this.mapRowToTask(r));
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const rows = await this.db.all(
      `SELECT * FROM tasks WHERE sync_status IN ('pending', 'error') ORDER BY updated_at ASC`
    );
    return (rows || []).map((r: any) => this.mapRowToTask(r));
  }

  // Local helper: push a sync queue entry (uses same db)
  private async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>) {
    const id = uuidv4();
    const created_at = nowIso();
    const updated_at = created_at;
    const retries = 0;
    const status = 'pending';
    const error = null;
    const sql = `
      INSERT INTO sync_queue (id, task_id, operation, data, retries, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.run(sql, [id, taskId, operation, JSON.stringify(data), retries, status, error, created_at, updated_at]);
  }
}
