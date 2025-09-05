import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';
import { SyncService } from './syncService';

export class TaskService {
  private syncService: SyncService;

  constructor(private db: Database, syncService: SyncService) {
    this.syncService = syncService;
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {
    const now = new Date().toISOString();
    const newTask: Task = {
      id: uuidv4(),
      title: taskData.title || 'New Task',
      description: taskData.description || null,
      completed: taskData.completed || false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
      server_id: null,
      last_synced_at: null,
    };

    const sql = `
      INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status, server_id, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.run(sql, [
      newTask.id,
      newTask.title,
      newTask.description,
      newTask.completed,
      newTask.created_at,
      newTask.updated_at,
      newTask.is_deleted,
      newTask.sync_status,
      newTask.server_id,
      newTask.last_synced_at,
    ]);

    await this.syncService.addToSyncQueue(newTask.id, 'create', newTask);
    return newTask;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existingTask = await this.getTask(id);
    if (!existingTask) {
      return null;
    }

    const now = new Date().toISOString();
    const updatedTask = { ...existingTask, ...updates, updated_at: now, sync_status: 'pending' };

    const sql = `
      UPDATE tasks
      SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ?
      WHERE id = ? AND is_deleted = 0
    `;
    await this.db.run(sql, [
      updatedTask.title,
      updatedTask.description,
      updatedTask.completed,
      updatedTask.updated_at,
      updatedTask.sync_status,
      id,
    ]);

    await this.syncService.addToSyncQueue(id, 'update', updates);
    return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    const existingTask = await this.getTask(id);
    if (!existingTask) {
      return false;
    }

    const now = new Date().toISOString();
    const sql = `
      UPDATE tasks
      SET is_deleted = 1, updated_at = ?, sync_status = 'pending'
      WHERE id = ?
    `;
    await this.db.run(sql, [now, id]);

    await this.syncService.addToSyncQueue(id, 'delete', { is_deleted: true });
    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const sql = `
      SELECT * FROM tasks WHERE id = ? AND is_deleted = 0
    `;
    const row = await this.db.get(sql, [id]);
    return row as Task || null;
  }

  async getAllTasks(): Promise<Task[]> {
    const sql = `
      SELECT * FROM tasks WHERE is_deleted = 0
    `;
    const rows = await this.db.all(sql);
    return rows as Task[];
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const sql = `
      SELECT * FROM tasks WHERE sync_status IN ('pending', 'error')
    `;
    const rows = await this.db.all(sql);
    return rows as Task[];
  }
}
