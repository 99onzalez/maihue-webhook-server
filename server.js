require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const redis = require('redis');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(bodyParser.json());

// =====================
// CONFIGURACIÓN
// =====================

const PORT = process.env.PORT || 3000;

// Evolution API
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-0237.up.railway.app';
const INSTANCE_ID = process.env.INSTANCE_ID || '9C60DB508943-4380-855D-F5E612394CF5';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'sua-api-key-aqui';

// GHL Webhook Secret
const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || 'tu-secret-aqui';

// Números de ejecutivos (completaremos después)
const EXECUTIVES = {
  gerardo: '56961451738', // Tu número
  josefina: '569XXXXXXXX',
  carolina: '569XXXXXXXX'
};

// URLs de formularios por proyecto
const FORM_URLS = {
  volkania: process.env.VOLKANIA_FORM_URL || 'https://tu-dominio.com/volkania',
  tricalen: process.env.TRICALEN_FORM_URL || 'https://tu-dominio.com/tricalen'
};

// Audio (ruta dentro del contenedor de Railway)
const AUDIO_PATH = process.env.AUDIO_PATH || '/app/audios/audio_pdo_gerardo.aac';

// =====================
// REDIS CLIENT
// =====================

const redisClient = redis.createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: 0
});

redisClient.on('error', (err) => console.error('Redis Error:', err));
redisClient.on('connect', () => console.log('✅ Redis conectado'));

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('Error al conectar Redis:', err);
  }
})();

// =====================
// FUNCIONES AUXILIARES
// =====================

/**
 * Identifica el proyecto basado en la URL del formulario
 */
function identifyProject(formUrl) {
  if (!formUrl) return null;
  
  if (formUrl.includes('volkania')) return 'volkania';
  if (formUrl.includes('tricalen')) return 'tricalen';
  
  return null;
}

/**
 * Round Robin para Volkania (Gerardo ↔ Josefina)
 */
async function getRoundRobinExecutive() {
  try {
    const key = 'volkania:round_robin:last';
    let lastExecutive = await redisClient.get(key);
    
    // Si no existe, empezamos con gerardo
    if (!lastExecutive) {
      await redisClient.set(key, 'gerardo');
      return 'gerardo';
    }
    
    // Alternamos
    const nextExecutive = lastExecutive === 'gerardo' ? 'josefina' : 'gerardo';
    await redisClient.set(key, nextExecutive);
    
    return nextExecutive;
  } catch (err) {
    console.error('Error en Round Robin:', err);
    return 'gerardo'; // Default fallback
  }
}

/**
 * Obtiene el número de WhatsApp del ejecutivo
 */
function getExecutivePhone(executiveName) {
  return EXECUTIVES[executiveName] || EXECUTIVES.gerardo;
}

/**
 * Envía mensaje de texto vía Evolution API
 */
async function sendTextMessage(phoneNumber, message) {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${INSTANCE_ID}`,
      {
        number: phoneNumber,
        text: message
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        }
      }
    );
    
    console.log(`✅ Mensaje de texto enviado a ${phoneNumber}`);
    return response.data;
  } catch (err) {
    console.error(`❌ Error enviando texto a ${phoneNumber}:`, err.message);
    throw err;
  }
}

/**
 * Envía audio vía Evolution API
 */
async function sendAudioMessage(phoneNumber, audioPath) {
  try {
    // Verificar que el archivo existe
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Archivo de audio no encontrado: ${audioPath}`);
    }
    
    // Leer archivo como buffer
    const audioBuffer = fs.readFileSync(audioPath);
    const base64Audio = audioBuffer.toString('base64');
    
    const response = await axios.post(
      `${EVOLUTION_API_URL}/message/sendMedia/${INSTANCE_ID}`,
      {
        number: phoneNumber,
        mediatype: 'audio',
        media: base64Audio,
        fileName: 'mensaje_bienvenida.aac'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        }
      }
    );
    
    console.log(`✅ Audio enviado a ${phoneNumber}`);
    return response.data;
  } catch (err) {
    console.error(`❌ Error enviando audio a ${phoneNumber}:`, err.message);
    throw err;
  }
}

/**
 * Envía mensaje + audio con latencia
 */
async function sendMessageAndAudio(phoneNumber, leadName, message, audioPath, delay = 120000) {
  try {
    // Enviar mensaje de texto
    const formattedMessage = message.replace('{nombre}', leadName);
    await sendTextMessage(phoneNumber, formattedMessage);
    
    // Esperar 120 segundos
    console.log(`⏱️  Esperando ${delay / 1000} segundos antes de enviar audio...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Enviar audio
    await sendAudioMessage(phoneNumber, audioPath);
    
    return {
      success: true,
      message: 'Mensaje y audio enviados correctamente',
      phoneNumber,
      leadName
    };
  } catch (err) {
    console.error('Error en envío de mensaje + audio:', err.message);
    throw err;
  }
}

// =====================
// RUTAS
// =====================

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date(),
    instance: INSTANCE_ID
  });
});

/**
 * Webhook de GHL - Se dispara cuando se crea una oportunidad
 */
app.post('/webhook/ghl', async (req, res) => {
  try {
    console.log('📨 Webhook recibido de GHL');
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    
    // Extraer datos del webhook
    const {
      contactId,
      contactName,
      contactPhone,
      opportunityId,
      formUrl,
      project
    } = req.body;
    
    // Validar datos mínimos
    if (!contactName || !contactPhone) {
      return res.status(400).json({
        error: 'Datos insuficientes: se requiere nombre y teléfono'
      });
    }
    
    // Identificar el proyecto
    const projectName = project || identifyProject(formUrl);
    
    if (!projectName) {
      return res.status(400).json({
        error: 'No se pudo identificar el proyecto'
      });
    }
    
    console.log(`🎯 Proyecto identificado: ${projectName}`);
    
    // Asignar ejecutivo según proyecto
    let executiveName;
    if (projectName === 'volkania') {
      executiveName = await getRoundRobinExecutive();
      console.log(`🔄 Round Robin - Asignado a: ${executiveName}`);
    } else if (projectName === 'tricalen') {
      executiveName = 'carolina';
      console.log(`📌 Asignado a: Carolina (Tricalén)`);
    }
    
    const phoneNumber = getExecutivePhone(executiveName);
    
    // Formatear mensaje
    const projectDisplay = projectName.charAt(0).toUpperCase() + projectName.slice(1);
    const message = `Hola ${contactName}, gracias por tu interés en ${projectDisplay}. Te enviaremos más información en breve. ¿Tienes alguna pregunta?`;
    
    // Enviar mensaje + audio (async, no esperar respuesta)
    sendMessageAndAudio(
      phoneNumber,
      contactName,
      message,
      AUDIO_PATH,
      120000
    ).catch(err => {
      console.error('Error en envío de mensaje/audio:', err.message);
    });
    
    // Responder inmediatamente a GHL
    res.json({
      success: true,
      message: 'Webhook procesado correctamente',
      data: {
        contactName,
        projectName,
        assignedExecutive: executiveName,
        opportunityId
      }
    });
    
    // Log
    console.log(`✅ Lead procesado: ${contactName} → ${executiveName} (${projectName})`);
    
  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
    res.status(500).json({
      error: 'Error procesando webhook',
      message: err.message
    });
  }
});

/**
 * Prueba manual: enviar mensaje de prueba
 */
app.post('/test/send-message', async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    
    if (!phoneNumber || !message) {
      return res.status(400).json({
        error: 'Se requiere phoneNumber y message'
      });
    }
    
    const result = await sendTextMessage(phoneNumber, message);
    
    res.json({
      success: true,
      result
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * Prueba manual: enviar audio
 */
app.post('/test/send-audio', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        error: 'Se requiere phoneNumber'
      });
    }
    
    const result = await sendAudioMessage(phoneNumber, AUDIO_PATH);
    
    res.json({
      success: true,
      result
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * Ver estado de Round Robin
 */
app.get('/debug/round-robin', async (req, res) => {
  try {
    const lastExecutive = await redisClient.get('volkania:round_robin:last');
    res.json({
      lastExecutive: lastExecutive || 'ninguno (será gerardo próxima vez)'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// INICIAR SERVIDOR
// =====================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║  🚀 Servidor Maihue Webhook                ║
║  Puerto: ${PORT}                            
║  Instance ID: ${INSTANCE_ID}  
║  Estado: Online                            ║
╚════════════════════════════════════════════╝
  `);
  console.log('Rutas disponibles:');
  console.log('  GET  /health');
  console.log('  POST /webhook/ghl');
  console.log('  POST /test/send-message');
  console.log('  POST /test/send-audio');
  console.log('  GET  /debug/round-robin');
});
