import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';

export class TaskService {
  constructor(private db: Database) {}

  async createTask(taskData: Partial<Task>): Promise<Task> {
    // TODO: Implement task creation
    // 1. Generate UUID for the task
    // 2. Set default values (completed: false, is_deleted: false)
    // 3. Set sync_status to 'pending'
    // 4. Insert into database
    // 5. Add to sync queue
    //throw new Error('Not implemented');
    const id = uuidv4();
    const newTask: Task = {
        id,
        title: taskData.title || '',
        description: taskData.description || '',
        completed: false,
        created_at: new Date(),
        updated_at: new Date(),
        is_deleted: false,
        sync_status: taskData.sync_status || 'pending',
    };
    await this.db.createTask(newTask);
    if (newTask.sync_status !== 'synced')
      await this.db.addToSyncQueue(newTask.id, 'create', newTask);
    return newTask;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    // TODO: Implement task update
    // 1. Check if task exists
    // 2. Update task in database
    // 3. Update updated_at timestamp
    // 4. Set sync_status to 'pending'
    // 5. Add to sync queue
    //throw new Error('Not implemented');
      const existingTask = await this.db.getTaskById(id);
      if (!existingTask || existingTask.is_deleted) return null;

      const updatedTask: Task = {
          ...existingTask,
          ...updates,
          updated_at: new Date(),
          sync_status: updates.sync_status === 'synced' ? 'synced' : 'pending',
      };

      await this.db.updateTask(id, updatedTask);

      if (updatedTask.sync_status !== 'synced') {
          await this.db.addToSyncQueue(id, 'update', updatedTask);
      }

      return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    // TODO: Implement soft delete
    // 1. Check if task exists
    // 2. Set is_deleted to true
    // 3. Update updated_at timestamp
    // 4. Set sync_status to 'pending'
    // 5. Add to sync queue
    //throw new Error('Not implemented');
      const existingTask = await this.db.getTaskById(id);
      if (!existingTask || existingTask.is_deleted) return false;

      await this.db.deleteTask(id);

      if (existingTask.sync_status !== 'synced') {
          await this.db.addToSyncQueue(id, 'delete', existingTask);
      }

      return true;
  }

  async getTask(id: string): Promise<Task | null> {
    // TODO: Implement get single task
    // 1. Query database for task by id
    // 2. Return null if not found or is_deleted is true
    //throw new Error('Not implemented');
      const task = await this.db.getTaskById(id);
      if (!task || task.is_deleted) {
          return null;
      }
      return task;
  }

  async getAllTasks(): Promise<Task[]> {
    // TODO: Implement get all non-deleted tasks
    // 1. Query database for all tasks where is_deleted = false
    // 2. Return array of tasks
    //throw new Error('Not implemented');
    return this.db.getAllTasks();
  }

  async getTasksNeedingSync(): Promise<any[]> {
    // TODO: Get all tasks with sync_status = 'pending' or 'error'
    //throw new Error('Not implemented');
      return this.db.getTasksNeedSync();
  }
}