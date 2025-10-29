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
      return res.json(tasks);
    } catch (error) {
      console.error('GET /api/tasks error', error);
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      return res.json(task);
    } catch (error) {
      console.error('GET /api/tasks/:id error', error);
      return res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body;
      if (!body || typeof body.title !== 'string' || body.title.trim() === '') {
        return res.status(400).json({ error: 'title is required' });
      }
      const created = await taskService.createTask({
        title: body.title,
        description: body.description,
        completed: !!body.completed,
      });
      return res.status(201).json(created);
    } catch (error) {
      console.error('POST /api/tasks error', error);
      return res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const updates = req.body;
      const updated = await taskService.updateTask(req.params.id, updates);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      return res.json(updated);
    } catch (error) {
      console.error('PUT /api/tasks/:id error', error);
      return res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // Delete task (soft delete)
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const ok = await taskService.deleteTask(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Task not found' });
      return res.status(204).send();
    } catch (error) {
      console.error('DELETE /api/tasks/:id error', error);
      return res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  return router;
}
