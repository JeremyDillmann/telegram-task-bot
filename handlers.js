// handlers.js
const { bot } = require('./bot');
const { db } = require('./db');

// Helper für Zeit-Schätzungen
function estimateTaskDuration(title) {
  const quickTasks = ['lüften', 'müll', 'post', 'spülmaschine aus'];
  const mediumTasks = ['saugen', 'wischen', 'aufräumen', 'einkaufen'];
  const longTasks = ['putzen', 'waschen', 'kochen', 'garten'];
  
  const titleLower = title.toLowerCase();
  
  if (quickTasks.some(task => titleLower.includes(task))) return 5;
  if (mediumTasks.some(task => titleLower.includes(task))) return 20;
  if (longTasks.some(task => titleLower.includes(task))) return 45;
  
  return 15; // Default
}

const handlers = {
  createTasks({ tasks }, person, chatId) {
    try {
      let added = 0;
      const stmt = db.prepare(`
        INSERT INTO tasks (title, who, when_text, where_text, importance, category, createdBy, createdAt) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const task of tasks) {
        try {
          stmt.run(
            task.title,
            person,
            task.when_text || null,
            task.where_text || null,
            task.importance || 'normal',
            task.category || 'general',
            person,
            new Date().toISOString()
          );
          added++;
        } catch (err) {
          console.log('Skipping duplicate task');
        }
      }
      
      // Verbesserte Antworten
      if (added === 1) {
        bot.sendMessage(chatId, `Gemerkt: ${tasks[0].title}`);
      } else if (added > 1 && added <= 5) {
        bot.sendMessage(chatId, `${added} neue dabei`);
      } else if (added > 5) {
        bot.sendMessage(chatId, `Uff, ${added} Sachen! Soll ich priorisieren?`);
      } else {
        bot.sendMessage(chatId, "Hab ich schon.");
      }
    } catch (err) {
      console.error('Create error:', err);
      bot.sendMessage(chatId, "Fehler beim Speichern.");
    }
  },

  listTasks({ scope }, person, chatId) {
    try {
      let query = 'SELECT * FROM tasks WHERE completed = 0';
      const params = [];
      
      if (scope === 'personal') {
        query += ' AND who = ?';
        params.push(person);
      }
      
      query += ' ORDER BY importance DESC, category';
      
      const stmt = db.prepare(query);
      const tasks = stmt.all(...params);
      
      if (tasks.length === 0) {
        bot.sendMessage(chatId, "Alles erledigt! 🎉");
        return;
      }
      
      let message = '';
      let currentCategory = '';
      
      tasks.forEach(task => {
        const cat = task.importance === 'urgent' ? '🚨 DRINGEND' : 
                   task.category === 'shopping' ? '🛒 EINKAUFEN' :
                   task.category === 'household' ? '🏠 HAUSHALT' :
                   task.category === 'work' ? '💼 ARBEIT' :
                   task.category === 'personal' ? '👤 PERSÖNLICH' :
                   '📋 ALLGEMEIN';
                   
        if (cat !== currentCategory) {
          message += `\n${cat}:\n`;
          currentCategory = cat;
        }
        
        const parts = [task.title];
        if (task.where_text) parts.push(`@${task.where_text}`);
        if (task.when_text) parts.push(`(${task.when_text})`);
        
        message += `• ${parts.join(' ')}\n`;
      });
      
      message += `\n📊 Gesamt: ${tasks.length} Aufgaben`;
      bot.sendMessage(chatId, message.trim());
    } catch (err) {
      console.error('List error:', err);
      bot.sendMessage(chatId, "Fehler beim Abrufen.");
    }
  },

  suggestTasks({ timeAvailable, count, context }, person, chatId) {
    try {
      let query = 'SELECT * FROM tasks WHERE completed = 0 AND who = ?';
      const params = [person];
      
      // NEU: Location-based filtering
      if (context && context.toLowerCase().includes('bei ')) {
        const location = context.toLowerCase().replace('bei ', '').trim();
        query += ' AND (where_text LIKE ? OR title LIKE ?)';
        params.push(`%${location}%`, `%${location}%`);
        
        const stmt = db.prepare(query);
        const tasks = stmt.all(...params);
        
        if (tasks.length === 0) {
          bot.sendMessage(chatId, `Nichts bei ${location} zu erledigen.`);
          return;
        }
        
        let message = `Bei ${location}:\n`;
        tasks.forEach(task => {
          message += `• ${task.title}\n`;
        });
        
        bot.sendMessage(chatId, message.trim());
        return;
      }
      
      // Zeit-basierte Vorschläge
      query += ' ORDER BY importance DESC, category';
      const stmt = db.prepare(query);
      const tasks = stmt.all(...params);
      
      if (tasks.length === 0) {
        bot.sendMessage(chatId, "Keine Aufgaben vorhanden.");
        return;
      }
      
      let suggestions = [];
      
      if (timeAvailable) {
        // Filtere nach geschätzter Dauer
        let remainingTime = timeAvailable;
        for (const task of tasks) {
          const duration = estimateTaskDuration(task.title);
          if (duration <= remainingTime) {
            suggestions.push({ ...task, duration });
            remainingTime -= duration;
            if (suggestions.length >= (count || 3)) break;
          }
        }
        
        if (suggestions.length === 0) {
          // Nimm kürzeste Aufgabe
          suggestions = [tasks[0]];
        }
        
        let message = `${timeAvailable} Min reichen für:\n`;
        suggestions.forEach(task => {
          message += `✓ ${task.title} (${task.duration || '?'} Min)\n`;
        });
        
        bot.sendMessage(chatId, message.trim());
      } else {
        // Standard-Vorschläge
        suggestions = tasks.slice(0, count || 3);
        let message = `Mach das als nächstes:\n`;
        suggestions.forEach((task, i) => {
          message += `${i + 1}. ${task.title}\n`;
        });
        
        bot.sendMessage(chatId, message.trim());
      }
    } catch (err) {
      console.error('Suggest error:', err);
      bot.sendMessage(chatId, "Fehler bei Vorschlägen.");
    }
  },

  editTask({ taskIdentifier, updates }, person, chatId) {
    try {
      // First find the task
      const findStmt = db.prepare(`
        SELECT * FROM tasks 
        WHERE completed = 0 AND who = ? AND title LIKE ?
        LIMIT 1
      `);
      
      const task = findStmt.get(person, `%${taskIdentifier}%`);
      
      if (!task) {
        // NEU: Disambiguation
        const similar = db.prepare(`
          SELECT title FROM tasks 
          WHERE completed = 0 AND who = ?
          AND title LIKE ?
          LIMIT 3
        `).all(person, `%${taskIdentifier.substring(0,3)}%`);
        
        if (similar.length > 0) {
          bot.sendMessage(chatId, 
            `"${taskIdentifier}" nicht gefunden.\nMeintest du: ${similar[0].title}?`
          );
        } else {
          bot.sendMessage(chatId, "Aufgabe nicht gefunden.");
        }
        return;
      }
      
      // Build update query
      const updateFields = [];
      const params = [];
      
      if (updates.newTitle) {
        updateFields.push('title = ?');
        params.push(updates.newTitle);
      }
      if (updates.newWhen !== undefined) {
        updateFields.push('when_text = ?');
        params.push(updates.newWhen || null);
      }
      if (updates.newWhere !== undefined) {
        updateFields.push('where_text = ?');
        params.push(updates.newWhere || null);
      }
      if (updates.newCategory) {
        updateFields.push('category = ?');
        params.push(updates.newCategory);
      }
      if (updates.newImportance) {
        updateFields.push('importance = ?');
        params.push(updates.newImportance);
      }
      
      if (updateFields.length === 0) {
        bot.sendMessage(chatId, "Nichts zu ändern.");
        return;
      }
      
      params.push(task.id);
      
      const updateStmt = db.prepare(`
        UPDATE tasks 
        SET ${updateFields.join(', ')}
        WHERE id = ?
      `);
      
      const result = updateStmt.run(...params);
      
      if (result.changes > 0) {
        bot.sendMessage(chatId, "Aktualisiert ✓");
      } else {
        bot.sendMessage(chatId, "Fehler beim Update.");
      }
    } catch (err) {
      console.error('Edit error:', err);
      bot.sendMessage(chatId, "Fehler beim Bearbeiten.");
    }
  },

  completeTasks({ taskIdentifiers }, person, chatId) {
    try {
      let completed = 0;
      let completedTitles = [];
      
      for (const identifier of taskIdentifiers) {
        // NEU: Context-aware completion
        if (identifier.toLowerCase().includes('edeka') && 
            (identifier.toLowerCase().includes('zeug') || 
             identifier.toLowerCase().includes('sachen') ||
             identifier.toLowerCase().includes('alles'))) {
          // Complete ALL Edeka tasks
          const stmt = db.prepare(`
            UPDATE tasks 
            SET completed = 1, completedAt = ?, completedBy = ? 
            WHERE completed = 0 AND who = ? 
            AND (where_text LIKE '%Edeka%' OR title LIKE '%Edeka%')
          `);
          
          const result = stmt.run(
            new Date().toISOString(),
            person,
            person
          );
          
          if (result.changes > 0) {
            completed += result.changes;
            completedTitles.push(`Edeka erledigt (${result.changes} Sachen)`);
          }
        } else if (identifier.toLowerCase() === 'küche fertig' ||
                   identifier.toLowerCase() === 'küche') {
          // Complete all kitchen tasks
          const stmt = db.prepare(`
            UPDATE tasks 
            SET completed = 1, completedAt = ?, completedBy = ? 
            WHERE completed = 0 AND who = ? 
            AND (title LIKE '%küche%' OR title LIKE '%geschirr%' OR title LIKE '%spül%')
          `);
          
          const result = stmt.run(
            new Date().toISOString(),
            person,
            person
          );
          
          if (result.changes > 0) {
            completed += result.changes;
            completedTitles.push('Küche fertig! 🎉');
          }
        } else {
          // Standard completion
          const stmt = db.prepare(`
            UPDATE tasks 
            SET completed = 1, completedAt = ?, completedBy = ? 
            WHERE completed = 0 AND who = ? AND title LIKE ?
          `);
          
          const result = stmt.run(
            new Date().toISOString(),
            person,
            person,
            `%${identifier}%`
          );
          
          if (result.changes > 0) {
            completed++;
            // Get the actual task title
            const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(result.lastInsertRowid);
            if (task) completedTitles.push(task.title);
          }
        }
      }
      
      if (completed === 0) {
        // NEU: Better disambiguation
        const firstIdentifier = taskIdentifiers[0];
        const similar = db.prepare(`
          SELECT title FROM tasks 
          WHERE completed = 0 AND who = ?
          AND title LIKE ?
          LIMIT 3
        `).all(person, `%${firstIdentifier.substring(0,3)}%`);
        
        if (similar.length > 0) {
          bot.sendMessage(chatId, 
            `"${firstIdentifier}" nicht gefunden.\nMeintest du: ${similar[0].title}?`
          );
        } else {
          bot.sendMessage(chatId, "Nichts gefunden.");
        }
      } else if (completed === 1 && completedTitles[0]) {
        bot.sendMessage(chatId, `✓ ${completedTitles[0]}`);
      } else {
        bot.sendMessage(chatId, completedTitles.join('\n') || `${completed} erledigt ✓`);
      }
    } catch (err) {
      console.error('Complete error:', err);
      bot.sendMessage(chatId, "Fehler beim Erledigen.");
    }
  },

  deleteTasks({ taskIdentifiers }, person, chatId) {
    try {
      let deleted = 0;
      
      for (const identifier of taskIdentifiers) {
        const stmt = db.prepare(`
          DELETE FROM tasks 
          WHERE completed = 0 AND who = ? AND title LIKE ?
        `);
        
        const result = stmt.run(person, `%${identifier}%`);
        
        if (result.changes > 0) deleted++;
      }
      
      if (deleted === 0) {
        // NEU: Disambiguation
        const firstIdentifier = taskIdentifiers[0];
        const similar = db.prepare(`
          SELECT title FROM tasks 
          WHERE completed = 0 AND who = ?
          AND title LIKE ?
          LIMIT 3
        `).all(person, `%${firstIdentifier.substring(0,3)}%`);
        
        if (similar.length > 0) {
          bot.sendMessage(chatId, 
            `"${firstIdentifier}" nicht gefunden.\nMeintest du: ${similar[0].title}?`
          );
        } else {
          bot.sendMessage(chatId, "Nichts gefunden.");
        }
      } else if (deleted === 1) {
        bot.sendMessage(chatId, "Gelöscht.");
      } else {
        bot.sendMessage(chatId, `${deleted} gelöscht.`);
      }
    } catch (err) {
      console.error('Delete error:', err);
      bot.sendMessage(chatId, "Fehler beim Löschen.");
    }
  },

  clearAllTasks(args, person, chatId) {
    try {
      const stmt = db.prepare(`
        UPDATE tasks 
        SET completed = 1, completedAt = ?, completedBy = ? 
        WHERE completed = 0 AND who = ?
      `);
      
      const result = stmt.run(
        new Date().toISOString(),
        person,
        person
      );
      
      bot.sendMessage(chatId, `${result.changes} Aufgaben gelöscht.`);
    } catch (err) {
      console.error('Clear error:', err);
      bot.sendMessage(chatId, "Fehler beim Löschen.");
    }
  },

  respond({ message }, person, chatId) {
    bot.sendMessage(chatId, message);
  }
};

module.exports = handlers;