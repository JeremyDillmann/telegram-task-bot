// tools.js
const tools = [
    {
      type: 'function',
      function: {
        name: 'createTasks',
        description: 'Neue Aufgaben erstellen. NUR wenn explizit neue Aufgaben genannt werden. NIEMALS für Fragen oder Vorschläge.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  when_text: { type: 'string' },
                  where_text: { type: 'string' },
                  category: { 
                    type: 'string', 
                    enum: ['shopping', 'household', 'work', 'personal', 'general'] 
                  },
                  importance: { 
                    type: 'string', 
                    enum: ['urgent', 'normal', 'low'] 
                  }
                },
                required: ['title']
              }
            }
          },
          required: ['tasks']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listTasks',
        description: 'Aufgaben anzeigen wenn Nutzer die Liste sehen will',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['personal', 'all']
            }
          },
          required: ['scope']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'suggestTasks',
        description: 'Aufgaben vorschlagen basierend auf Zeit oder Ort. Nutzen bei: "was kann ich machen", "bin bei X", "habe X Minuten"',
        parameters: {
          type: 'object',
          properties: {
            timeAvailable: { 
              type: 'number',
              description: 'Verfügbare Minuten (wenn erwähnt)'
            },
            count: {
              type: 'number',
              description: 'Anzahl gewünschter Vorschläge'
            },
            context: {
              type: 'string',
              description: 'Kontext wie Ort oder Situation (z.B. "bei Edeka", "zu Hause")'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'editTask',
        description: 'Aufgabe bearbeiten oder umbenennen. Nutzen bei: "ändere", "statt X bitte Y", "umbenennen"',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifier: { 
              type: 'string',
              description: 'Teil des aktuellen Aufgabentitels'
            },
            updates: {
              type: 'object',
              properties: {
                newTitle: { type: 'string' },
                newWhen: { type: 'string' },
                newWhere: { type: 'string' },
                newCategory: { 
                  type: 'string',
                  enum: ['shopping', 'household', 'work', 'personal', 'general']
                },
                newImportance: {
                  type: 'string',
                  enum: ['urgent', 'normal', 'low']
                }
              }
            }
          },
          required: ['taskIdentifier', 'updates']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'completeTasks',
        description: 'Aufgaben als erledigt markieren',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifiers: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['taskIdentifiers']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'deleteTasks',
        description: 'Aufgaben löschen ohne sie zu erledigen. Nutzen bei: "lösche", "entferne", "weg"',
        parameters: {
          type: 'object',
          properties: {
            taskIdentifiers: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['taskIdentifiers']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'clearAllTasks',
        description: 'Alle Aufgaben löschen',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'respond',
        description: 'Allgemeine Antwort wenn keine Aufgabenverwaltung nötig',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          },
          required: ['message']
        }
      }
    }
  ];
  
  module.exports = tools;