import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';
import { AppError } from '../middleware/errorHandler';
import { Task } from '../types';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);

  // Get all tasks
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (error) {
      const appError = error as AppError;
      appError.statusCode = 500;
      throw appError;
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        const error: AppError = new Error('Task not found');
        error.statusCode = 404;
        throw error;
      }
      res.json(task);
    } catch (error) {
      const appError = error as AppError;
      appError.statusCode = appError.statusCode || 500;
      throw appError;
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    try {
      const taskData: Partial<Task> = req.body;
      if (!taskData.title) {
        const error: AppError = new Error('Title is required');
        error.statusCode = 400;
        throw error;
      }
      const task = await taskService.createTask(taskData);
      res.status(201).json(task);
    } catch (error) {
      const appError = error as AppError;
      appError.statusCode = appError.statusCode || 500;
      throw appError;
    }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const updates: Partial<Task> = req.body;
      const task = await taskService.updateTask(req.params.id, updates);
      if (!task) {
        const error: AppError = new Error('Task not found');
        error.statusCode = 404;
        throw error;
      }
      res.json(task);
    } catch (error) {
      const appError = error as AppError;
      appError.statusCode = appError.statusCode || 500;
      throw appError;
    }
  });

  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const success = await taskService.deleteTask(req.params.id);
      if (!success) {
        const error: AppError = new Error('Task not found');
        error.statusCode = 404;
        throw error;
      }
      res.status(204).send();
    } catch (error) {
      const appError = error as AppError;
      appError.statusCode = appError.statusCode || 500;
      throw appError;
    }
  });

  return router;
}