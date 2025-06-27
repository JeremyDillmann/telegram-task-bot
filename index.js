require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');

// Initialize
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Storage
const TASKS_FILE = 'tasks.json';
const CHAT_CONTEXT_FILE = 'context.json';

// Initialize storage files with error handling
async function initStorage() {
  // Initialize tasks file
  try {
    await fs.access(TASKS_FILE);
    // Try to read and validate
    const data = await fs.readFile(TASKS_FILE, 'utf8');
    JSON.parse(data); // Test if valid JSON
  } catch {
    console.log('Creating new tasks.json file...');
    await fs.writeFile(TASKS_FILE, JSON.stringify({ tasks: [] }, null, 2));
  }
  
  // Initialize context file
  try {
    await fs.access(CHAT_CONTEXT_FILE);
    // Try to read and validate
    const data = await fs.readFile(CHAT_CONTEXT_FILE, 'utf8');
    JSON.parse(data); // Test if valid JSON
  } catch {
    console.log('Creating new context.json file...');
    await fs.writeFile(CHAT_CONTEXT_FILE, JSON.stringify({ messages: [] }, null, 2));
  }
}

// Safe load/save functions with error handling
async function loadTasks() {
  try {
    const data = await fs.readFile(TASKS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading tasks, creating new file:', error);
    const emptyTasks = { tasks: [] };
    await fs.writeFile(TASKS_FILE, JSON.stringify(emptyTasks, null, 2));
    return emptyTasks;
  }
}

async function saveTasks(tasks) {
  await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

async function loadContext() {
  try {
    const data = await fs.readFile(CHAT_CONTEXT_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading context, creating new file:', error);
    const emptyContext = { messages: [] };
    await fs.writeFile(CHAT_CONTEXT_FILE, JSON.stringify(emptyContext, null, 2));
    return emptyContext;
  }
}

async function saveContext(context) {
  await fs.writeFile(CHAT_CONTEXT_FILE, JSON.stringify(context, null, 2));
}

// Main message handler
bot.on('message', async (msg) => {
  // Ignore bot's own messages
  if (msg.from.is_bot) return;
  
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || msg.from.username || 'Unbekannt';
  const text = msg.text || '';
  
  // Skip if no text
  if (!text) return;
  
  console.log(`[${new Date().toISOString()}] ${userName}: ${text}`);
  
  try {
    // Save to context
    const context = await loadContext();
    context.messages.push({
      timestamp: new Date().toISOString(),
      user: userName,
      userId: msg.from.id,
      text: text,
      chatId: chatId
    });
    
    // Keep only last 50 messages for context
    if (context.messages.length > 50) {
      context.messages = context.messages.slice(-50);
    }
    await saveContext(context);
    
    // Check if it's asking about tasks
    const isAskingAboutTasks = checkIfAskingAboutTasks(text);
    
    if (isAskingAboutTasks) {
      await handleTaskQuery(chatId);
      return;
    }
    
    // Check if marking task as done
    const isDoneMessage = checkIfDoneMessage(text);
    
    if (isDoneMessage) {
      await handleDoneMessage(chatId, text, userName);
      return;
    }
    
    // Process with AI for task extraction
    const result = await processMessage(text, userName, context.messages);
    
    if (result.tasksFound.length > 0) {
      // Save new tasks
      const savedTasks = await loadTasks();
      savedTasks.tasks.push(...result.tasksFound);
      await saveTasks(savedTasks);
      
      // Send confirmation
      bot.sendMessage(chatId, result.response);
    } else if (result.shouldRespond) {
      // Bot was mentioned or asked something
      bot.sendMessage(chatId, result.response);
    }
    // Otherwise stay silent
    
  } catch (error) {
    console.error('Error processing message:', error);
    // Stay silent on errors
  }
});

// Check if asking about tasks
function checkIfAskingAboutTasks(text) {
  const lowerText = text.toLowerCase();
  const taskQuestions = [
    'was müssen wir',
    'was brauchen wir', 
    'was war nochmal',
    'was sollten wir',
    'einkaufsliste',
    'was kaufen',
    'was besorgen',
    'was ist zu tun',
    'offene aufgaben',
    'todo',
    'was steht an',
    'liste'
  ];
  
  return taskQuestions.some(q => lowerText.includes(q));
}

// Check if marking as done
function checkIfDoneMessage(text) {
  const donePatterns = [
    /^(done|erledigt|fertig|gemacht|gekauft|geholt|✓|✔|☑)/i,
    /^(hab|habe|haben) .* (gekauft|geholt|gemacht|erledigt)/i,
    /^(ist|sind|war|waren) (erledigt|fertig|gemacht)/i
  ];
  
  return donePatterns.some(pattern => pattern.test(text));
}

// Handle task queries
async function handleTaskQuery(chatId) {
  try {
    const tasks = await loadTasks();
    const activeTasks = tasks.tasks.filter(t => !t.completed);
    
    if (activeTasks.length === 0) {
      bot.sendMessage(chatId, "Alles erledigt! 🎉");
      return;
    }
    
    // Group by category/location
    const shopping = activeTasks.filter(t => t.category === 'shopping');
    const other = activeTasks.filter(t => t.category !== 'shopping');
    
    let response = "";
    
    if (shopping.length > 0) {
      // Group shopping by location
      const byLocation = {};
      shopping.forEach(task => {
        const loc = task.location || 'Sonstiges';
        if (!byLocation[loc]) byLocation[loc] = [];
        byLocation[loc].push(task);
      });
      
      response += "**Einkaufen:**\n";
      for (const [location, tasks] of Object.entries(byLocation)) {
        response += `\n📍 ${location}:\n`;
        tasks.forEach(task => {
          response += `• ${task.title} (von ${task.createdBy})\n`;
        });
      }
    }
    
    if (other.length > 0) {
      response += "\n**Sonstiges:**\n";
      other.forEach(task => {
        response += `• ${task.title} (von ${task.createdBy})\n`;
      });
    }
    
    bot.sendMessage(chatId, response || "Nichts zu tun! 🎉", { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Error handling task query:', error);
    bot.sendMessage(chatId, "Ups, da ist was schiefgelaufen beim Laden der Tasks 😅");
  }
}

// Handle done messages
async function handleDoneMessage(chatId, text, userName) {
  try {
    const tasks = await loadTasks();
    const activeTasks = tasks.tasks.filter(t => !t.completed);
    
    if (activeTasks.length === 0) {
      bot.sendMessage(chatId, "Es gibt nichts zu erledigen! 🤷");
      return;
    }
    
    // Try to find what was completed
    const words = text.split(' ').slice(1);
    const searchText = words.join(' ').toLowerCase();
    
    let completedTask = null;
    
    if (searchText) {
      // Search for specific task
      completedTask = activeTasks.find(task => 
        task.title.toLowerCase().includes(searchText) ||
        searchText.includes(task.title.toLowerCase())
      );
    } else {
      // If just "done", complete last task by this user
      completedTask = activeTasks
        .filter(t => t.createdBy === userName)
        .pop();
    }
    
    if (completedTask) {
      completedTask.completed = true;
      completedTask.completedAt = new Date().toISOString();
      completedTask.completedBy = userName;
      
      await saveTasks(tasks);
      
      const responses = [
        `✅ Super, ${completedTask.title} kann abgehakt werden!`,
        `👍 ${completedTask.title} erledigt!`,
        `🎯 Check! ${completedTask.title} ✓`,
        `💪 Nice! ${completedTask.title} ist done!`
      ];
      
      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
      bot.sendMessage(chatId, randomResponse);
    } else {
      bot.sendMessage(chatId, "Hmm, ich bin nicht sicher was du erledigt hast. Kannst du es genauer sagen? 🤔");
    }
    
  } catch (error) {
    console.error('Error handling done message:', error);
  }
}

// AI Processing
async function processMessage(text, userName, recentMessages) {
  // Build context from recent messages
  const contextString = recentMessages.slice(-10).map(m => 
    `${m.user}: ${m.text}`
  ).join('\n');
  
  const prompt = `
Du bist ein hilfsbereiter Assistent in einem Telegram-Gruppenchat. Du liest mit und merkst dir Aufgaben.

KONTEXT der letzten Nachrichten:
${contextString}

AKTUELLE NACHRICHT von ${userName}: "${text}"

DEINE AUFGABEN:
1. Erkenne ob Tasks/Aufgaben erwähnt werden
2. Verstehe deutschen Kontext (DM = Drogeriemarkt, etc.)
3. Antworte NUR wenn neue Tasks erkannt wurden

TASK-ERKENNUNG:
- "Wir brauchen..." → Task
- "Nicht vergessen..." → Task  
- "DM: Zahnbürste" → Task: Zahnbürste bei DM kaufen
- "Zahnbürste" allein → Task: Zahnbürste kaufen
- Einkaufslisten
- Termine/Verabredungen
- Alles was erledigt werden muss

ANTWORT-STIL:
- Kurz und natürlich
- Wie ein Freund, nicht wie ein Roboter
- Bestätige Tasks freundlich
- KEINE Antwort wenn keine Tasks erkannt wurden

Antworte als JSON:
{
  "shouldRespond": true/false,
  "response": "Deine natürliche Antwort oder null",
  "tasksFound": [
    {
      "title": "Was zu tun ist",
      "assignedTo": "Person",
      "location": "Ort oder null",
      "dueDate": "YYYY-MM-DD oder null",
      "category": "shopping/household/work/personal",
      "createdBy": "${userName}",
      "createdAt": "${new Date().toISOString()}"
    }
  ]
}

WICHTIG: Antworte NUR mit JSON, nichts anderes!
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1", // oder gpt-4o-mini wenn du es hast
      messages: [
        { 
          role: "system", 
          content: "Du bist ein Task-Management-Assistent. Antworte NUR mit validem JSON, nichts anderes!"
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500,
    });
    
    const response = completion.choices[0].message.content;
    console.log('AI Response:', response);
    
    try {
      const parsed = JSON.parse(response);
      return parsed;
    } catch (e) {
      console.error('JSON Parse error:', e);
      console.error('Response was:', response);
      
      // Try to extract JSON if it's wrapped in something
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e2) {
          console.error('Second parse attempt failed:', e2);
        }
      }
      
      // Fallback
      return {
        shouldRespond: false,
        response: null,
        tasksFound: []
      };
    }
    
  } catch (error) {
    console.error('OpenAI Error:', error);
    
    // Simple fallback detection without AI
    const taskKeywords = ['kaufen', 'brauchen', 'holen', 'müssen', 'vergessen', 'dm', 'rewe', 'aldi'];
    const hasTaskKeyword = taskKeywords.some(keyword => text.toLowerCase().includes(keyword));
    
    if (hasTaskKeyword) {
      return {
        shouldRespond: true,
        response: "Alles klar, hab's notiert! 📝",
        tasksFound: [{
          title: text,
          assignedTo: userName,
          location: null,
          dueDate: null,
          category: 'general',
          createdBy: userName,
          createdAt: new Date().toISOString()
        }]
      };
    }
    
    return {
      shouldRespond: false,
      response: null,
      tasksFound: []
    };
  }
}

// Start the bot
initStorage().then(() => {
  console.log('✅ Natürlicher Task-Bot gestartet!');
  console.log('📱 Füge den Bot zu einer Gruppe hinzu und chatte normal!');
  console.log('🤖 Der Bot merkt sich automatisch alle Aufgaben.');
}).catch(error => {
  console.error('Failed to initialize storage:', error);
  process.exit(1);
});

// Error handlers
bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

