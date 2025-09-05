import { Router, Request, Response } from "express";
import { TaskService } from "../services/taskService";
import { Database } from "../db/database";

const router = Router();
const db = new Database("tasks.db");
const taskService = new TaskService(db);

// Route to get tasks that need syncing
router.get("/pending", async (req: Request, res: Response) => {
  try {
    const tasks = await taskService.getTasksNeedingSync();
    res.json(tasks);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch sync tasks" });
  }
});

// Route to update sync status (after successful server sync)
router.post("/update-status", async (req: Request, res: Response) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) {
      return res.status(400).json({ error: "Missing id or status" });
    }

    await db.run(
      `UPDATE tasks 
       SET sync_status = ?, updated_at = ? 
       WHERE id = ?`,
      [status, new Date().toISOString(), id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update sync status" });
  }
});

export default router;
