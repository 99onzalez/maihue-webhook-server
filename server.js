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

// Instancia de Evolution API (WhatsApp) por ejecutivo — cada uno envía desde SU propio número
// Mientras Josefina y Carolina no tengan su número conectado, usamos la de Gerardo como respaldo
const EXECUTIVE_INSTANCES = {
  gerardo: process.env.INSTANCE_GERARDO || INSTANCE_ID,
  josefina: process.env.INSTANCE_JOSEFINA || INSTANCE_ID, // pendiente: conectar número propio
  carolina: process.env.INSTANCE_CAROLINA || INSTANCE_ID  // pendiente: conectar número propio
};

/**
 * Limpia y formatea un número de teléfono al formato que espera Evolution API
 * Ej: "9 5524 8898" -> "56995248898"
 */
function formatPhoneNumber(rawPhone) {
  if (!rawPhone) return null;
  // Quitar todo lo que no sea número
  let digits = rawPhone.replace(/\D/g, '');
  // Si ya trae el código de país (56) y tiene 11 dígitos, lo dejamos tal cual
  if (digits.startsWith('56') && digits.length === 11) {
    return digits;
  }
  // Si es un móvil chileno de 9 dígitos empezando en 9, le agregamos 56
  if (digits.length === 9 && digits.startsWith('9')) {
    return `56${digits}`;
  }
  // Si son 8 dígitos (sin el 9 inicial), agregamos 569
  if (digits.length === 8) {
    return `569${digits}`;
  }
  // Fallback: devolver tal cual quedó (limpio de espacios/símbolos)
  return digits;
}

// URLs de formularios por proyecto
const FORM_URLS = {
  volkania: process.env.VOLKANIA_FORM_URL || 'https://tu-dominio.com/volkania',
  tricalen: process.env.TRICALEN_FORM_URL || 'https://tu-dominio.com/tricalen'
};

// Audios por segmento (ruta dentro del contenedor de Railway)
// "Poco Pie" usa el audio que ya tenemos. "Calificado" se sube más adelante.
// Carpeta base de audios, organizada por ejecutivo: audios/{ejecutivo}/ogg/{segmento}.ogg
const AUDIO_BASE_PATH = process.env.AUDIO_BASE_PATH || '/app/audios';

// Valores exactos que llegan desde el formulario de Meta (pregunta de presupuesto)
const BUDGET_VALUES = {
  calificado: 'Más de $6.000.000',
  poco_pie: 'Entre $4.000.000 y $6.000.000'
};

// Mapeo: ID de usuario "Assigned To" en GHL -> clave interna del ejecutivo
// Ve a Settings → My Staff → click en el usuario → revisa la URL para obtener el ID
const OWNER_ID_MAP = {
  'xfGUbyF37C0bBtsNGHgb': 'gerardo',
  // 'ID_DE_JOSEFINA_AQUI': 'josefina',
  // 'ID_DE_CAROLINA_AQUI': 'carolina',
};

/**
 * Traduce el ID del "Assigned To" de GHL a nuestra clave interna de ejecutivo
 */
function mapOwnerToExecutive(assignedToId) {
  if (!assignedToId) return null;
  return OWNER_ID_MAP[assignedToId.trim()] || null;
}
function getSegment(budgetAnswer, tags) {
  if (tags) {
    const tagList = (Array.isArray(tags) ? tags : tags.split(',')).map(t => t.trim().toLowerCase());
    if (tagList.includes('calificado-volkania')) return 'calificado';
    if (tagList.includes('poco-pie-volkania')) return 'poco_pie';
  }
  if (!budgetAnswer) return 'poco_pie'; // fallback seguro
  const answer = budgetAnswer.trim();
  if (answer === BUDGET_VALUES.calificado) return 'calificado';
  if (answer === BUDGET_VALUES.poco_pie) return 'poco_pie';
  return 'poco_pie'; // fallback si llega un valor inesperado
}

/**
 * Obtiene la ruta de audio correcta, con fallback si el archivo aún no existe
 */
function getAudioPath(executiveName, segment) {
  const primary = `${AUDIO_BASE_PATH}/${executiveName}/ogg/${segment}.ogg`;
  if (fs.existsSync(primary)) return primary;
  
  console.warn(`⚠️  No hay audio de "${segment}" para ${executiveName}, buscando respaldo...`);
  
  // Respaldo 1: el audio de Gerardo para ese mismo segmento
  const fallbackSameSegment = `${AUDIO_BASE_PATH}/gerardo/ogg/${segment}.ogg`;
  if (fs.existsSync(fallbackSameSegment)) return fallbackSameSegment;
  
  // Respaldo 2: el audio de "poco_pie" de Gerardo (el que siempre debería existir)
  const finalFallback = `${AUDIO_BASE_PATH}/gerardo/ogg/poco_pie.ogg`;
  console.warn(`⚠️  Usando audio de respaldo final: ${finalFallback}`);
  return finalFallback;
}

// =====================
// REDIS CLIENT
// =====================

const redisClient = process.env.REDIS_URL
  ? redis.createClient({ url: process.env.REDIS_URL })
  : redis.createClient({
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
 * Obtiene la instancia de Evolution API (WhatsApp) del ejecutivo asignado
 */
function getExecutiveInstance(executiveName) {
  return EXECUTIVE_INSTANCES[executiveName] || EXECUTIVE_INSTANCES.gerardo;
}

/**
 * Envía mensaje de texto vía Evolution API
 */
async function sendTextMessage(phoneNumber, message, instanceId = INSTANCE_ID) {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${instanceId}`,
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
    
    console.log(`✅ Mensaje de texto enviado a ${phoneNumber} (desde instancia ${instanceId})`);
    return response.data;
  } catch (err) {
    console.error(`❌ Error enviando texto a ${phoneNumber}:`, err.message);
    throw err;
  }
}

/**
 * Envía audio vía Evolution API
 */
async function sendAudioMessage(phoneNumber, audioPath, instanceId = INSTANCE_ID) {
  try {
    // Verificar que el archivo existe
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Archivo de audio no encontrado: ${audioPath}`);
    }
    
    // Leer archivo como buffer
    const audioBuffer = fs.readFileSync(audioPath);
    const base64Audio = audioBuffer.toString('base64');
    
    const response = await axios.post(
      `${EVOLUTION_API_URL}/message/sendMedia/${instanceId}`,
      {
        number: phoneNumber,
        mediatype: 'audio',
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        media: base64Audio,
        fileName: 'audio.ogg'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        }
      }
    );
    
    console.log(`✅ Audio enviado a ${phoneNumber} (desde instancia ${instanceId})`);
    return response.data;
  } catch (err) {
    console.error(`❌ Error enviando audio a ${phoneNumber}:`, err.message);
    throw err;
  }
}

/**
 * Envía mensaje + audio con latencia
 */
async function sendMessageAndAudio(phoneNumber, leadName, message, audioPath, delay = 120000, instanceId = INSTANCE_ID) {
  try {
    // Enviar mensaje de texto
    const formattedMessage = message.replace('{nombre}', leadName);
    await sendTextMessage(phoneNumber, formattedMessage, instanceId);
    
    // Esperar 120 segundos
    console.log(`⏱️  Esperando ${delay / 1000} segundos antes de enviar audio...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Enviar audio
    await sendAudioMessage(phoneNumber, audioPath, instanceId);
    
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
    
    // GHL a veces envía los datos anidados dentro de "customData"
    const payload = req.body.customData || req.body;
    
    // Extraer datos del webhook
    const {
      contactId,
      contactName,
      contactPhone,
      opportunityId,
      formUrl,
      project,
      budgetAnswer,
      assignedTo,
      tags
    } = payload;
    
    // Validar datos mínimos
    if (!contactName || !contactPhone) {
      console.error('❌ Datos insuficientes. contactName:', contactName, '| contactPhone:', contactPhone);
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
    
    // Asignar ejecutivo: primero confiamos en el Owner que GHL ya asignó
    let executiveName = mapOwnerToExecutive(assignedTo);
    
    if (executiveName) {
      console.log(`👤 Ejecutivo tomado del Owner asignado en GHL: ${executiveName}`);
    } else if (projectName === 'volkania') {
      // Respaldo: si no llegó ningún owner reconocible, usamos Round Robin interno
      executiveName = await getRoundRobinExecutive();
      console.log(`🔄 Sin owner reconocible, Round Robin interno asignó a: ${executiveName}`);
    } else if (projectName === 'tricalen') {
      executiveName = 'carolina';
      console.log(`📌 Asignado a: Carolina (Tricalén)`);
    }
    
    // El destinatario del mensaje es el LEAD, no el ejecutivo
    const phoneNumber = formatPhoneNumber(contactPhone);
    if (!phoneNumber) {
      console.error('❌ No se pudo formatear el número del lead:', contactPhone);
      return res.status(400).json({ error: 'Número de teléfono del lead inválido' });
    }
    
    // La instancia de WhatsApp desde la que se envía es la del ejecutivo asignado
    const instanceId = getExecutiveInstance(executiveName);
    
    // Determinar segmento (Calificado / Poco Pie) según respuesta de presupuesto
    // Solo aplica para Volkania por ahora; Tricalén usa audio por defecto
    const segment = projectName === 'volkania' ? getSegment(budgetAnswer, tags) : 'poco_pie';
    const audioPath = getAudioPath(executiveName, segment);
    console.log(`💰 Segmento: ${segment} (respuesta: "${budgetAnswer || 'N/A'}")`);
    
    // Formatear mensaje (mismo mensaje para ambos segmentos)
    const projectDisplay = projectName.charAt(0).toUpperCase() + projectName.slice(1);
    const message = `Hola ${contactName}, gracias por tu interés en ${projectDisplay}. Te enviaremos más información en breve. ¿Tienes alguna pregunta?`;
    
    // Enviar mensaje + audio (async, no esperar respuesta)
    sendMessageAndAudio(
      phoneNumber,
      contactName,
      message,
      audioPath,
      120000,
      instanceId
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
        segment,
        assignedExecutive: executiveName,
        opportunityId
      }
    });
    
    // Log
    console.log(`✅ Lead procesado: ${contactName} → ${executiveName} (${projectName}, ${segment})`);
    
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
    const { phoneNumber, segment, executive } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        error: 'Se requiere phoneNumber'
      });
    }
    
    const executiveName = executive || 'gerardo';
    const audioPath = getAudioPath(executiveName, segment === 'calificado' ? 'calificado' : 'poco_pie');
    const instanceId = getExecutiveInstance(executiveName);
    const result = await sendAudioMessage(phoneNumber, audioPath, instanceId);
    
    res.json({
      success: true,
      audioUsed: audioPath,
      instanceUsed: instanceId,
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
