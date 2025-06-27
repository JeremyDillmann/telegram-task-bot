require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');

// Initialize the database - This is the single source of truth now
const db = new Database('grandma.db');
console.log('Database connected successfully.');

// Kill any existing bot instances first
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  db.close(); // Close the database connection
  process.exit(0);
});

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: false,
  filepath: false
});

// Clear any webhooks and start polling
bot.deleteWebHook().then(() => {
  bot.startPolling();
  console.log('Bot polling started successfully');
}).catch(err => {
  console.error('Failed to start polling:', err);
  process.exit(1);
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Database Initialization ---
function initStorage() {
  console.log('Initializing database schema...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      who TEXT,
      when_text TEXT,
      where_text TEXT,
      importance TEXT DEFAULT 'normal',
      category TEXT DEFAULT 'general',
      createdBy TEXT,
      createdAt TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      completedAt TEXT,
      completedBy TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      person TEXT,
      personId INTEGER,
      said TEXT,
      chatId INTEGER
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  
  // Ensure lastCleanup date exists
  const stmt = db.prepare(`INSERT OR IGNORE INTO knowledge (key, value) VALUES (?, ?)`);
  stmt.run('lastCleanup', new Date(0).toISOString());
  console.log('Database schema is ready.');
}

// --- Grandma's Memory System (Now with DB persistence) ---
class GrandmaMemory {
  constructor() {
    this.shortTermMemory = []; // In-memory cache for recent conversation
  }

  // Load history from DB into memory on startup
  hydrate() {
    const rows = db.prepare(`
      SELECT person, said FROM conversation_history 
      ORDER BY timestamp DESC LIMIT 20
    `).all().reverse(); // .reverse() to get chronological order

    this.shortTermMemory = rows.map(r => ({ person: r.person, said: r.said }));
    console.log(`Hydrated ${this.shortTermMemory.length} messages into memory.`);
  }
  
  remember(msg) {
    const memory = {
      time: new Date().toISOString(),
      person: msg.from.first_name || msg.from.username,
      personId: msg.from.id,
      said: msg.text,
      chatId: msg.chat.id
    };
    
    // Update in-memory cache
    this.shortTermMemory.push({ person: memory.person, said: memory.said });
    if (this.shortTermMemory.length > 20) {
      this.shortTermMemory.shift();
    }
    
    // Persist to database
    const stmt = db.prepare(`
      INSERT INTO conversation_history (timestamp, person, personId, said, chatId)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(memory.time, memory.person, memory.personId, memory.said, memory.chatId);
  }
  
  getConversationContext() {
    return this.shortTermMemory.slice(-10).map(m => 
      `${m.person}: ${m.said}`
    ).join('\n');
  }

  updateKnowledge(person, info) {
    // For this simple case, we can store structured info as JSON in the knowledge table
    const key = `person_${person}`;
    const existing = db.prepare('SELECT value FROM knowledge WHERE key = ?').get(key);
    const existingInfo = existing ? JSON.parse(existing.value) : {};
    const newInfo = { ...existingInfo, ...info };
    
    db.prepare(`
      INSERT INTO knowledge (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(newInfo));
  }
}

const grandma = new GrandmaMemory();

// --- Main Logic ---

// Main message handler
bot.on('message', async (msg) => {
  if (msg.from.is_bot) return;
  if (!msg.text) return;
  
  const chatId = msg.chat.id;
  const person = msg.from.first_name || msg.from.username || 'child';
  
  grandma.remember(msg);
  
  try {
    bot.sendChatAction(chatId, 'typing');
    const response = await processWithGrandmaWisdom(msg.text, person, grandma.getConversationContext());
    
    if (response.message) {
      await bot.sendMessage(chatId, response.message);
    }
    
    if (response.tasks && response.tasks.length > 0) {
      processTasks(response.tasks, person);
    }
    
    if (response.operations && response.operations.length > 0) {
      processOperations(response.operations, person, chatId);
    }
    
  } catch (error) {
    console.error('Grandma error:', error);
    bot.sendMessage(chatId, `Try again.`);
  }
});

// Grandma's wisdom processor
async function processWithGrandmaWisdom(text, person, context) {
  const activeTasks = db.prepare('SELECT title, who, when_text, where_text FROM tasks WHERE completed = 0').all();
  
  const prompt = `
You are a wise, street-smart grandma who keeps an impeccable household. You're extremely brief and direct.

RECENT CONVERSATION:
${context}

CURRENT MESSAGE from ${person}: "${text}"

ACTIVE TASKS (${activeTasks.length} total):
${activeTasks.slice(0, 10).map(t => 
  `- ${t.title} (${t.who || 'someone'} needs to do this${t.when_text ? ' ' + t.when_text : ''}${t.where_text ? ' at ' + t.where_text : ''})`
).join('\n')}

YOUR RULES:
1. ULTRA BRIEF responses (5-10 words max)
2. When adding tasks, just confirm briefly: "Got it." or "Noted."
3. NO explanations, NO emojis, NO elaboration
4. If "delete all" or "clear everything" → remove ALL tasks
5. List formatting: use "|" between items

TASK EXTRACTION:
Extract tasks with who/what/when/where but respond minimally. Note: 'when' and 'where' might be in the title itself.
- Task 'title' is the 'what'.
- 'when_text' is the time/day.
- 'where_text' is the location.

OPERATIONS:
- "done"/"bought"/"finished" → mark complete
- "list"/"what's on" → show list
- "delete all"/"clear everything" → remove ALL active tasks
- "remove X" → remove specific task

Respond as JSON only:
{
  "message": "Your ULTRA brief response",
  "tasks": [{"title": "...", "who": "...", "when_text": "...", "where_text": "...", "importance": "...", "category": "..."}],
  "operations": [{"type": "...", "target": "...", "details": {...}}]
}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a terse grandma. Maximum 10 words per response. You only output valid JSON." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }, // Use JSON mode for reliability
      temperature: 0.3,
      max_tokens: 400,
    });
    
    const response = completion.choices[0].message.content;
    console.log('Grandma says (JSON):', response);
    return JSON.parse(response);
    
  } catch (error) {
    console.error('AI Error:', error);
    // Fallback logic remains the same
    const lowerText = text.toLowerCase();
    if (lowerText.includes('delete all') || lowerText.includes('clear everything')) {
      return { message: `All cleared.`, tasks: [], operations: [{ type: 'clear_all' }] };
    }
    if (lowerText.includes('done') || lowerText.includes('bought')) {
      return { message: `Noted.`, tasks: [], operations: [{ type: 'complete', target: text }] };
    }
    if (lowerText.includes('list') || lowerText.includes('what')) {
      return { message: `Here:`, tasks: [], operations: [{ type: 'list' }] };
    }
    return { message: `Again?`, tasks: [], operations: [] };
  }
}

// Process new tasks using a transaction
function processTasks(newTasks, person) {
  const insert = db.prepare(`
    INSERT INTO tasks (title, who, when_text, where_text, importance, category, createdBy, createdAt)
    VALUES (@title, @who, @when, @where, @importance, @category, @createdBy, @createdAt)
  `);

  const insertMany = db.transaction((tasks) => {
    for (const task of tasks) {
        const taskRecord = {
            title: task.title,
            who: task.who || person,
            when: task.when_text || null,
            where: task.where_text || null,
            importance: task.importance || 'normal',
            category: task.category || 'general',
            createdBy: person,
            createdAt: new Date().toISOString()
        };
        insert.run(taskRecord);
    }
  });

  try {
    insertMany(newTasks);
    console.log(`Added ${newTasks.length} new tasks to the database.`);
  } catch (err) {
    console.error('Failed to add tasks in transaction:', err);
  }
}

// Process operations (complete, remove, list, etc)
function processOperations(operations, person, chatId) {
  for (const op of operations) {
    switch (op.type) {
      case 'complete': handleComplete(op.target, person, chatId); break;
      case 'remove': handleRemove(op.target, person, chatId); break;
      case 'list': handleList(chatId); break;
      case 'assign': handleAssign(person, chatId); break;
      case 'clear_all': handleClearAll(person, chatId); break;
    }
  }
}

// --- Operation Handlers (using DB queries) ---

function handleClearAll(person, chatId) {
  const result = db.prepare(`
    UPDATE tasks 
    SET completed = 1, completedAt = ?, completedBy = ? 
    WHERE completed = 0
  `).run(new Date().toISOString(), person);
  
  bot.sendMessage(chatId, `Cleared ${result.changes} tasks.`);
}

function handleComplete(target, person, chatId) {
  const targetLower = target.toLowerCase();
  // Attempt a fuzzy match on the title
  const task = db.prepare(`
    SELECT id, title FROM tasks 
    WHERE completed = 0 AND lower(title) LIKE ? 
    ORDER BY length(title) ASC LIMIT 1
  `).get(`%${targetLower.replace('done', '').replace('bought', '').trim()}%`);
  
  if (task) {
    db.prepare(`
      UPDATE tasks 
      SET completed = 1, completedAt = ?, completedBy = ? 
      WHERE id = ?
    `).run(new Date().toISOString(), person, task.id);
    
    const responses = [`Done.`, `Good.`, `Next.`, `Noted.`, `Check.`];
    bot.sendMessage(chatId, responses[Math.floor(Math.random() * responses.length)]);
  } else {
    bot.sendMessage(chatId, `What exactly?`);
  }
}

function handleList(chatId) {
  const urgent = db.prepare("SELECT * FROM tasks WHERE completed = 0 AND importance = 'urgent'").all();
  const shopping = db.prepare("SELECT * FROM tasks WHERE completed = 0 AND category = 'shopping'").all();
  const regular = db.prepare("SELECT * FROM tasks WHERE completed = 0 AND importance != 'urgent' AND category != 'shopping'").all();
  
  if (urgent.length === 0 && shopping.length === 0 && regular.length === 0) {
    bot.sendMessage(chatId, `Nothing to do.`);
    return;
  }
  
  let message = '';
  
  if (urgent.length > 0) {
    message += 'URGENT:\n';
    urgent.forEach(t => message += `${t.title} | ${t.who}${t.when_text ? ' | ' + t.when_text : ''}\n`);
    message += '\n';
  }
  
  if (shopping.length > 0) {
    const byStore = shopping.reduce((acc, t) => {
        const store = t.where_text || 'General Shopping';
        if (!acc[store]) acc[store] = [];
        acc[store].push(t);
        return acc;
    }, {});
    
    message += 'SHOPPING:\n';
    for (const [store, items] of Object.entries(byStore)) {
      message += `${store}:\n`;
      items.forEach(t => message += `  ${t.title} | ${t.who}\n`);
    }
    message += '\n';
  }
  
  if (regular.length > 0) {
    message += 'TASKS:\n';
    regular.forEach(t => message += `${t.title} | ${t.who}${t.when_text ? ' | ' + t.when_text : ''}\n`);
  }
  
  bot.sendMessage(chatId, message.trim());
}

function handleRemove(target, person, chatId) {
  const targetLower = target.toLowerCase();
  const task = db.prepare(`
    SELECT id, title FROM tasks 
    WHERE completed = 0 AND lower(title) LIKE ? 
    LIMIT 1
  `).get(`%${targetLower}%`);

  if (task) {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    bot.sendMessage(chatId, `Fine, ${person}. Removed "${task.title}".`);
  } else {
    bot.sendMessage(chatId, `Can't find that one, ${person}.`);
  }
}

function handleAssign(person, chatId) {
  bot.sendMessage(chatId, `${person}, tell them yourself. I'm not your messenger.`);
}

// --- Maintenance ---

async function monthlyCleanup() {
  const knowledge = db.prepare("SELECT value FROM knowledge WHERE key = 'lastCleanup'").get();
  const lastCleanup = new Date(knowledge.value);
  const now = new Date();
  
  if (now - lastCleanup < 30 * 24 * 60 * 60 * 1000) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  
  const oldTasks = db.prepare('SELECT * FROM tasks WHERE completed = 1 AND completedAt < ?').all(cutoff.toISOString());
  
  if (oldTasks.length > 0) {
    const archiveFile = `archive_${now.toISOString().split('T')[0]}.json`;
    await fs.writeFile(archiveFile, JSON.stringify({ archived: oldTasks }, null, 2));
    
    db.prepare('DELETE FROM tasks WHERE completed = 1 AND completedAt < ?').run(cutoff.toISOString());
    console.log(`Archived ${oldTasks.length} old tasks to ${archiveFile}`);
  }
  
  db.prepare("UPDATE knowledge SET value = ? WHERE key = 'lastCleanup'").run(now.toISOString());
}

// Voice message handler
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const person = msg.from.first_name || msg.from.username;
  bot.sendMessage(chatId, `${person}, I'm too old for voice messages. Type it out.`);
});

// --- Startup Sequence ---
try {
  initStorage();
  grandma.hydrate();
  
  // Set up daily cleanup check
  setInterval(monthlyCleanup, 24 * 60 * 60 * 1000); // Check daily
  monthlyCleanup(); // Run once on start
  
  console.log('Grandma Bot is ready to keep house!');
} catch(error) {
  console.error('Failed to start:', error);
  process.exit(1);
}

// Error handling
bot.on('polling_error', (error) => console.error('Telegram error:', error.code));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));
