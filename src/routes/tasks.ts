import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  // const syncService = new SyncService(db, taskService); // Not used, can be removed

  // Get all tasks
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      return res.json(tasks);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.json(task);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    const { title, description } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required' });
    }
    try {
      const task = await taskService.createTask({ title, description });
      return res.status(201).json(task);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const updates = req.body;
    if (updates.title && typeof updates.title !== 'string') {
      return res.status(400).json({ error: 'Title must be a string' });
    }
    try {
      const updated = await taskService.updateTask(id, updates);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      return res.json(updated);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const deleted = await taskService.deleteTask(id);
      if (!deleted) return res.status(404).json({ error: 'Task not found' });
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  return router;
}