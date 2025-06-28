// db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Create database
const db = new Database(path.join(dataDir, 'grandma.db'));

// Enable better performance
db.pragma('journal_mode = WAL');

// Drop old tables if they exist to ensure clean schema
db.exec(`DROP TABLE IF EXISTS tasks_old`);
db.exec(`DROP TABLE IF EXISTS conversations_old`);

// Create tables with unique constraint
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    who TEXT NOT NULL,
    when_text TEXT,
    where_text TEXT,
    importance TEXT DEFAULT 'normal',
    category TEXT DEFAULT 'general',
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    completedAt TEXT,
    completedBy TEXT,
    UNIQUE(title, who, completed)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )
`);

// Create indexes
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tasks_active 
  ON tasks(completed, who);
  
  CREATE INDEX IF NOT EXISTS idx_conv_user 
  ON conversations(userId, timestamp);
`);

console.log('Database initialized with unique constraints');

// Export database
module.exports = { db };