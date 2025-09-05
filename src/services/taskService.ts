import { v4 as uuidv4 } from "uuid";
import { Task } from "../types";
import { Database } from "../db/database";

export class TaskService {
  constructor(private db: Database) {}

  // CREATE
  async createTask(title: string, description?: string): Promise<Task> {
    const now = new Date();

    const newTask: Task = {
      id: uuidv4(),
      title,
      description,
      completed: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: "pending",
    };

    await this.db.run(
      `INSERT INTO tasks 
        (id, title, description, completed, created_at, updated_at, is_deleted, sync_status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newTask.id,
        newTask.title,
        newTask.description || null,
        newTask.completed ? 1 : 0,
        newTask.created_at.toISOString(),
        newTask.updated_at.toISOString(),
        newTask.is_deleted ? 1 : 0,
        newTask.sync_status,
      ]
    );

    return newTask;
  }

  // UPDATE
  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existing = await this.getTask(id);
    if (!existing) return null;

    const now = new Date();

    const updatedTask: Task = {
      ...existing,
      ...updates,
      updated_at: now,
      sync_status: "pending",
    };

    await this.db.run(
      `UPDATE tasks 
       SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ? 
       WHERE id = ?`,
      [
        updatedTask.title,
        updatedTask.description || null,
        updatedTask.completed ? 1 : 0,
        updatedTask.updated_at.toISOString(),
        updatedTask.sync_status,
        id,
      ]
    );

    return updatedTask;
  }

  // DELETE (soft delete)
  async deleteTask(id: string): Promise<boolean> {
    const existing = await this.getTask(id);
    if (!existing) return false;

    await this.db.run(
      `UPDATE tasks 
       SET is_deleted = 1, updated_at = ?, sync_status = ? 
       WHERE id = ?`,
      [new Date().toISOString(), "pending", id]
    );

    return true;
  }

  // GET ONE
  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!row || row.is_deleted) return null;

    return this.mapRowToTask(row);
  }

  // GET ALL
  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all(`SELECT * FROM tasks WHERE is_deleted = 0`);
    return rows.map((row) => this.mapRowToTask(row));
  }

  // GET tasks needing sync
  async getTasksNeedingSync(): Promise<Task[]> {
  const rows = await this.db.all(
    "SELECT * FROM tasks WHERE sync_status IN ('pending', 'error') AND is_deleted = 0"
  );
  return rows.map((row) => ({
    ...row,
    completed: row.completed === 1,
    is_deleted: row.is_deleted === 1,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
  }));
}


  // 🔹 Helper: Convert DB row → Task object
  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status || "pending",
      server_id: row.server_id || undefined,
      last_synced_at: row.last_synced_at
        ? new Date(row.last_synced_at)
        : undefined,
    };
  }
}
