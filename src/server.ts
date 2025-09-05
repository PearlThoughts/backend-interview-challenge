import express from "express";
import syncRoutes from "./routes/sync";
import taskRoutes from "./routes/tasks";
import { Database } from "./db/database";

const app = express();
app.use(express.json());
const db = new Database("tasks.db");
db.initialize().then(() => {
  console.log("📦 Database initialized");
}).catch(err => {
  console.error("❌ Failed to initialize database:", err);
});

// Routes
app.use("/tasks", taskRoutes);
app.use("/sync", syncRoutes);

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
