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
// Carpeta base de audios, organizada por ejecutivo: audios/{ejecutivo}/ogg/{segmento}.ogg
const AUDIO_BASE_PATH = process.env.AUDIO_BASE_PATH || '/app/audios';

// Macro-segmentos del guion aprobado (Guiones_Mensajes_Audio_Volkania.docx).
// GHL decide el segmento poniendo un tag al contacto; el servidor solo lo traduce.
// Si llegan varios tags, gana el primero de esta lista (prioridad).
const SEGMENT_TAGS = {
  contado: 'contado-volkania',
  financiamiento: 'financiamiento-volkania',
  sin_urgencia: 'sin-urgencia-volkania'
};
const SEGMENTS = Object.keys(SEGMENT_TAGS);
// Sin tag reconocible: financiamiento es el mensaje más neutro (no asume contado ni falta de urgencia)
const DEFAULT_SEGMENT = 'financiamiento';

// Texto por segmento. El emoji final es el código interno para el ejecutivo.
const SEGMENT_MESSAGES = {
  contado: 'Hola {nombre}! Vi que llenaste el formulario de Volkania, gracias por el interés 👍',
  financiamiento: 'Hola {nombre}, qué bueno que te interesó Volkania! Ya te mando más info por acá 🙌',
  sin_urgencia: 'Hola {nombre}, gracias por tu interés en Volkania! Te dejo unos datos para que vayas viendo con calma 😊'
};

// Latencias (~30 s al texto, 50–60 s al audio), con variación aleatoria para que
// los envíos no tengan un ritmo de máquina. Cada rango es [mínimo, máximo] en milisegundos.
const TEXT_DELAY_RANGE = [25000, 40000];   // webhook → texto al lead
const AUDIO_DELAY_RANGE = [50000, 60000];  // texto → audio al lead (los audios duran 30–40 s)
const NOTIFY_DELAY_RANGE = [5000, 15000];   // webhook → aviso al ejecutivo
// Tiempo que Evolution muestra "escribiendo..." / "grabando audio..." antes de cada envío
const TYPING_RANGE = [2500, 6000];
const RECORDING_RANGE = [4000, 8000];

function randomBetween([min, max]) {
  return Math.round(min + Math.random() * (max - min));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Instancia "Maestra": avisa por WhatsApp al ejecutivo asignado cuando llega un lead (el lead no lo ve).
// Si falta la instancia o el número del ejecutivo, el aviso se omite y queda registrado en el log.
const MAESTRA_INSTANCE = process.env.INSTANCE_MAESTRA || null;
const EXECUTIVE_PHONES = {
  gerardo: process.env.PHONE_GERARDO,
  josefina: process.env.PHONE_JOSEFINA,
  carolina: process.env.PHONE_CAROLINA
};
const SEGMENT_LABELS = {
  contado: '👍 Contado',
  financiamiento: '🙌 Financiamiento',
  sin_urgencia: '😊 Sin urgencia'
};
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'ZgMWAqw0bvt3n7ZSg9mf';

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
/**
 * Traduce los tags del contacto (GHL los manda como "tag1, tag2" o como arreglo) a un macro-segmento.
 * Devuelve { segment, matched }: matched = false cuando se usó el segmento por defecto.
 */
function getSegment(tags) {
  const tagList = !tags ? [] : (Array.isArray(tags) ? tags : String(tags).split(','))
    .map(t => String(t).trim().toLowerCase());
  const segment = SEGMENTS.find(s => tagList.includes(SEGMENT_TAGS[s]));
  if (segment) return { segment, matched: true };
  console.warn(`⚠️  Ningún tag de segmento en [${tagList.join(', ')}], uso "${DEFAULT_SEGMENT}"`);
  return { segment: DEFAULT_SEGMENT, matched: false };
}

/**
 * Arma la notificación interna para el ejecutivo (normal o con advertencia de segmento faltante)
 */
function buildExecutiveNotification({ projectDisplay, segment, matched, contactName, phoneNumber, tags, budgetAnswer, contactId }) {
  const link = contactId
    ? `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`
    : '(sin ID de contacto)';
  if (!matched) {
    return [
      `⚠️ Nuevo lead SIN SEGMENTO — ${projectDisplay} 🙌`,
      `👤 ${contactName} | 📱 +${phoneNumber}`,
      `🏷️ Tags recibidos: ${tags || 'ninguno'} (ninguno de segmento)`,
      `📨 Se le envió el mensaje y audio de Financiamiento (por defecto)`,
      `👉 Revisa sus respuestas en GHL y corrige el tag antes de llamar`,
      `🔗 ${link}`
    ].join('\n');
  }
  const emoji = SEGMENT_LABELS[segment].split(' ')[0];
  return [
    `🔔 Nuevo lead — ${projectDisplay} ${emoji}`,
    `👤 ${contactName} | 📱 +${phoneNumber}`,
    `🏷️ ${SEGMENT_LABELS[segment]}${budgetAnswer ? ` · pie: ${budgetAnswer}` : ''}`,
    `🔗 ${link}`
  ].join('\n');
}

/**
 * Envía la notificación al ejecutivo desde la instancia Maestra (nunca bloquea el flujo del lead)
 */
async function notifyExecutive(executiveName, text) {
  const executivePhone = formatPhoneNumber(EXECUTIVE_PHONES[executiveName]);
  if (!MAESTRA_INSTANCE || !executivePhone) {
    console.warn(`⚠️  Aviso al ejecutivo omitido (INSTANCE_MAESTRA: ${MAESTRA_INSTANCE ? 'ok' : 'falta'}, teléfono de ${executiveName}: ${executivePhone ? 'ok' : 'falta'})`);
    return;
  }
  try {
    await sleep(randomBetween(NOTIFY_DELAY_RANGE));
    await sendTextMessage(executivePhone, text, MAESTRA_INSTANCE);
    console.log(`🔔 Aviso enviado a ${executiveName} desde la Maestra`);
  } catch (err) {
    console.error(`❌ No se pudo avisar a ${executiveName}:`, err.message);
  }
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
  
  // Respaldo 2: el audio de financiamiento de Gerardo (el más neutro)
  const finalFallback = `${AUDIO_BASE_PATH}/gerardo/ogg/${DEFAULT_SEGMENT}.ogg`;
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
        text: message,
        delay: randomBetween(TYPING_RANGE) // muestra "escribiendo..." antes de enviar
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
    
    // Endpoint específico para notas de voz (PTT) — distinto de sendMedia
    const response = await axios.post(
      `${EVOLUTION_API_URL}/message/sendWhatsAppAudio/${instanceId}`,
      {
        number: phoneNumber,
        audio: base64Audio,
        delay: randomBetween(RECORDING_RANGE) // muestra "grabando audio..." antes de enviar
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        }
      }
    );
    
    console.log(`✅ Audio enviado a ${phoneNumber} (desde instancia ${instanceId})`);
    console.log('📋 Respuesta de Evolution API:', JSON.stringify(response.data));
    return response.data;
  } catch (err) {
    console.error(`❌ Error enviando audio a ${phoneNumber}:`, err.message);
    throw err;
  }
}

/**
 * Envía mensaje + audio con latencia
 */
async function sendMessageAndAudio(phoneNumber, leadName, message, audioPath, delay = randomBetween(AUDIO_DELAY_RANGE), instanceId = INSTANCE_ID, textDelay = 0) {
  try {
    if (textDelay > 0) {
      console.log(`⏱️  Esperando ${textDelay / 1000} segundos antes de enviar el texto...`);
      await sleep(textDelay);
    }

    // Enviar mensaje de texto
    const formattedMessage = message.replace('{nombre}', leadName);
    await sendTextMessage(phoneNumber, formattedMessage, instanceId);

    // Esperar antes del audio
    console.log(`⏱️  Esperando ${delay / 1000} segundos antes de enviar audio (${path.basename(audioPath)})...`);
    await sleep(delay);

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
      assignedTo
    } = payload;
    // GHL manda los tags del contacto en la raíz del body, no dentro de customData
    const tags = req.body.tags ?? payload.tags;
    
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
    
    // Determinar segmento según el tag que GHL puso al contacto
    // Solo aplica para Volkania por ahora; Tricalén usa el segmento por defecto y un texto genérico
    const { segment, matched } = projectName === 'volkania'
      ? getSegment(tags)
      : { segment: DEFAULT_SEGMENT, matched: true };
    const audioPath = getAudioPath(executiveName, segment);
    console.log(`💰 Segmento: ${segment} (tags: "${tags || 'N/A'}", pie: "${budgetAnswer || 'N/A'}") → audio ${audioPath}`);

    // Formatear mensaje según segmento
    const projectDisplay = projectName.charAt(0).toUpperCase() + projectName.slice(1);
    const message = projectName === 'volkania'
      ? SEGMENT_MESSAGES[segment]
      : `Hola {nombre}, gracias por tu interés en ${projectDisplay}. Te enviaremos más información en breve. ¿Tienes alguna pregunta?`;

    // Enviar mensaje + audio (async, no esperar respuesta)
    sendMessageAndAudio(
      phoneNumber,
      contactName,
      message,
      audioPath,
      randomBetween(AUDIO_DELAY_RANGE),
      instanceId,
      randomBetween(TEXT_DELAY_RANGE)
    ).catch(err => {
      console.error('Error en envío de mensaje/audio:', err.message);
    });

    // Aviso interno al ejecutivo desde la Maestra (en paralelo, no espera al lead)
    notifyExecutive(executiveName, buildExecutiveNotification({
      projectDisplay,
      segment,
      matched,
      contactName,
      phoneNumber,
      tags,
      budgetAnswer,
      contactId: req.body.contact_id || contactId
    }));
    
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
    const audioPath = getAudioPath(executiveName, SEGMENTS.includes(segment) ? segment : DEFAULT_SEGMENT);
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
