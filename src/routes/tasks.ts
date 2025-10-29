import express from 'express';
import { Database } from '../db/database';
import { TaskService } from '../services/taskService';

export function createTasksRouter(db: Database, taskService?: TaskService) {
  const router = express.Router();
  const svc = taskService ?? new TaskService(db as any);

  // GET /api/tasks - list non-deleted tasks
  router.get('/', async (req, res) => {
    try {
      const tasks = await svc.getAllTasks();
      res.json({ data: tasks });
    } catch (err: any) {
      console.error('GET /api/tasks error', err);
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // GET /api/tasks/:id - get task
  router.get('/:id', async (req, res) => {
    try {
      const task = await svc.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ data: task });
    } catch (err: any) {
      console.error('GET /api/tasks/:id error', err);
      res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // POST /api/tasks - create
  router.post('/', async (req, res) => {
    try {
      const { title, description, completed } = req.body;
      if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
      const task = await svc.createTask({ title, description, completed });
      res.status(201).json({ data: task });
    } catch (err: any) {
      console.error('POST /api/tasks error', err);
      res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // PUT /api/tasks/:id - update
  router.put('/:id', async (req, res) => {
    try {
      const updates = req.body;
      const updated = await svc.updateTask(req.params.id, updates);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      res.json({ data: updated });
    } catch (err: any) {
      console.error('PUT /api/tasks/:id error', err);
      res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // DELETE /api/tasks/:id - soft delete
  router.delete('/:id', async (req, res) => {
    try {
      const ok = await svc.deleteTask(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Task not found' });
      res.status(204).send();
    } catch (err: any) {
      console.error('DELETE /api/tasks/:id error', err);
      res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  return router;
}