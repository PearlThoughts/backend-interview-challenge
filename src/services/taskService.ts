import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';

export class TaskService {
  constructor(private db: Database) {}

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const id = uuidv4();
    const now = new Date();
    const task: Task = {
      id,
      title: taskData.title!,
      description: taskData.description || '',
      completed: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
      server_id: undefined,
      last_synced_at: undefined,
    };
    await this.db.run(
      `INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.title, task.description, 0, now.toISOString(), now.toISOString(), 0, 'pending']
    );
    // Add to sync queue
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count) VALUES (?, ?, ?, ?, ?, 0)`,
      [uuidv4(), task.id, 'create', JSON.stringify(task), now.toISOString()]
    );
    return task;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existing = await this.db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing || existing.is_deleted) return null;
    const now = new Date();
    const updatedTask = {
      ...existing,
      ...updates,
      updated_at: now.toISOString(),
      sync_status: 'pending',
    };
    await this.db.run(
      `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ? WHERE id = ?`,
      [updatedTask.title, updatedTask.description, updatedTask.completed ? 1 : 0, updatedTask.updated_at, 'pending', id]
    );
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count) VALUES (?, ?, ?, ?, ?, 0)`,
      [uuidv4(), id, 'update', JSON.stringify(updatedTask), now.toISOString()]
    );
    return {
      ...updatedTask,
      completed: !!updatedTask.completed,
      is_deleted: !!updatedTask.is_deleted,
    };
  }

  async deleteTask(id: string): Promise<boolean> {
    const existing = await this.db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) return false;
    const now = new Date();
    await this.db.run(
      `UPDATE tasks SET is_deleted = 1, updated_at = ?, sync_status = ? WHERE id = ?`,
      [now.toISOString(), 'pending', id]
    );
    const deletedTask = await this.db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count) VALUES (?, ?, ?, ?, ?, 0)`,
      [uuidv4(), id, 'delete', JSON.stringify(deletedTask), now.toISOString()]
    );
    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!row || row.is_deleted) return null;
    return {
      ...row,
      completed: !!row.completed,
      is_deleted: !!row.is_deleted,
    };
  }

  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all('SELECT * FROM tasks WHERE is_deleted = 0');
    return rows.map(row => ({
      ...row,
      completed: !!row.completed,
      is_deleted: !!row.is_deleted,
    }));
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const rows = await this.db.all("SELECT * FROM tasks WHERE sync_status IN ('pending', 'error') AND is_deleted = 0");
    return rows.map(row => ({
      ...row,
      completed: !!row.completed,
      is_deleted: !!row.is_deleted,
    }));
  }
}