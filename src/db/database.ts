// src/db/database.ts
import sqlite3 from 'sqlite3';
import path from 'path';

sqlite3.verbose();

export class Database {
  private db: sqlite3.Database;

  // Default to in-memory DB for tests; production can pass a filename
  constructor(filename: string = ':memory:') {
    this.db = new sqlite3.Database(filename);
  }

  async initialize(): Promise<void> {
    await this.createTables();
    await this.createIndexes();
  }

  private async createTables(): Promise<void> {
    // tasks table with all columns used by TaskService/SyncService/tests
    const createTasksTable = `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        completed INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        is_deleted INTEGER DEFAULT 0,
        sync_status TEXT DEFAULT 'pending',
        server_id TEXT,
        client_version INTEGER DEFAULT 0,
        server_version INTEGER DEFAULT 0,
        last_synced_at TEXT
      );
    `;

    // sync_queue table with columns used by services (retries/status/error)
    const createSyncQueueTable = `
      CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        data TEXT NOT NULL,
        retries INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
    `;

    await this.run(createTasksTable);
    await this.run(createSyncQueueTable);
  }

  private async createIndexes(): Promise<void> {
    const idxs = [
      `CREATE INDEX IF NOT EXISTS idx_tasks_is_deleted ON tasks(is_deleted);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_sync_status ON tasks(sync_status);`,
      `CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);`,
      `CREATE INDEX IF NOT EXISTS idx_sync_queue_task_id ON sync_queue(task_id);`,
    ];
    for (const sql of idxs) {
      // ignore errors if any
      // eslint-disable-next-line no-await-in-loop
      await this.run(sql);
    }
  }

  // run (no result)
  run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err: Error | null) {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  // get single row
  get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      this.db.get(sql, params, (err: Error | null, row: any) => {
        if (err) return reject(err);
        resolve(row as T | undefined);
      });
    });
  }

  // get all rows
  all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      this.db.all(sql, params, (err: Error | null, rows: any[]) => {
        if (err) return reject(err);
        resolve(rows as T[]);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}
