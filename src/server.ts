import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Database } from './db/database';
import { createTaskRouter } from './routes/tasks';
import { createSyncRouter } from './routes/sync';
import { errorHandler } from './middleware/errorHandler';
import { TaskService } from './services/taskService';
import { SyncService } from './services/syncService';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
const db = new Database(process.env.DATABASE_URL || './data/tasks.sqlite3');

// Start server
async function start() {
  try {
    await db.initialize();
    console.log('Database initialized');

    // Create services and inject dependencies to break circular dependency
    const taskService = new TaskService(db, null as any);
    const syncService = new SyncService(db, taskService);
    // Now set the correct syncService on taskService
    (taskService as any).syncService = syncService;

    // Routes
    app.use('/api/tasks', createTaskRouter(db));
    app.use('/api', createSyncRouter(db));

    // Error handling
    app.use(errorHandler);

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await db.close();
  process.exit(0);
});