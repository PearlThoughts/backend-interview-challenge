import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Get all tasks
  router.get('/', async (req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    // TODO: Implement task creation endpoint
    // 1. Validate request body
    // 2. Call taskService.createTask()
    // 3. Return created task
    // res.status(501).json({ error: 'Not implemented' });
      try {
          const { title, description, sync_status } = req.body;

          // If status is 'synced', directly save (this came from server sync)
          if (sync_status === 'synced') {
              const task = await taskService.createTask({ title, description, sync_status: 'synced' });
              return res.status(201).json(task);
          }

          // Else mark as 'pending' and push to sync queue
          const task = await taskService.createTask({ title, description, sync_status: 'pending' });
          res.status(201).json(task);
      } catch (error) {
          res.status(500).json({ error: 'Failed to create task' });
      }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    // TODO: Implement task update endpoint
    // 1. Validate request body
    // 2. Call taskService.updateTask()
    // 3. Handle not found case
    // 4. Return updated task
    // res.status(501).json({ error: 'Not implemented' });
      try {
          const updates = req.body;
          const id = req.params.id;

          // If it's synced (e.g., server confirmed update)
          if (updates.sync_status === 'synced') {
              const updated = await taskService.updateTask(id, { ...updates, sync_status: 'synced' });
              return res.json(updated);
          }

          const updatedTask = await taskService.updateTask(id, updates);
          if (!updatedTask) return res.status(404).json({ error: 'Task not found' });
          res.json(updatedTask);
      } catch (error) {
          res.status(500).json({ error: 'Failed to update task' });
      }

  });

  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    // TODO: Implement task deletion endpoint
    // 1. Call taskService.deleteTask()
    // 2. Handle not found case
    // 3. Return success response
    // res.status(501).json({ error: 'Not implemented' });
      try {
          const { sync_status } = req.body;
          const id = req.params.id;

          // If deletion already confirmed from server
          if (sync_status === 'synced') {
              await taskService.deleteTask(id);
              return res.json({ success: true });
          }

          const deleted = await taskService.deleteTask(id);
          if (!deleted) return res.status(404).json({ error: 'Task not found' });
          res.json({ success: true });
      } catch (error) {
          res.status(500).json({ error: 'Failed to delete task' });
      }

  });

  return router;
}