// grandma-bot.js
require('dotenv').config();
const OpenAI = require('openai');
const { bot, initBot } = require('./bot');
const { db } = require('./db');
const tools = require('./tools');
const handlers = require('./handlers');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple conversation memory
const conversations = new Map();

function remember(userId, role, content) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  const history = conversations.get(userId);
  history.push({ role, content: content || '' });
  if (history.length > 10) history.shift();
}

// Simplified and more explicit system prompt
const SYSTEM_PROMPT = `Du bist eine Aufgabenverwaltung. Kurze Antworten (max 10 Wörter).

WICHTIGSTE REGEL: Bei "umbenennen", "statt X bitte Y", "ändere X zu Y" IMMER editTask verwenden, NIEMALS createTasks!

PARSING REGELN:
- "Saugroboter aktivieren" = 1 Aufgabe (NICHT aufteilen)
- "Saugroboter für Wohnzimmer und Küche" = 1 Aufgabe: "Saugroboter aktivieren"
- "Eingang und Wohnzimmer aufräumen" = 2 Aufgaben: ["Eingang aufräumen", "Wohnzimmer aufräumen"]
- Bei Listen mit "und", ",": Trenne nur bei unterschiedlichen Tätigkeiten
- KEINE Duplikate oder Varianten erstellen!

BEFEHLE ERKENNEN:
1. Neue Aufgaben → createTasks (nur bei wirklich NEUEN Aufgaben)
2. "umbenennen/statt/ändere" → editTask (NIE createTasks!)
3. "zeige/liste" → listTasks
4. "fertig/erledigt" → completeTasks
5. "was kann ich machen/bin bei X" → suggestTasks
6. "lösche/weg" → deleteTasks

KONTEXT-COMPLETION:
- "Edeka fertig" = Alle Edeka-Aufgaben erledigen
- "Küche fertig" = Alle Küchen-Aufgaben erledigen

KATEGORIEN:
- shopping: Edeka, DM, Apotheke, einkaufen
- household: putzen, aufräumen, saugen, Müll`;

// Main message handler
bot.on('message', async (msg) => {
  if (msg.from.is_bot || !msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const person = msg.from.first_name || msg.from.username || 'Liebling';

  try {
    bot.sendChatAction(chatId, 'typing');
    
    remember(userId, 'user', msg.text);
    
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(conversations.get(userId) || [])
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Changed to mini for better structure
      messages: messages,
      tools: tools,
      tool_choice: 'auto',
      temperature: 0.2, // Lower for consistency
      max_tokens: 150
    });

    const message = response.choices[0].message;
    
    if (message.content) {
      remember(userId, 'assistant', message.content);
    }

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);
        
        console.log(`Calling ${functionName}:`, JSON.stringify(functionArgs, null, 2));
        
        if (handlers[functionName]) {
          await handlers[functionName](functionArgs, person, chatId);
        }
      }
    } else if (message.content) {
      bot.sendMessage(chatId, message.content);
    }

  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, "Fehler. Versuch's nochmal.");
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await bot.stopPolling();
  db.close();
  process.exit(0);
});

// Start bot
async function start() {
  try {
    await initBot();
    console.log('Oma Bot V3 ist bereit!');
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();