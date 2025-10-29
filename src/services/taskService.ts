import { v4 as uuidv4 } from 'uuid';
import { Database } from '../db/database';
import { Task } from '../types';

/**
 * TaskService
 * - Implements create, update, delete (soft) operations
 * - Each write operation also creates a sync_queue entry so offline changes are tracked
 */
export class TaskService {
  constructor(private db: Database) {}

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const title = (taskData.title || '').trim();
    if (!title) throw new Error('title is required');

    const task: Task = {
      id,
      title,
      description: taskData.description || null,
      completed: taskData.completed ?? false,
      created_at: new Date(now),
      updated_at: new Date(now),
      is_deleted: false,
      sync_status: 'pending',
      server_id: undefined,
      last_synced_at: undefined,
    };

    const insertSql = `
      INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status, server_id, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.run(insertSql, [
      task.id,
      task.title,
      task.description,
      task.completed ? 1 : 0,
      now,
      now,
      0,
      task.sync_status,
      null,
      null,
    ]);

    // Add to sync queue
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, retry_count) VALUES (?, ?, ?, ?, 0)`,
      [uuidv4(), task.id, 'create', JSON.stringify(task)]
    );

    return task;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existing = await this.db.get<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated = {
      ...existing,
      title: updates.title ?? existing.title,
      description: updates.description ?? existing.description,
      completed: updates.completed ?? !!existing.completed,
      updated_at: new Date(now),
      sync_status: 'pending',
    };

    const updateSql = `
      UPDATE tasks
      SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ?
      WHERE id = ?
    `;
    await this.db.run(updateSql, [
      updated.title,
      updated.description,
      updated.completed ? 1 : 0,
      now,
      updated.sync_status,
      id,
    ]);

    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, retry_count) VALUES (?, ?, ?, ?, 0)`,
      [uuidv4(), id, 'update', JSON.stringify(updated)]
    );

    return updated;
  }

  async deleteTask(id: string): Promise<boolean> {
    const existing = await this.db.get<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) return false;

    const now = new Date().toISOString();
    // soft delete
    await this.db.run(
      `UPDATE tasks SET is_deleted = 1, updated_at = ?, sync_status = ? WHERE id = ?`,
      [now, 'pending', id]
    );

    // enqueue delete operation with the snapshot of task data
    const snapshot = { ...existing, is_deleted: true, updated_at: new Date(now) };
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, retry_count) VALUES (?, ?, ?, ?, 0)`,
      [uuidv4(), id, 'delete', JSON.stringify(snapshot)]
    );

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get<any>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all<any[]>('SELECT * FROM tasks WHERE is_deleted = 0 ORDER BY created_at DESC', []);
    return rows.map(this.mapRowToTask);
  }

  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id || undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    };
  }
}