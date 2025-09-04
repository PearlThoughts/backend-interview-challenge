import { db } from "./src/db"; // adjust path if needed

const tasks = db.prepare(`SELECT * FROM tasks WHERE is_deleted = 0`).all();
console.log("All tasks in database.sqlite:", tasks);
