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

// --- ** NEW, "JAILBROKEN" AI BRAIN ** ---
async function processWithGrandmaWisdom(text, person, context, chatId) {
  const prompt = `
You are a hyper-literal, rule-following assistant that converts natural language into a JSON object. You have two modes: Task Parsing and Operation Handling. You must follow all rules exactly.

--- PRIMARY RULES ---
1.  **NO HALLUCINATIONS**: DO NOT add, infer, or assume any detail not present in the user's message. If a 'when' or 'where' is not specified, its value MUST be null.
2.  **STAY IN CHARACTER**: Your "message" field must be extremely brief (3-10 words) and sound like a terse, direct grandma.
3.  **JSON ONLY**: Your entire output must be a single, valid JSON object.

--- MODE 1: TASK PARSING ---
If the user's message is about creating new tasks, follow these steps:
1.  **Deconstruct**: Break down long paragraphs (in English or German) into a list of individual, atomic tasks.
2.  **Standardize**: Translate tasks into simple English titles. "Geschirrspüler ausräumen" -> "Unload the dishwasher".
3.  **Apply Context**: A location (e.g., "in the kitchen") applies to all subsequent tasks until a new one is mentioned.
4.  **Categorize**: Use 'shopping', 'cleaning', or 'general'.
5.  **Confirmation**: For the "message" field, confirm the number of tasks added (e.g., "Got it. Added 8 tasks.").

--- MODE 2: OPERATION HANDLING ---
If the user's message contains keywords for managing tasks, you MUST create an "operations" object.
- **Operation Keywords**: "list", "show", "what do I need", "tell me", "was muss ich", "aufgaben", "erledigt", "done", "gekauft", "bought", "finished", "remove", "delete", "clear all", "alles löschen".
- **Operation Rule**: If an operation keyword is detected, the "tasks" array in your JSON response MUST be empty.
- **Your Response**: The "message" field should simply acknowledge the command (e.g., "Listing tasks.", "Okay, clearing everything.").

--- EXAMPLES ---
- User: "I need to clean the bathroom"
- You produce: { "message": "Noted.", "tasks": [{ "title": "Clean the bathroom", "who": "${person}", "when_text": null, "where_text": null, "category": "cleaning" }], "operations": [] }

- User: "was muss ich morgen bei edeka kaufen? ich brauche milch, brot und tomaten"
- You produce: { "message": "Got it. Added 3 tasks.", "tasks": [
    { "title": "Buy milk", "who": "${person}", "when_text": "morgen", "where_text": "edeka", "category": "shopping" },
    { "title": "Buy bread", "who": "${person}", "when_text": "morgen", "where_text": "edeka", "category": "shopping" },
    { "title": "Buy tomatoes", "who": "${person}", "when_text": "morgen", "where_text": "edeka", "category": "shopping" }
  ], "operations": [] }

- User: "Show me my tasks"
- You produce: { "message": "Listing tasks.", "tasks": [], "operations": [{ "type": "list", "target": "all" }] }

- User: "Done with the dishes"
- You produce: { "message": "Noted.", "tasks": [], "operations": [{ "type": "complete", "target": "dishes" }] }

--- CURRENT REQUEST ---
- User: ${person}
- Message: "${text}"
- Conversation Context:
${context}

--- YOUR JSON RESPONSE ---
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a hyper-literal, rule-following assistant that converts natural language into a JSON object." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1, // Lowered temperature to prevent creativity/hallucinations
      max_tokens: 2000,
    });

    const response = completion.choices[0].message.content;
    console.log('Grandma parsed (JSON):', response);
    return JSON.parse(response);

  } catch (error) {
    console.error('AI Error:', error);
    bot.sendMessage(chatId, `That's a lot to remember. Try breaking it into smaller pieces.`);
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
      case 'clear_all': handleClearAll(person, chatId); break;
      default: bot.sendMessage(chatId, `I don't know how to do that.`); break;
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
  if (!targetLower) {
      bot.sendMessage(chatId, `What exactly is done?`);
      return;
  }
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
    bot.sendMessage(chatId, `Can't find a task like "${target}".`);
  }
}

function handleList(chatId) {
    const tasks = db.prepare("SELECT * FROM tasks WHERE completed = 0 ORDER BY category, importance DESC, where_text").all();
  
    if (tasks.length === 0) {
      bot.sendMessage(chatId, `Nothing to do.`);
      return;
    }
  
    let message = '';
    let currentCategory = '';
  
    tasks.forEach(task => {
      const category = (task.importance === 'urgent' ? 'URGENT' : task.category.toUpperCase());
      if (category !== currentCategory) {
        message += `\n${category}:\n`;
        currentCategory = category;
      }
      
      let details = [task.who];
      if (task.when_text) details.push(task.when_text);
      if (task.where_text) details.push(`at ${task.where_text}`);
      
      message += `- ${task.title} (${details.join(' | ')})\n`;
    });
  
    bot.sendMessage(chatId, message.trim());
}


function handleRemove(target, person, chatId) {
  const targetLower = target ? target.toLowerCase() : '';
  if (!targetLower) {
      bot.sendMessage(chatId, `What exactly should I remove?`);
      return;
  }
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

// --- Maintenance & Misc ---

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

bot.on('voice', async (msg) => {
  const person = msg.from.first_name || msg.from.username;
  bot.sendMessage(msg.chat.id, `${person}, I'm too old for voice messages. Type it out.`);
});

// --- Startup Sequence ---
try {
  initStorage();
  grandma.hydrate();
  
  setInterval(monthlyCleanup, 24 * 60 * 60 * 1000);
  monthlyCleanup();
  
  console.log('Grandma Bot is ready to keep house!');
} catch(error) {
  console.error('Failed to start:', error);
  process.exit(1);
}

// Error handling
bot.on('polling_error', (error) => console.error('Telegram polling error:', error));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));