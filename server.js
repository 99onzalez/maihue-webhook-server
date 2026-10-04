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

// Instancia de Evolution API (WhatsApp) por ejecutivo — cada uno envía desde SU propio número.
// Nunca se envía desde el número de otro ejecutivo: si la instancia no está conectada, no se envía
// nada al lead (ver isInstanceOpen) y el ejecutivo lo contacta a mano con la notificación de GHL.
const EXECUTIVE_INSTANCES = {
  gerardo: process.env.INSTANCE_GERARDO || INSTANCE_ID,
  josefina: process.env.INSTANCE_JOSEFINA || 'Josefina',
  carolina: process.env.INSTANCE_CAROLINA || 'Carolina'
};
const EXECUTIVE_DISPLAY_NAMES = {
  gerardo: 'Gerardo',
  josefina: 'Josefina',
  carolina: 'Carolina'
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

// Campaña Cyber (5–7 oct 2026): un solo texto y un solo audio por ejecutivo, para ambos proyectos.
// GHL pone el tag de segmento (workflows "Cyber Oct26 - Volkania/Tricalén") y manda campaign = "cyber".
const CYBER_SEGMENT_TAGS = {
  contado: 'cyber-contado',
  financiamiento: 'cyber-financiamiento',
  sin_urgencia: 'cyber-sin-urgencia'
};
const CYBER_MESSAGE = 'Hola {nombre}, ¿cómo estás? Te escribe {ejecutivo}, del equipo de Maihue. Recibí tu registro en el Cyber de {proyecto} 🙂 Te acabo de dejar un audio con los detalles. ¿Qué día te acomoda visitar el proyecto? {emoji}';
const CYBER_AUDIO_FILE = 'cyber';
const PROJECT_DISPLAY_NAMES = {
  volkania: 'Volkania',
  tricalen: 'Tricalén'
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
// Token de GHL (Private Integration) para escribir el ejecutivo asignado en el contacto y la oportunidad
const GHL_PIT = process.env.GHL_PIT || null;
const GHL_API_URL = 'https://services.leadconnectorhq.com';

// Horario de trabajo (hora de Chile), permanente hasta nuevo aviso.
// Formato de WORK_SCHEDULE: "carolina=15:00-20:00;josefina=09:00-14:00". Quien no aparece no tiene turno.
// Fuera de todas las ventanas, o si quien está de turno no tiene su WhatsApp conectado, atiende Gerardo.
const SCHEDULE_TIMEZONE = 'America/Santiago';
const SCHEDULE_DEFAULT_EXECUTIVE = 'gerardo';
const WORK_SCHEDULE = parseSchedule(process.env.WORK_SCHEDULE ?? 'carolina=15:00-20:00');

function parseSchedule(text) {
  const toMinutes = hhmm => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  return String(text).split(';').map(s => s.trim()).filter(Boolean).flatMap(entry => {
    const match = entry.match(/^(\w+)\s*=\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!match) {
      console.warn(`⚠️  Entrada de horario ignorada: "${entry}"`);
      return [];
    }
    return [{ executive: match[1].toLowerCase(), start: toMinutes(match[2]), end: toMinutes(match[3]) }];
  });
}

/**
 * Minutos desde la medianoche en hora de Chile
 */
function chileMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHEDULE_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const get = type => Number(parts.find(p => p.type === type).value);
  return get('hour') * 60 + get('minute');
}

function executivesOnShift(date = new Date()) {
  const now = chileMinutes(date);
  return WORK_SCHEDULE.filter(w => now >= w.start && now < w.end).map(w => w.executive);
}

// Mapeo: ID de usuario "Assigned To" en GHL -> clave interna del ejecutivo
// Ve a Settings → My Staff → click en el usuario → revisa la URL para obtener el ID
const OWNER_ID_MAP = {
  'xfGUbyF37C0bBtsNGHgb': 'gerardo',
  'vGsKBT2O5dDRwH8OZOtj': 'josefina',
  'o38VaOWN6Cjzdsmd66JH': 'carolina'
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
function getSegment(tags, segmentTags = SEGMENT_TAGS) {
  const tagList = !tags ? [] : (Array.isArray(tags) ? tags : String(tags).split(','))
    .map(t => String(t).trim().toLowerCase());
  const segment = SEGMENTS.find(s => tagList.includes(segmentTags[s]));
  if (segment) return { segment, matched: true };
  console.warn(`⚠️  Ningún tag de segmento en [${tagList.join(', ')}], uso "${DEFAULT_SEGMENT}"`);
  return { segment: DEFAULT_SEGMENT, matched: false };
}

/**
 * Arma la notificación interna para el ejecutivo (normal o con advertencia de segmento faltante)
 */
function buildExecutiveNotification({ projectDisplay, segment, matched, contactName, phoneNumber, tags, budgetAnswer, contactId, sent = true }) {
  const link = contactId
    ? `https://app.gohighlevel.com/v2/location/${GHL_LOCATION_ID}/contacts/detail/${contactId}`
    : '(sin ID de contacto)';
  if (!sent) {
    return [
      `⚠️ Nuevo lead — ${projectDisplay} ${SEGMENT_LABELS[segment].split(' ')[0]}`,
      `👤 ${contactName} | 📱 +${phoneNumber}`,
      `🏷️ ${SEGMENT_LABELS[segment]}`,
      `📵 NO se le envió WhatsApp automático: tu número no está conectado. Escríbele a mano.`,
      `🔗 ${link}`
    ].join('\n');
  }
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
 * Elige al ejecutivo según el horario de trabajo. Si hay más de una persona de turno con su
 * WhatsApp conectado, se alternan (el último asignado queda en Redis).
 */
const SCHEDULE_ROTATION_KEY = 'schedule:round_robin:last';
let lastScheduledInMemory = null; // respaldo si Redis no responde

async function assignBySchedule(date = new Date()) {
  const onShift = executivesOnShift(date);
  const available = [];
  for (const executive of onShift) {
    if (await isInstanceOpen(getExecutiveInstance(executive))) available.push(executive);
  }
  if (available.length === 0) {
    if (onShift.length) console.warn(`⚠️  De turno: ${onShift.join(', ')}, pero sin WhatsApp conectado → ${SCHEDULE_DEFAULT_EXECUTIVE}`);
    return SCHEDULE_DEFAULT_EXECUTIVE;
  }
  if (available.length === 1) return available[0];

  let last = lastScheduledInMemory;
  try { last = (await withTimeout(redisClient.get(SCHEDULE_ROTATION_KEY))) || last; } catch (err) { /* usamos la memoria */ }
  const next = available[(available.indexOf(last) + 1) % available.length];
  lastScheduledInMemory = next;
  withTimeout(redisClient.set(SCHEDULE_ROTATION_KEY, next)).catch(() => { /* usamos la memoria */ });
  return next;
}

// Si Redis está caído, el cliente deja los comandos en cola indefinidamente; no esperamos más de 2 s.
function withTimeout(promise, ms = 2000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

/**
 * Segmento Cyber a partir de las respuestas del formulario. null si no llegó ninguna respuesta.
 */
function cyberSegmentFromAnswers(visita, pago) {
  if (!visita && !pago) return null;
  if (/noviembre/i.test(visita || '')) return 'sin_urgencia';
  if (/contado/i.test(pago || '')) return 'contado';
  return 'financiamiento';
}

function ghlHeaders() {
  return { Authorization: `Bearer ${GHL_PIT}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
}

/**
 * Agrega un tag al contacto en GHL (nunca bloquea el flujo del lead)
 */
async function addTagInGhl(contactId, tag) {
  if (!GHL_PIT || !contactId) {
    console.warn(`⚠️  No se agregó el tag ${tag} en GHL (GHL_PIT: ${GHL_PIT ? 'ok' : 'falta'}, contactId: ${contactId ? 'ok' : 'falta'})`);
    return;
  }
  try {
    await axios.post(`${GHL_API_URL}/contacts/${contactId}/tags`, { tags: [tag] }, { headers: ghlHeaders(), timeout: 10000 });
    console.log(`🏷️  GHL: tag ${tag} agregado al contacto`);
  } catch (err) {
    console.error(`❌ No se pudo agregar el tag ${tag} en GHL:`, err.response?.status || err.message);
  }
}

/**
 * Escribe en GHL el ejecutivo que eligió el servidor, en el contacto y en la oportunidad.
 * Al cambiar el asignado de la oportunidad, el workflow "Cyber - Aviso al asignado" notifica a esa persona.
 */
async function assignOwnerInGhl({ contactId, opportunityId, executiveName }) {
  const userId = Object.keys(OWNER_ID_MAP).find(id => OWNER_ID_MAP[id] === executiveName);
  if (!GHL_PIT || !userId) {
    console.warn(`⚠️  No se escribió el asignado en GHL (GHL_PIT: ${GHL_PIT ? 'ok' : 'falta'}, usuario de ${executiveName}: ${userId ? 'ok' : 'falta'})`);
    return;
  }
  const headers = ghlHeaders();
  const targets = [
    contactId && { kind: 'contacto', url: `${GHL_API_URL}/contacts/${contactId}` },
    opportunityId && { kind: 'oportunidad', url: `${GHL_API_URL}/opportunities/${opportunityId}` }
  ].filter(Boolean);
  if (!targets.length) console.warn('⚠️  Sin contactId ni opportunityId: no se pudo escribir el asignado en GHL');
  for (const { kind, url } of targets) {
    try {
      await axios.put(url, { assignedTo: userId }, { headers, timeout: 10000 });
      console.log(`👤 GHL: ${kind} asignado a ${executiveName}`);
    } catch (err) {
      console.error(`❌ No se pudo asignar el ${kind} en GHL:`, err.response?.status || err.message);
    }
  }
}

/**
 * Obtiene la instancia de Evolution API (WhatsApp) del ejecutivo asignado
 */
function getExecutiveInstance(executiveName) {
  return EXECUTIVE_INSTANCES[executiveName] || EXECUTIVE_INSTANCES.gerardo;
}

/**
 * Consulta a Evolution si la instancia está conectada a WhatsApp (state "open")
 */
async function isInstanceOpen(instanceId) {
  try {
    const response = await axios.get(
      `${EVOLUTION_API_URL}/instance/connectionState/${encodeURIComponent(instanceId)}`,
      { headers: { 'apikey': EVOLUTION_API_KEY }, timeout: 10000 }
    );
    const state = response.data?.instance?.state;
    if (state !== 'open') console.warn(`⚠️  Instancia ${instanceId} no conectada (estado: ${state || 'desconocido'})`);
    return state === 'open';
  } catch (err) {
    console.error(`❌ No se pudo consultar el estado de la instancia ${instanceId}:`, err.message);
    return false;
  }
}

/**
 * Audio Cyber del ejecutivo. Sin respaldo con la voz de otro: si falta, se envía solo el texto.
 */
function getCyberAudioPath(executiveName) {
  const audioPath = `${AUDIO_BASE_PATH}/${executiveName}/ogg/${CYBER_AUDIO_FILE}.ogg`;
  if (fs.existsSync(audioPath)) return audioPath;
  console.warn(`⚠️  No hay audio Cyber para ${executiveName} (${audioPath}); se enviará solo el texto`);
  return null;
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

    if (!audioPath) {
      return { success: true, message: 'Texto enviado (sin audio)', phoneNumber, leadName };
    }

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
      assignedTo,
      campaign,
      visita,
      pago,
      pie
    } = payload;
    const pieAnswer = budgetAnswer || pie;
    const isCyber = String(campaign || '').trim().toLowerCase() === 'cyber';
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
    
    // Asignar ejecutivo: si GHL ya trae un owner reconocible (asignación manual o prueba), se respeta;
    // si no, decide el horario de trabajo y el servidor lo escribe de vuelta en GHL.
    let executiveName = mapOwnerToExecutive(assignedTo);
    const ghlContactId = req.body.contact_id || contactId;

    if (executiveName) {
      console.log(`👤 Ejecutivo tomado del Owner asignado en GHL: ${executiveName}`);
    } else {
      executiveName = await assignBySchedule();
      console.log(`🕒 Asignado por horario: ${executiveName}`);
      assignOwnerInGhl({ contactId: ghlContactId, opportunityId, executiveName });
    }
    
    // El destinatario del mensaje es el LEAD, no el ejecutivo
    const phoneNumber = formatPhoneNumber(contactPhone);
    if (!phoneNumber) {
      console.error('❌ No se pudo formatear el número del lead:', contactPhone);
      return res.status(400).json({ error: 'Número de teléfono del lead inválido' });
    }
    
    // La instancia de WhatsApp desde la que se envía es la del ejecutivo asignado
    const instanceId = getExecutiveInstance(executiveName);
    
    const projectKey = String(projectName).trim().toLowerCase();
    const projectBase = PROJECT_DISPLAY_NAMES[projectKey] || (projectName.charAt(0).toUpperCase() + projectName.slice(1));
    const projectDisplay = isCyber ? `Cyber ${projectBase}` : projectBase;

    let segment, matched, audioPath, message;
    if (isCyber) {
      // Cyber: el segmento sale de las respuestas del formulario (visita/pago) y el servidor
      // pone el tag en GHL; si no llegan, se usan los tags cyber-* que traiga el contacto.
      const fromAnswers = cyberSegmentFromAnswers(visita, pago);
      if (fromAnswers) {
        segment = fromAnswers;
        matched = true;
        addTagInGhl(ghlContactId, CYBER_SEGMENT_TAGS[segment]);
      } else {
        ({ segment, matched } = getSegment(tags, CYBER_SEGMENT_TAGS));
      }
      audioPath = getCyberAudioPath(executiveName);
      message = CYBER_MESSAGE
        .replace('{ejecutivo}', EXECUTIVE_DISPLAY_NAMES[executiveName])
        .replace('{proyecto}', projectBase)
        .replace('{emoji}', SEGMENT_LABELS[segment].split(' ')[0]);
    } else {
      // Determinar segmento según el tag que GHL puso al contacto
      // Solo aplica para Volkania por ahora; Tricalén usa el segmento por defecto y un texto genérico
      ({ segment, matched } = projectKey === 'volkania'
        ? getSegment(tags)
        : { segment: DEFAULT_SEGMENT, matched: true });
      audioPath = getAudioPath(executiveName, segment);
      message = projectKey === 'volkania'
        ? SEGMENT_MESSAGES[segment]
        : `Hola {nombre}, gracias por tu interés en ${projectBase}. Te enviaremos más información en breve. ¿Tienes alguna pregunta?`;
    }
    console.log(`💰 Segmento: ${segment} (tags: "${tags || 'N/A'}", pie: "${pieAnswer || 'N/A'}") → audio ${audioPath || 'ninguno'}`);

    // Envío en segundo plano: primero se confirma que el WhatsApp del ejecutivo esté conectado.
    // Si no lo está, no se envía nada desde otro número; solo se avisa al ejecutivo.
    (async () => {
      const sent = await isInstanceOpen(instanceId);
      if (sent) {
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
      } else {
        console.warn(`📵 No se envía WhatsApp a ${contactName}: la instancia de ${executiveName} (${instanceId}) no está conectada`);
      }

      // Aviso interno al ejecutivo desde la Maestra (en paralelo, no espera al lead)
      notifyExecutive(executiveName, buildExecutiveNotification({
        projectDisplay,
        segment,
        matched,
        contactName,
        phoneNumber,
        tags,
        budgetAnswer: pieAnswer,
        contactId: ghlContactId,
        sent
      }));
    })();
    
    // Responder inmediatamente a GHL
    res.json({
      success: true,
      message: 'Webhook procesado correctamente',
      data: {
        contactName,
        projectName,
        segment,
        campaign: isCyber ? 'cyber' : 'regular',
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
 * Ver a quién se asignaría un lead ahora (o en ?at=2026-10-05T15:30:00-03:00), sin asignar ni enviar nada
 */
app.get('/debug/schedule', async (req, res) => {
  try {
    const date = req.query.at ? new Date(req.query.at) : new Date();
    if (isNaN(date)) return res.status(400).json({ error: 'Fecha inválida en ?at=' });
    const minutes = chileMinutes(date);
    res.json({
      chileTime: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
      schedule: WORK_SCHEDULE,
      onShift: executivesOnShift(date),
      wouldAssign: await assignBySchedule(date)
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
  console.log('  GET  /debug/schedule');
});
