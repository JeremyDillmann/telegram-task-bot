require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');

// Initialize the database - This is the single source of truth
const db = new Database('grandma.db');
console.log('Database connected successfully.');

// Graceful shutdown
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
  
  const stmt = db.prepare(`INSERT OR IGNORE INTO knowledge (key, value) VALUES (?, ?)`);
  stmt.run('lastCleanup', new Date(0).toISOString());
  console.log('Database schema is ready.');
}

// --- Grandma's Memory System (DB-backed) ---
class GrandmaMemory {
  constructor() {
    this.shortTermMemory = []; // In-memory cache for recent conversation
  }

  hydrate() {
    const rows = db.prepare(`
      SELECT person, said FROM conversation_history 
      ORDER BY timestamp DESC LIMIT 20
    `).all().reverse();
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
    
    this.shortTermMemory.push({ person: memory.person, said: memory.said });
    if (this.shortTermMemory.length > 20) this.shortTermMemory.shift();
    
    const stmt = db.prepare(`
      INSERT INTO conversation_history (timestamp, person, personId, said, chatId)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(memory.time, memory.person, memory.personId, memory.said, memory.chatId);
  }
  
  getConversationContext() {
    return this.shortTermMemory.slice(-10).map(m => `${m.person}: ${m.said}`).join('\n');
  }
}

const grandma = new GrandmaMemory();

// --- Main Logic ---

// Main message handler
bot.on('message', async (msg) => {
  if (msg.from.is_bot || !msg.text) return;
  
  const chatId = msg.chat.id;
  const person = msg.from.first_name || msg.from.username || 'child';
  
  grandma.remember(msg);
  
  try {
    bot.sendChatAction(chatId, 'typing');
    const response = await processWithGrandmaWisdom(msg.text, person, grandma.getConversationContext(), chatId);
    
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
    bot.sendMessage(chatId, `Something went wrong. Try again.`);
  }
});

// --- ** NEW, UPGRADED AI BRAIN ** ---
// This function parses complex natural language into a structured task list.
async function processWithGrandmaWisdom(text, person, context, chatId) {
  const activeTasks = db.prepare('SELECT title, who, when_text, where_text FROM tasks WHERE completed = 0').all();

  const prompt = `
You are a wise, street-smart grandma who is an expert at parsing natural language into a structured task list.

RECENT CONVERSATION:
${context}

CURRENT MESSAGE from ${person}: "${text}"

ACTIVE TASKS (${activeTasks.length} total):
${activeTasks.slice(0, 10).map(t =>
    `- ${t.title} (${t.who || 'someone'} needs to do this${t.when_text ? ' ' + t.when_text : ''}${t.where_text ? ' at ' + t.where_text : ''})`
).join('\n')}

--- YOUR INSTRUCTIONS ---
1.  **Deconstruct the Message**: The user's message may be a long paragraph containing many distinct tasks, potentially in German or English. Your primary job is to break it down into a list of individual, actionable tasks.
2.  **Apply Context**: If a location (e.g., "in the kitchen") is mentioned, apply it to all subsequent tasks until a new location is mentioned.
3.  **Standardize Tasks**: Translate tasks into clear, simple English titles. For example, "die Geschirrspüler ausräumen" should become "Unload the dishwasher".
4.  **Categorize**: Identify the category for each task. Use 'shopping' for buying items, 'cleaning' for chores, and 'general' for everything else.
5.  **Minimal Response**: Your "message" field in the JSON should be an ultra-brief confirmation. If tasks were added, say "Got it. Added X tasks." or a similar brief phrase.
6.  **Handle Operations**: If the user says "list", "done", "clear all", etc., create an operation object instead of a task.

--- EXAMPLES ---
- User says: "I need to get milk and bread from the store tomorrow, and also take out the trash."
- You produce:
  {
    "message": "Okay, added 3 tasks.",
    "tasks": [
      { "title": "Get milk", "who": "${person}", "when_text": "tomorrow", "where_text": "the store", "category": "shopping" },
      { "title": "Get bread", "who": "${person}", "when_text": "tomorrow", "where_text": "the store", "category": "shopping" },
      { "title": "Take out the trash", "who": "${person}", "when_text": null, "where_text": null, "category": "cleaning" }
    ],
    "operations": []
  }
- User says (in German): "Also ich muss morgen den Eingang aufräumen und bei der Apotheke die Thermo Wasser Seife holen"
- You produce:
  {
    "message": "Noted. Added 2 tasks.",
    "tasks": [
      { "title": "Tidy the entrance", "who": "${person}", "when_text": "morgen", "where_text": null, "category": "cleaning" },
      { "title": "Get Thermo water soap", "who": "${person}", "when_text": null, "where_text": "Apotheke", "category": "shopping" }
    ],
    "operations": []
  }

--- YOUR RESPONSE (JSON ONLY) ---
Based on the message from ${person}, provide your response in the following JSON format.
{
  "message": "Your ULTRA brief response",
  "tasks": [{"title": "...", "who": "...", "when_text": "...", "where_text": "...", "category": "..."}],
  "operations": []
}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are an expert task-parsing assistant. You only output valid JSON based on the user's request." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 1500,
    });

    const response = completion.choices[0].message.content;
    console.log('Grandma parsed (JSON):', response);
    return JSON.parse(response);

  } catch (error) {
    console.error('AI Error:', error);
    bot.sendMessage(chatId, `I'm a bit confused, try again.`);
    return { message: null, tasks: [], operations: [] };
  }
}

// Process new tasks using a database transaction
function processTasks(newTasks, person) {
  const insert = db.prepare(`
    INSERT INTO tasks (title, who, when_text, where_text, importance, category, createdBy, createdAt)
    VALUES (@title, @who, @when, @where, @importance, @category, @createdBy, @createdAt)
  `);

  const insertMany = db.transaction((tasks) => {
    for (const task of tasks) {
        insert.run({
            title: task.title,
            who: task.who || person,
            when: task.when_text || null,
            where: task.where_text || null,
            importance: task.importance || 'normal',
            category: task.category || 'general',
            createdBy: person,
            createdAt: new Date().toISOString()
        });
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
    UPDATE tasks SET completed = 1, completedAt = ?, completedBy = ? WHERE completed = 0
  `).run(new Date().toISOString(), person);
  bot.sendMessage(chatId, `Cleared ${result.changes} tasks.`);
}

function handleComplete(target, person, chatId) {
  const targetLower = target ? target.toLowerCase().replace('done', '').replace('bought', '').trim() : '';
  const task = db.prepare(`
    SELECT id, title FROM tasks WHERE completed = 0 AND lower(title) LIKE ? ORDER BY length(title) ASC LIMIT 1
  `).get(`%${targetLower}%`);
  
  if (task) {
    db.prepare(`
      UPDATE tasks SET completed = 1, completedAt = ?, completedBy = ? WHERE id = ?
    `).run(new Date().toISOString(), person, task.id);
    const responses = [`Done.`, `Good.`, `Next.`, `Noted.`, `Check.`];
    bot.sendMessage(chatId, responses[Math.floor(Math.random() * responses.length)]);
  } else {
    bot.sendMessage(chatId, `What exactly?`);
  }
}

function handleList(chatId) {
  const tasks = db.prepare("SELECT * FROM tasks WHERE completed = 0 ORDER BY category, importance DESC").all();

  if (tasks.length === 0) {
    bot.sendMessage(chatId, `Nothing to do.`);
    return;
  }

  // Group tasks by category for structured output
  const grouped = tasks.reduce((acc, t) => {
    let category = t.category.toUpperCase();
    if (t.importance === 'urgent') category = 'URGENT';
    if (!acc[category]) acc[category] = [];
    acc[category].push(t);
    return acc;
  }, {});

  let message = '';
  const categoryOrder = ['URGENT', 'SHOPPING', 'CLEANING', 'GENERAL'];

  for (const category of categoryOrder) {
    if (grouped[category]) {
      message += `${category}:\n`;
      grouped[category].forEach(t => {
        let details = [t.who];
        if (t.when_text) details.push(t.when_text);
        if (t.where_text && category !== 'SHOPPING') details.push(`at ${t.where_text}`);
        message += `- ${t.title} (${details.join(' | ')})\n`;
      });
      message += '\n';
    }
  }

  bot.sendMessage(chatId, message.trim());
}


function handleRemove(target, person, chatId) {
  const targetLower = target ? target.toLowerCase() : '';
  const task = db.prepare(`
    SELECT id, title FROM tasks WHERE completed = 0 AND lower(title) LIKE ? LIMIT 1
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
  const person = msg.from.first_name || msg.from.username;
  bot.sendMessage(msg.chat.id, `${person}, I'm too old for voice messages. Type it out.`);
});

// --- Startup Sequence ---
try {
  initStorage();
  grandma.hydrate();
  
  setInterval(monthlyCleanup, 24 * 60 * 60 * 1000); // Check daily
  monthlyCleanup(); // Run once on start
  
  console.log('Grandma Bot is ready to keep house!');
} catch(error) {
  console.error('Failed to start:', error);
  process.exit(1);
}

// Error handling
bot.on('polling_error', (error) => console.error('Telegram polling error:', error));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));