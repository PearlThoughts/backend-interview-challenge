import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';
import { SyncService } from './syncService';

export class TaskService {
  private syncService: SyncService;

  constructor(private db: Database) {
    this.syncService = new SyncService(db /*, this*/);
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {
    if (!taskData.title) {
      throw new Error('Task title is required');
    }

    const task: Task = {
      id: uuidv4(),
      title: taskData.title,
      description: taskData.description || '',
      completed: taskData.completed || false,
      created_at: new Date(),
      updated_at: new Date(),
      is_deleted: false,
      sync_status: 'pending',
      server_id: undefined, // Changed from null
      last_synced_at: undefined, // Changed from null
    };

    await this.db.run(
      `INSERT INTO tasks (id, title, description, completed, created_at, updated_at, is_deleted, sync_status, server_id, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.title,
        task.description,
        task.completed ? 1 : 0,
        task.created_at.toISOString(),
        task.updated_at.toISOString(),
        task.is_deleted ? 1 : 0,
        task.sync_status,
        task.server_id,
        task.last_synced_at,
      ]
    );

    await this.syncService.addToSyncQueue(task.id, 'create', task);
    return task;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existingTask = await this.getTask(id);
    if (!existingTask || existingTask.is_deleted) {
      return null;
    }

    const updatedTask: Task = {
      ...existingTask,
      title: updates.title ?? existingTask.title,
      description: updates.description ?? existingTask.description,
      completed: updates.completed ?? existingTask.completed,
      updated_at: new Date(),
      sync_status: 'pending',
    };

    await this.db.run(
      `UPDATE tasks SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ?
       WHERE id = ? AND is_deleted = 0`,
      [
        updatedTask.title,
        updatedTask.description,
        updatedTask.completed ? 1 : 0,
        updatedTask.updated_at.toISOString(),
        updatedTask.sync_status,
        id,
      ]
    );

    await this.syncService.addToSyncQueue(id, 'update', updatedTask);
    return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    const existingTask = await this.getTask(id);
    if (!existingTask || existingTask.is_deleted) {
      return false;
    }

    await this.db.run(
      `UPDATE tasks SET is_deleted = 1, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      [new Date().toISOString(), id]
    );

    await this.syncService.addToSyncQueue(id, 'delete', { id });
    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get(
      `SELECT * FROM tasks WHERE id = ? AND is_deleted = 0`,
      [id]
    );

    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    };
  }

  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all(
      `SELECT * FROM tasks WHERE is_deleted = 0`
    );

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    }));
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const rows = await this.db.all(
      `SELECT * FROM tasks WHERE sync_status IN ('pending', 'error') AND is_deleted = 0`
    );

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    }));
  }
}