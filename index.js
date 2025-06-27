require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');

// Kill any existing bot instances first
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});

// Initialize - IMPORTANT: Set polling to false first, then start
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

// Storage
const TASKS_FILE = 'tasks.json';
const CONTEXT_FILE = 'context.json';
const KNOWLEDGE_FILE = 'knowledge.json';

// Initialize storage
async function initStorage() {
  const files = [
    { path: TASKS_FILE, default: { tasks: [], taskIdCounter: 1 } },
    { path: CONTEXT_FILE, default: { messages: [] } },
    { path: KNOWLEDGE_FILE, default: { 
      people: {}, 
      preferences: {},
      patterns: {},
      lastCleanup: new Date().toISOString()
    }}
  ];
  
  for (const file of files) {
    try {
      await fs.access(file.path);
      const data = await fs.readFile(file.path, 'utf8');
      JSON.parse(data); // Validate
    } catch {
      console.log(`Creating ${file.path}...`);
      await fs.writeFile(file.path, JSON.stringify(file.default, null, 2));
    }
  }
}

// Load/Save helpers
async function loadJSON(filename, fallback = {}) {
  try {
    const data = await fs.readFile(filename, 'utf8');
    return JSON.parse(data);
  } catch {
    return fallback;
  }
}

async function saveJSON(filename, data) {
  await fs.writeFile(filename, JSON.stringify(data, null, 2));
}

// Grandma's memory system
class GrandmaMemory {
  constructor() {
    this.shortTermMemory = []; // Recent conversation
    this.workingMemory = {};   // Current conversation state
  }
  
  async remember(msg) {
    const memory = {
      time: new Date().toISOString(),
      person: msg.from.first_name || msg.from.username,
      personId: msg.from.id,
      said: msg.text,
      chatId: msg.chat.id
    };
    
    this.shortTermMemory.push(memory);
    if (this.shortTermMemory.length > 20) {
      this.shortTermMemory.shift();
    }
    
    // Update context file (for restart persistence)
    const context = await loadJSON(CONTEXT_FILE);
    context.messages = this.shortTermMemory;
    await saveJSON(CONTEXT_FILE, context);
    
    return memory;
  }
  
  getConversationContext() {
    return this.shortTermMemory.slice(-10).map(m => 
      `${m.person}: ${m.said}`
    ).join('\n');
  }
  
  async updateKnowledge(person, info) {
    const knowledge = await loadJSON(KNOWLEDGE_FILE);
    if (!knowledge.people[person]) {
      knowledge.people[person] = {};
    }
    Object.assign(knowledge.people[person], info);
    await saveJSON(KNOWLEDGE_FILE, knowledge);
  }
}

const grandma = new GrandmaMemory();

// Main message handler - Grandma always responds!
bot.on('message', async (msg) => {
  if (msg.from.is_bot) return;
  if (!msg.text) return;
  
  const chatId = msg.chat.id;
  const person = msg.from.first_name || msg.from.username || 'child';
  
  // Remember everything
  await grandma.remember(msg);
  
  try {
    // Let Grandma think
    bot.sendChatAction(chatId, 'typing');
    const response = await processWithGrandmaWisdom(msg.text, person, grandma.getConversationContext());
    
    // Always respond
    if (response.message) {
      await bot.sendMessage(chatId, response.message);
    }
    
    // Handle tasks
    if (response.tasks.length > 0) {
      await processTasks(response.tasks, person);
    }
    
    // Handle task operations
    if (response.operations.length > 0) {
      await processOperations(response.operations, person, chatId);
    }
    
  } catch (error) {
    console.error('Grandma error:', error);
    bot.sendMessage(chatId, `Try again.`);
  }
});

// Grandma's wisdom processor
async function processWithGrandmaWisdom(text, person, context) {
  const tasks = await loadJSON(TASKS_FILE);
  const activeTasks = tasks.tasks.filter(t => !t.completed);
  
  const prompt = `
You are a wise, street-smart grandma who keeps an impeccable household. You're extremely brief and direct.

RECENT CONVERSATION:
${context}

CURRENT MESSAGE from ${person}: "${text}"

ACTIVE TASKS (${activeTasks.length} total):
${activeTasks.slice(0, 10).map(t => 
  `- ${t.title} (${t.who || 'someone'} needs to do this${t.when ? ' ' + t.when : ''}${t.where ? ' at ' + t.where : ''})`
).join('\n')}

YOUR RULES:
1. ULTRA BRIEF responses (5-10 words max)
2. When adding tasks, just confirm briefly: "Got it." or "Noted."
3. NO explanations, NO emojis, NO elaboration
4. If "delete all" or "clear everything" → remove ALL tasks
5. List formatting: use "|" between items

TASK EXTRACTION:
Extract tasks with who/what/when/where but respond minimally.

OPERATIONS:
- "done"/"bought"/"finished" → mark complete
- "list"/"what's on" → show list
- "delete all"/"clear everything" → remove ALL active tasks
- "remove X" → remove specific task

Respond as JSON:
{
  "message": "Your ULTRA brief response",
  "tasks": [...],
  "operations": [...]
}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Best model as requested
      messages: [
        { 
          role: "system", 
          content: "You are a terse grandma. Maximum 10 words per response. Just confirm tasks briefly."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.3, // Less creative, more consistent
      max_tokens: 300,
    });
    
    const response = completion.choices[0].message.content;
    console.log('Grandma says:', response);
    
    try {
      return JSON.parse(response);
    } catch (e) {
      // Extract JSON if wrapped
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback
      return {
        message: `Got it, ${person}.`,
        tasks: [],
        operations: []
      };
    }
    
  } catch (error) {
    console.error('AI Error:', error);
    
    // Grandma's backup wisdom
    const lowerText = text.toLowerCase();
    
    // Check for delete all
    if (lowerText.includes('delete all') || lowerText.includes('clear everything') || 
        lowerText.includes('alles löschen') || lowerText.includes('clear all')) {
      return {
        message: `All cleared.`,
        tasks: [],
        operations: [{ type: 'clear_all', target: 'all', details: {} }]
      };
    }
    
    if (lowerText.includes('done') || lowerText.includes('bought') || lowerText.includes('erledigt')) {
      return {
        message: `Noted.`,
        tasks: [],
        operations: [{ type: 'complete', target: text, details: {} }]
      };
    }
    
    if (lowerText.includes('list') || lowerText.includes('what') || lowerText.includes('was')) {
      return {
        message: `Here:`,
        tasks: [],
        operations: [{ type: 'list', target: 'all', details: {} }]
      };
    }
    
    return {
      message: `Again?`,
      tasks: [],
      operations: []
    };
  }
}

// Process new tasks
async function processTasks(newTasks, person) {
  const data = await loadJSON(TASKS_FILE);
  
  for (const task of newTasks) {
    const taskRecord = {
      id: data.taskIdCounter++,
      title: task.title,
      who: task.who || person,
      when: task.when || null,
      where: task.where || null,
      importance: task.importance || 'normal',
      category: task.category || 'general',
      createdBy: person,
      createdAt: new Date().toISOString(),
      completed: false
    };
    
    data.tasks.push(taskRecord);
  }
  
  await saveJSON(TASKS_FILE, data);
}

// Process operations (complete, remove, list, etc)
async function processOperations(operations, person, chatId) {
  const data = await loadJSON(TASKS_FILE);
  
  for (const op of operations) {
    switch (op.type) {
      case 'complete':
        await handleComplete(data, op.target, person, chatId);
        break;
        
      case 'remove':
        await handleRemove(data, op.target, person, chatId);
        break;
        
      case 'list':
        await handleList(data, op.target, person, chatId);
        break;
        
      case 'assign':
        await handleAssign(data, op.target, op.details, person, chatId);
        break;
        
      case 'clear_all':
        await handleClearAll(data, person, chatId);
        break;
    }
  }
}

// Handle clearing all tasks
async function handleClearAll(data, person, chatId) {
  const activeCount = data.tasks.filter(t => !t.completed).length;
  
  // Mark all as completed (soft delete)
  data.tasks.forEach(task => {
    if (!task.completed) {
      task.completed = true;
      task.completedAt = new Date().toISOString();
      task.completedBy = person;
    }
  });
  
  await saveJSON(TASKS_FILE, data);
  bot.sendMessage(chatId, `Cleared ${activeCount} tasks.`);
}

// Handle task completion
async function handleComplete(data, target, person, chatId) {
  const activeTasks = data.tasks.filter(t => !t.completed);
  const targetLower = target.toLowerCase();
  
  // Find matching task
  let task = activeTasks.find(t => 
    t.title.toLowerCase().includes(targetLower) ||
    targetLower.includes(t.title.toLowerCase())
  );
  
  if (!task && activeTasks.length > 0) {
    // Try to match by who did it
    task = activeTasks.filter(t => t.who === person).pop();
  }
  
  if (task) {
    task.completed = true;
    task.completedAt = new Date().toISOString();
    task.completedBy = person;
    await saveJSON(TASKS_FILE, data);
    
    const responses = [
      `Done.`,
      `Good.`,
      `Next.`,
      `Noted.`,
      `Check.`
    ];
    
    bot.sendMessage(chatId, responses[Math.floor(Math.random() * responses.length)]);
  } else {
    bot.sendMessage(chatId, `What exactly?`);
  }
}

// Handle listing tasks - IMPROVED FORMATTING
async function handleList(data, target, person, chatId) {
  const activeTasks = data.tasks.filter(t => !t.completed);
  
  if (activeTasks.length === 0) {
    bot.sendMessage(chatId, `Nothing to do.`);
    return;
  }
  
  // Group by location for shopping
  const shopping = activeTasks.filter(t => t.category === 'shopping');
  const urgent = activeTasks.filter(t => t.importance === 'urgent');
  const regular = activeTasks.filter(t => t.importance !== 'urgent' && t.category !== 'shopping');
  
  let message = '';
  
  if (urgent.length > 0) {
    message += 'URGENT:\n';
    urgent.forEach(t => {
      message += `${t.title} | ${t.who}${t.when ? ' | ' + t.when : ''}\n`;
    });
    message += '\n';
  }
  
  if (shopping.length > 0) {
    const byStore = {};
    shopping.forEach(t => {
      const store = t.where || 'wherever';
      if (!byStore[store]) byStore[store] = [];
      byStore[store].push(t);
    });
    
    message += 'SHOPPING:\n';
    for (const [store, items] of Object.entries(byStore)) {
      message += `${store}:\n`;
      items.forEach(t => {
        message += `  ${t.title} | ${t.who}\n`;
      });
    }
    message += '\n';
  }
  
  if (regular.length > 0) {
    message += 'TASKS:\n';
    regular.forEach(t => {
      message += `${t.title} | ${t.who}${t.when ? ' | ' + t.when : ''}\n`;
    });
  }
  
  bot.sendMessage(chatId, message.trim());
}

// Handle task removal
async function handleRemove(data, target, person, chatId) {
  const targetLower = target.toLowerCase();
  const taskIndex = data.tasks.findIndex(t => 
    !t.completed && t.title.toLowerCase().includes(targetLower)
  );
  
  if (taskIndex !== -1) {
    const removed = data.tasks.splice(taskIndex, 1)[0];
    await saveJSON(TASKS_FILE, data);
    bot.sendMessage(chatId, `Fine, ${person}. Removed "${removed.title}".`);
  } else {
    bot.sendMessage(chatId, `Can't find that one, ${person}.`);
  }
}

// Handle task assignment
async function handleAssign(data, target, details, person, chatId) {
  // Implementation for reassigning tasks
  bot.sendMessage(chatId, `${person}, tell them yourself. I'm not your messenger.`);
}

// Monthly cleanup (run daily, only acts monthly)
async function monthlyCleanup() {
  const data = await loadJSON(TASKS_FILE);
  const knowledge = await loadJSON(KNOWLEDGE_FILE);
  
  const lastCleanup = new Date(knowledge.lastCleanup || 0);
  const now = new Date();
  
  // Check if a month has passed
  if (now - lastCleanup < 30 * 24 * 60 * 60 * 1000) return;
  
  // Archive old completed tasks
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  
  const archive = data.tasks.filter(t => 
    t.completed && new Date(t.completedAt) < cutoff
  );
  
  if (archive.length > 0) {
    // Save archive
    const archiveFile = `archive_${now.toISOString().split('T')[0]}.json`;
    await saveJSON(archiveFile, { archived: archive });
    
    // Remove from main file
    data.tasks = data.tasks.filter(t => 
      !t.completed || new Date(t.completedAt) >= cutoff
    );
    
    await saveJSON(TASKS_FILE, data);
    console.log(`Archived ${archive.length} old tasks to ${archiveFile}`);
  }
  
  knowledge.lastCleanup = now.toISOString();
  await saveJSON(KNOWLEDGE_FILE, knowledge);
}

// Voice message handler
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const person = msg.from.first_name || msg.from.username;
  
  bot.sendMessage(chatId, `${person}, I'm too old for voice messages. Type it out.`);
});

// Start everything
initStorage().then(async () => {
  console.log('Grandma Bot is ready to keep house!');
  
  // Load previous context
  const context = await loadJSON(CONTEXT_FILE);
  grandma.shortTermMemory = context.messages || [];
  
  // Set up daily cleanup check
  setInterval(monthlyCleanup, 24 * 60 * 60 * 1000); // Daily
  monthlyCleanup(); // Run once on start
  
}).catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Telegram error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});