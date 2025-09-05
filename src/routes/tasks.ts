import express, { Request, Response } from "express";
import { TaskService } from "../services/taskService";
import { Database } from "../db/database";

const router = express.Router();
const db = new Database("tasks.db"); // local SQLite file
const taskService = new TaskService(db);

// CREATE
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, description } = req.body;
    const task = await taskService.createTask(title, description);
    res.status(201).json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET all
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const tasks = await taskService.getAllTasks();
  res.json(tasks);
});

// GET one
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  const task = await taskService.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json(task);
});

// UPDATE
router.put("/:id", async (req: Request, res: Response): Promise<void> => {
  const updated = await taskService.updateTask(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Task not found" });
  res.json(updated);
});

// DELETE
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const success = await taskService.deleteTask(req.params.id);
  if (!success) return res.status(404).json({ error: "Task not found" });
  res.status(204).send();
});

export default router;
