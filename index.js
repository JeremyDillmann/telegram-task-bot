require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');

// Initialize the database
const db = new Database('grandma.db');
console.log('Database connected successfully.');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  db.close();
  process.exit(0);
});

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: false,
  filepath: false
});

// Start polling
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
    CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, who TEXT, when_text TEXT, where_text TEXT, importance TEXT DEFAULT 'normal', category TEXT DEFAULT 'general', createdBy TEXT, createdAt TEXT, completed INTEGER DEFAULT 0, completedAt TEXT, completedBy TEXT);
    CREATE TABLE IF NOT EXISTS conversation_history (id INTEGER PRIMARY KEY, timestamp TEXT, person TEXT, personId INTEGER, said TEXT, chatId INTEGER);
    CREATE TABLE IF NOT EXISTS knowledge (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(`INSERT OR IGNORE INTO knowledge (key, value) VALUES (?, ?)`).run('lastCleanup', new Date(0).toISOString());
  console.log('Database schema is ready.');
}

// --- Grandma's Memory System ---
class GrandmaMemory {
  constructor() { this.shortTermMemory = []; }
  hydrate() {
    const rows = db.prepare(`SELECT person, said FROM conversation_history ORDER BY timestamp DESC LIMIT 20`).all().reverse();
    this.shortTermMemory = rows.map(r => ({ person: r.person, said: r.said }));
    console.log(`Hydrated ${this.shortTermMemory.length} messages into memory.`);
  }
  remember(msg) {
    const memory = { time: new Date().toISOString(), person: msg.from.first_name || msg.from.username, personId: msg.from.id, said: msg.text, chatId: msg.chat.id };
    this.shortTermMemory.push({ person: memory.person, said: memory.said });
    if (this.shortTermMemory.length > 20) this.shortTermMemory.shift();
    db.prepare(`INSERT INTO conversation_history (timestamp, person, personId, said, chatId) VALUES (?, ?, ?, ?, ?)`).run(memory.time, memory.person, memory.personId, memory.said, memory.chatId);
  }
  getConversationContext() { return this.shortTermMemory.slice(-10).map(m => `${m.person}: ${m.said}`).join('\n'); }
}
const grandma = new GrandmaMemory();

// --- Main Logic ---
bot.on('message', async (msg) => {
  if (msg.from.is_bot || !msg.text) return;
  const chatId = msg.chat.id;
  const person = msg.from.first_name || msg.from.username || 'child';
  grandma.remember(msg);
  try {
    bot.sendChatAction(chatId, 'typing');
    const response = await processWithGrandmaWisdom(msg.text, person, chatId);
    // The initial message is now only for simple queries, not confirmations
    if (response.message) await bot.sendMessage(chatId, response.message);
    if (response.tasks && response.tasks.length > 0) processTasks(response.tasks, person, chatId);
    if (response.operations && response.operations.length > 0) processOperations(response.operations, person, chatId);
  } catch (error) {
    console.error('Grandma error:', error);
    bot.sendMessage(chatId, `Something went wrong. Try again.`);
  }
});

// --- ** AI BRAIN with Silent Operations ** ---
async function processWithGrandmaWisdom(text, person, chatId) {
  const prompt = `
You are a hyper-literal assistant that converts language into a JSON object.

--- PRIMARY RULES ---
1.  **NO HALLUCINATIONS**: Do not assume details.
2.  **JSON ONLY**: Your entire output must be a single, valid JSON object.
3.  **SILENT OPERATIONS**: For creating, editing, or completing tasks, the "message" field in your JSON output MUST be null. The confirmation will be handled separately. For simple queries like "list", you can provide a message.

--- MODES ---
- **TASK PARSING**: Deconstruct messages into a list of new tasks.
- **OPERATION HANDLING**: Handle commands like "list", "done", "remove". For "list", detect 'personal' vs 'all'.
- **TASK EDITING**: Handle commands like "edit", "change", "update". Extract the target task and the new details.
- **CONTEXTUAL QUERYING**: Handle queries like "tasks for 5 minutes" or "tasks at home".

--- EXAMPLES ---
- User: "I need to clean the bathroom"
- You produce: { "message": null, "tasks": [{ "title": "Clean the bathroom", "who": "${person}", "when_text": null, "where_text": null, "category": "cleaning" }], "operations": [] }

- User: "Show me my tasks"
- You produce: { "message": "Here are your tasks.", "tasks": [], "operations": [{ "type": "list", "target": "personal" }] }

- User: "Change 'clean floor' to 'vacuum floor'"
- You produce: { "message": null, "tasks": [], "operations": [{ "type": "edit", "target": "clean floor", "details": { "title": "vacuum floor" } }] }

- User: "Done with the dishes"
- You produce: { "message": null, "tasks": [], "operations": [{ "type": "complete", "target": "dishes" }] }

--- CURRENT REQUEST ---
- User: ${person}
- Message: "${text}"

--- YOUR JSON RESPONSE ---
`;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: "You are a hyper-literal assistant that converts language into a JSON object." }, { role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 2000,
    });
    const response = completion.choices[0].message.content;
    console.log('Grandma parsed (JSON):', response);
    return JSON.parse(response);
  } catch (error) {
    console.error('AI Error:', error);
    bot.sendMessage(chatId, `That's a lot to remember. Try smaller pieces.`);
    return { message: null, tasks: [], operations: [] };
  }
}

// ** MODIFIED: Sends a specific confirmation message **
function processTasks(newTasks, person, chatId) {
  const insert = db.prepare(`INSERT INTO tasks (title, who, when_text, where_text, importance, category, createdBy, createdAt) VALUES (@title, @who, @when, @where, @importance, @category, @createdBy, @createdAt)`);
  const insertMany = db.transaction((tasks) => {
    for (const task of tasks) {
      insert.run({ title: task.title, who: task.who || person, when: task.when_text || null, where: task.where_text || null, importance: task.importance || 'normal', category: task.category || 'general', createdBy: person, createdAt: new Date().toISOString() });
    }
  });
  try {
    insertMany(newTasks);
    let confirmation = `Got it. Added ${newTasks.length} task(s):\n`;
    newTasks.forEach(t => { confirmation += `- ${t.title}\n`; });
    bot.sendMessage(chatId, confirmation);
  } catch (err) {
    console.error('Failed to add tasks in transaction:', err);
    bot.sendMessage(chatId, "I couldn't save those tasks.");
  }
}

// Process operations
function processOperations(operations, person, chatId) {
  for (const op of operations) {
    switch (op.type) {
      case 'complete': handleComplete(op.target, person, chatId); break;
      case 'remove': handleRemove(op.target, person, chatId); break;
      case 'list': handleList(op.target, person, chatId); break;
      case 'clear_all': handleClearAll(person, chatId); break;
      case 'edit': handleEdit(op.target, op.details, person, chatId); break;
      case 'query': handleQuery(op.details, person, chatId); break;
      default: bot.sendMessage(chatId, `I don't know how to do that.`); break;
    }
  }
}

// --- ** OPERATION HANDLERS with SPECIFIC CONFIRMATIONS ** ---

// ** MODIFIED: Sends a specific confirmation message **
function handleEdit(target, details, person, chatId) {
  if (!target || !details || Object.keys(details).length === 0) {
    bot.sendMessage(chatId, "What do you want to change, and what should I change it to?"); return;
  }
  const task = db.prepare(`SELECT id, title, who, when_text, where_text FROM tasks WHERE completed = 0 AND who = ? AND lower(title) LIKE ? LIMIT 1`).get(person, `%${target.toLowerCase()}%`);
  if (!task) {
    bot.sendMessage(chatId, `I can't find the task "${target}" on your list to edit.`); return;
  }

  const validColumns = ['title', 'who', 'when_text', 'where_text', 'importance', 'category'];
  const setParts = [], params = [], changes = [];
  for (const key in details) {
    if (validColumns.includes(key)) {
      setParts.push(`${key} = ?`);
      params.push(details[key]);
      changes.push(`set ${key} to "${details[key]}"`);
    }
  }

  if (setParts.length === 0) {
    bot.sendMessage(chatId, "None of those are things I can change."); return;
  }
  
  params.push(task.id);
  const query = `UPDATE tasks SET ${setParts.join(', ')} WHERE id = ?`;

  try {
    const result = db.prepare(query).run(...params);
    if (result.changes > 0) {
      bot.sendMessage(chatId, `Okay, for task "${task.title}", I've ${changes.join(' and ')}.`);
    } else {
      bot.sendMessage(chatId, `Something went wrong, couldn't update the task.`);
    }
  } catch (err) {
    console.error("Edit Error:", err);
    bot.sendMessage(chatId, "I couldn't make that change.");
  }
}

// ** MODIFIED: Sends a specific confirmation message **
function handleComplete(target, person, chatId) {
  const targetLower = target ? target.toLowerCase().replace('done', '').replace('bought', '').trim() : '';
  if (!targetLower) { bot.sendMessage(chatId, `What exactly is done?`); return; }
  const task = db.prepare(`SELECT id, title FROM tasks WHERE completed = 0 AND who = ? AND lower(title) LIKE ? ORDER BY length(title) ASC LIMIT 1`).get(person, `%${targetLower}%`);
  
  if (task) {
    db.prepare(`UPDATE tasks SET completed = 1, completedAt = ?, completedBy = ? WHERE id = ?`).run(new Date().toISOString(), person, task.id);
    bot.sendMessage(chatId, `Done: "${task.title}".`);
  } else { 
    bot.sendMessage(chatId, `Can't find a task like "${target}" assigned to you.`);
  }
}

async function handleQuery(details, person, chatId) {
    const tasks = db.prepare("SELECT title, where_text FROM tasks WHERE completed = 0 AND who = ?").all(person);
    if (tasks.length === 0) { bot.sendMessage(chatId, "You have nothing to do right now."); return; }
    let contextDescription = "based on their available tasks.";
    if (details.max_duration_minutes) contextDescription = `that can be completed in under ${details.max_duration_minutes} minutes.`;
    else if (details.at_location) contextDescription = `that can be done at their current location: '${details.at_location}'. A task with a specific store name or no location is likely not doable at home.`;
    const taskList = tasks.map(t => `- ${t.title} (Location: ${t.where_text || 'None'})`).join('\n');
    const filterPrompt = `A user wants a list of tasks they can do right now, ${contextDescription}\nHere is their full list:\n${taskList}\nAnalyze this and return ONLY the titles of the tasks that fit. If none fit, return an empty list. Respond with a JSON object with a single key "suitable_tasks", an array of strings.`;
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: "You are a logical filtering assistant. You only output JSON." }, { role: "user", content: filterPrompt }],
            response_format: { type: "json_object" },
        });
        const result = JSON.parse(completion.choices[0].message.content);
        const suitableTasks = result.suitable_tasks;
        if (suitableTasks && suitableTasks.length > 0) {
            let message = "Here are some things you could do:\n";
            suitableTasks.forEach(title => { message += `- ${title}\n`; });
            bot.sendMessage(chatId, message);
        } else {
            bot.sendMessage(chatId, "Looks like nothing on your list fits that description right now.");
        }
    } catch (err) {
        console.error("Query Filter Error:", err);
        bot.sendMessage(chatId, "I had trouble figuring out which tasks fit. Try again.");
    }
}

function handleClearAll(person, chatId) {
  const result = db.prepare(`UPDATE tasks SET completed = 1, completedAt = ?, completedBy = ? WHERE completed = 0`).run(new Date().toISOString(), person);
  bot.sendMessage(chatId, `Cleared ${result.changes} tasks.`);
}

function handleList(target, person, chatId) {
  let query = "SELECT * FROM tasks WHERE completed = 0", params = [];
  if (target === 'personal') {
    query += " AND who = ?"; params.push(person);
  }
  query += " ORDER BY category, importance DESC, where_text";
  const tasks = db.prepare(query).all(...params);
  if (tasks.length === 0) { bot.sendMessage(chatId, target === 'personal' ? 'You have nothing to do.' : 'There are no tasks.'); return; }
  let message = '', currentCategory = '';
  tasks.forEach(task => {
    const category = (task.importance === 'urgent' ? 'URGENT' : task.category.toUpperCase());
    if (category !== currentCategory) { message += `\n${category}:\n`; currentCategory = category; }
    let details = [task.who];
    if (task.when_text) details.push(task.when_text);
    if (task.where_text) details.push(`at ${task.where_text}`);
    message += `- ${task.title} (${details.join(' | ')})\n`;
  });
  bot.sendMessage(chatId, message.trim());
}

function handleRemove(target, person, chatId) {
  const targetLower = target ? target.toLowerCase() : '';
  if (!targetLower) { bot.sendMessage(chatId, `What exactly should I remove?`); return; }
  const task = db.prepare(`SELECT id, title FROM tasks WHERE completed = 0 AND who = ? AND lower(title) LIKE ? LIMIT 1`).get(person, `%${targetLower}%`);
  if (task) {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    bot.sendMessage(chatId, `Removed: "${task.title}".`);
  } else { bot.sendMessage(chatId, `Can't find that one on your list, ${person}.`); }
}

// --- Maintenance & Misc ---
async function monthlyCleanup() {
  const { value } = db.prepare("SELECT value FROM knowledge WHERE key = 'lastCleanup'").get();
  if (new Date() - new Date(value) < 30 * 24 * 60 * 60 * 1000) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const oldTasks = db.prepare('SELECT * FROM tasks WHERE completed = 1 AND completedAt < ?').all(cutoff.toISOString());
  if (oldTasks.length > 0) {
    const archiveFile = `archive_${new Date().toISOString().split('T')[0]}.json`;
    await fs.writeFile(archiveFile, JSON.stringify({ archived: oldTasks }, null, 2));
    db.prepare('DELETE FROM tasks WHERE completed = 1 AND completedAt < ?').run(cutoff.toISOString());
    console.log(`Archived ${oldTasks.length} old tasks to ${archiveFile}`);
  }
  db.prepare("UPDATE knowledge SET value = ? WHERE key = 'lastCleanup'").run(new Date().toISOString());
}

bot.on('voice', async (msg) => {
  bot.sendMessage(msg.chat.id, `${msg.from.first_name || msg.from.username}, I'm too old for voice messages. Type it out.`);
});

// --- Startup Sequence ---
try {
  initStorage();
  grandma.hydrate();
  setInterval(monthlyCleanup, 24 * 60 * 60 * 1000);
  monthlyCleanup();
  console.log('Grandma Bot is ready to keep house!');
} catch (error) {
  console.error('Failed to start:', error);
  process.exit(1);
}

// Error handling
bot.on('polling_error', (error) => console.error('Telegram polling error:', error));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));