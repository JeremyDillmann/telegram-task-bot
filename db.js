// db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// Create database
const db = new Database(path.join(dataDir, 'grandma.db'));

// Enable foreign keys and better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema IMMEDIATELY
(function initDatabase() {
  // Tasks table
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

  // Conversation history table (persistent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);

  // Create indexes for better performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_active 
    ON tasks(completed, who, category);
    
    CREATE INDEX IF NOT EXISTS idx_tasks_search 
    ON tasks(title, completed);
    
    CREATE INDEX IF NOT EXISTS idx_conv_user_time 
    ON conversations(userId, timestamp);
  `);

  console.log('Database tables created');
})();

// Prepared statements for better performance and security
const statements = {
  addTask: db.prepare(`
    INSERT INTO tasks (title, who, when_text, where_text, importance, category, createdBy, createdAt) 
    VALUES (@title, @who, @when_text, @where_text, @importance, @category, @createdBy, @createdAt)
  `),
  
  findTaskByTitle: db.prepare(`
    SELECT * FROM tasks 
    WHERE completed = 0 
    AND who = @who 
    AND title LIKE @pattern 
    LIMIT 1
  `),
  
  completeTask: db.prepare(`
    UPDATE tasks 
    SET completed = 1, completedAt = @completedAt, completedBy = @completedBy 
    WHERE id = @id
  `),
  
  getActiveTasks: db.prepare(`
    SELECT * FROM tasks 
    WHERE completed = 0 
    ORDER BY importance DESC, category, where_text
  `),
  
  getUserActiveTasks: db.prepare(`
    SELECT * FROM tasks 
    WHERE completed = 0 AND who = @who 
    ORDER BY importance DESC, category, where_text
  `),
  
  // Conversation history
  addConversation: db.prepare(`
    INSERT INTO conversations (userId, role, content, timestamp) 
    VALUES (@userId, @role, @content, @timestamp)
  `),
  
  getRecentConversations: db.prepare(`
    SELECT * FROM conversations 
    WHERE userId = @userId 
    ORDER BY timestamp DESC 
    LIMIT 10
  `)
};

module.exports = { db, statements };