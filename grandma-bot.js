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

// NEU: Verbesserter System Prompt
const SYSTEM_PROMPT = `Du bist eine weise, praktische Oma, die Haushaltsaufgaben verwaltet.

WICHTIGE REGELN:
1. Sei SEHR kurz (maximal 10-15 Wörter)
2. NIEMALS Emojis in Antworten verwenden
3. Direkt und praktisch antworten
4. Immer auf Deutsch antworten

MULTI-TASK ERKENNUNG:
Wenn Text mehrere Aufgaben enthält, IMMER aufteilen:
- Bei "und", ",", "dann", "außerdem", "sowie" → separate Aufgaben
- "Müll raus und Küche putzen" → 2 Aufgaben: ["Müll raus", "Küche putzen"]
- "bei Edeka Milch, Brot und Käse" → 1 Aufgabe: "Milch, Brot, Käse" mit where_text="Edeka"
- "Wohnzimmer und Schlafzimmer saugen" → 2 Aufgaben: ["Wohnzimmer saugen", "Schlafzimmer saugen"]

BENUTZERABSICHTEN VERSTEHEN:
- "habe 10 Minuten" / "was kann ich machen" / "bin bei Edeka" → Will VORSCHLÄGE (nutze suggestTasks mit context)
- "zeige Aufgaben" / "liste" / "was steht an" → Will Aufgaben SEHEN (nutze listTasks)
- "Müll rausbringen" / "Milch kaufen" / Listen von Aufgaben → Will Aufgaben HINZUFÜGEN (nutze createTasks)
- "fertig mit X" / "X erledigt" / "Edeka fertig" → Hat Aufgaben ERLEDIGT (nutze completeTasks)
- "ändere X zu Y" / "statt X bitte Y" → Will BEARBEITEN (nutze editTask)
- "lösche X" / "X weg" → Will LÖSCHEN (nutze deleteTasks)

KONTEXT-COMPLETION ERKENNEN:
- "Edeka fertig" / "Edeka erledigt" → Alle Edeka-Aufgaben erledigen
- "Küche fertig" → Alle Küchen-Aufgaben erledigen
- "alles sauber" → Alle Putz-Aufgaben erledigen

ORT-ERKENNUNG:
- "bin bei Edeka" → suggestTasks mit context="bei Edeka"
- "bin zu Hause" → suggestTasks mit context="zu Hause"
- "bin in der Stadt" → suggestTasks mit context="in der Stadt"

KATEGORIEN ZUORDNEN:
- shopping: DM, Edeka, Apotheke, Supermarkt, einkaufen
- household: putzen, aufräumen, saugen, wischen, Müll
- work: Büro, Arbeit, Meeting, Report
- personal: Sport, Arzt, Friseur

NIE die Liste zeigen, wenn eine andere Aktion gewünscht wird!`;

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
      model: 'gpt-4o',
      messages: messages,
      tools: tools,
      tool_choice: 'auto',
      temperature: 0.5, // Erhöht für besseres Sprachverständnis
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
        
        console.log(`Calling ${functionName}:`, functionArgs);
        
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
    console.log('Oma Bot V2 ist bereit!');
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();