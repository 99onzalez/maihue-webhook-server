require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const redis = require('redis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

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
// "central" es el WhatsApp de Maihue Central: último respaldo de la cadena (ver assignBySchedule).
const EXECUTIVE_INSTANCES = {
  gerardo: process.env.INSTANCE_GERARDO || INSTANCE_ID,
  josefina: process.env.INSTANCE_JOSEFINA || 'Josefina',
  carolina: process.env.INSTANCE_CAROLINA || 'Carolina',
  central: process.env.INSTANCE_CENTRAL || 'Central'
};
const EXECUTIVE_DISPLAY_NAMES = {
  gerardo: 'Gerardo',
  josefina: 'Josefina',
  carolina: 'Carolina',
  central: 'Central'
};
const CENTRAL_EXECUTIVE = 'central';

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
const CYBER_MESSAGE = 'Hola {nombre}, ¿Cómo estás? Te escribe {ejecutivo}, del equipo de Maihue. Recibí tu registro en el Cyber de {proyecto} {emoji}';
const CYBER_AUDIO_FILE = 'cyber';
// Desde Central sale solo texto (sin audio), firmado por el equipo de Maihue
const CENTRAL_CYBER_MESSAGE = 'Hola {nombre}, ¿cómo estás? Te escribimos del equipo de Maihue. Recibimos tu registro en el Cyber de {proyecto} 🙂 Te recordamos las condiciones: $1.000.000 de descuento en cualquier parcela, con cualquier medio de pago y acumulable con el precio al contado. Son solo 3 cupos en total entre Volkania y Tricalén, y para hacerlo válido debes agendar tu visita y comprar durante octubre (hasta el 31 de octubre). ¿Qué día te acomoda visitar el proyecto? {emoji}';
const CENTRAL_MESSAGE = 'Hola {nombre}, ¿cómo estás? Te escribimos del equipo de Maihue. Recibimos tu registro en {proyecto} 🙂 ¿Qué día te acomoda visitar el proyecto?';
const PROJECT_DISPLAY_NAMES = {
  volkania: 'Volkania',
  tricalen: 'Tricalén'
};
const PROJECT_EMOJIS = {
  volkania: '🌋',
  tricalen: '🌲'
};
// Respuesta de pie del formulario → texto corto para el aviso de la Maestra
const PIE_SHORT = [
  [/entre.*4.*6/i, '4-6M'],
  [/m[aá]s de.*6/i, '+6M']
];

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
  carolina: process.env.PHONE_CAROLINA,
  central: process.env.PHONE_CENTRAL
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
  'o38VaOWN6Cjzdsmd66JH': 'carolina',
  'HlToqIEm89vSAJHzah7M': 'central'
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
// "56912345678" → "+56 9 1234 5678" (solo para lectura rápida)
function formatPhoneForReading(phoneNumber) {
  const m = String(phoneNumber).match(/^56(9)(\d{4})(\d{4})$/);
  return m ? `+56 ${m[1]} ${m[2]} ${m[3]}` : `+${phoneNumber}`;
}

function shortPie(pie) {
  if (!pie) return null;
  const hit = PIE_SHORT.find(([re]) => re.test(pie));
  return hit ? hit[1] : pie;
}

function buildExecutiveNotification({ projectDisplay, projectEmoji, segment, matched, contactName, phoneNumber, tags, budgetAnswer, sent = true, answers = {} }) {
  const [segmentEmoji, ...labelWords] = SEGMENT_LABELS[segment].split(' ');
  const header = projectEmoji ? `${projectDisplay} ${projectEmoji}` : projectDisplay;
  const phone = formatPhoneForReading(phoneNumber);
  const pie = shortPie(budgetAnswer);
  const details = [
    `👤 ${contactName} | 📱 ${phone}`,
    `🏷️ ${labelWords.join(' ')} ${segmentEmoji}`,
    pie && `💰 capacidad de pago: ${pie}`,
    answers.visita && `📅 visita: ${answers.visita}`
  ];
  if (!sent) {
    return [
      `⚠️ Lead SIN CONTACTAR — ${header}`,
      ...details,
      `📵 NO se le envió WhatsApp automático: nadie estaba disponible (WhatsApp desconectado o marcado ausente). Escríbele a mano.`
    ].filter(Boolean).join('\n');
  }
  if (!matched) {
    return [
      `⚠️ Nuevo lead SIN SEGMENTO — ${header}`,
      `👤 ${contactName} | 📱 ${phone}`,
      `🏷️ Tags recibidos: ${tags || 'ninguno'} (ninguno de segmento)`,
      `📨 Se le envió el mensaje y audio de Financiamiento (por defecto)`,
      `👉 Revisa sus respuestas en GHL y corrige el tag antes de llamar`
    ].join('\n');
  }
  return [`🔔 Nuevo lead — ${header}`, ...details].filter(Boolean).join('\n');
}

/**
 * Envía la notificación al ejecutivo desde la instancia Maestra (nunca bloquea el flujo del lead)
 */
async function notifyExecutive(executiveName, text, contactCard = null) {
  const executivePhone = formatPhoneNumber(EXECUTIVE_PHONES[executiveName]);
  if (!MAESTRA_INSTANCE || !executivePhone) {
    console.warn(`⚠️  Aviso al ejecutivo omitido (INSTANCE_MAESTRA: ${MAESTRA_INSTANCE ? 'ok' : 'falta'}, teléfono de ${executiveName}: ${executivePhone ? 'ok' : 'falta'})`);
    return;
  }
  try {
    await sleep(randomBetween(NOTIFY_DELAY_RANGE));
    await sendTextMessage(executivePhone, text, MAESTRA_INSTANCE);
    console.log(`🔔 Aviso enviado a ${executiveName} desde la Maestra`);
    if (contactCard) await sendContactCard(executivePhone, contactCard, MAESTRA_INSTANCE);
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
 * Interruptor manual de disponibilidad (página /disponibilidad). La ausencia queda en Redis
 * (sobrevive a reinicios y deploys); "solo por hoy" expira sola a medianoche, hora de Chile.
 */
const ABSENCE_KEY_PREFIX = 'availability:absent:';
const absentInMemory = new Map(); // respaldo si Redis no responde: ejecutivo -> vence (ms) o null

function secondsUntilChileMidnight(date = new Date()) {
  return Math.max(60, (24 * 60 - chileMinutes(date)) * 60 - date.getSeconds());
}

// mode: "hoy" (hasta las 23:59), "indefinido" (hasta reactivar) o "disponible"
async function setAbsence(executive, mode) {
  const key = ABSENCE_KEY_PREFIX + executive;
  if (mode === 'disponible') {
    absentInMemory.delete(executive);
    await withTimeout(redisClient.del(key)).catch(() => { /* usamos la memoria */ });
    return;
  }
  const ttl = mode === 'hoy' ? secondsUntilChileMidnight() : null;
  absentInMemory.set(executive, ttl ? Date.now() + ttl * 1000 : null);
  await withTimeout(ttl ? redisClient.set(key, mode, { EX: ttl }) : redisClient.set(key, mode))
    .catch(() => { /* usamos la memoria */ });
}

// null si está disponible; "hoy" o "indefinido" si está marcado ausente
async function getAbsence(executive) {
  try {
    return await withTimeout(redisClient.get(ABSENCE_KEY_PREFIX + executive));
  } catch (err) {
    if (!absentInMemory.has(executive)) return null;
    const until = absentInMemory.get(executive);
    if (until && until < Date.now()) {
      absentInMemory.delete(executive);
      return null;
    }
    return until ? 'hoy' : 'indefinido';
  }
}

// Disponible = no marcado ausente y con su WhatsApp conectado
async function isAvailable(executive) {
  const absence = await getAbsence(executive);
  if (absence) {
    console.warn(`🔕 ${executive} está marcado ausente (${absence})`);
    return false;
  }
  return isInstanceOpen(getExecutiveInstance(executive));
}

/**
 * Cadena de asignación (permanente):
 *   1. Ejecutivas de turno disponibles (si hay varias, se alternan; el último queda en Redis)
 *   2. Gerardo, si está disponible
 *   3. Central (solo texto), si está disponible
 *   4. Nadie: no se envía WhatsApp; queda en Gerardo y la Maestra avisa a Gerardo y a Central
 * Devuelve { executive, sent }.
 */
const SCHEDULE_ROTATION_KEY = 'schedule:round_robin:last';
let lastScheduledInMemory = null; // respaldo si Redis no responde

async function assignBySchedule(date = new Date()) {
  const onShift = executivesOnShift(date);
  const available = [];
  for (const executive of onShift) {
    if (await isAvailable(executive)) available.push(executive);
  }
  if (available.length === 1) return { executive: available[0], sent: true };
  if (available.length > 1) {
    let last = lastScheduledInMemory;
    try { last = (await withTimeout(redisClient.get(SCHEDULE_ROTATION_KEY))) || last; } catch (err) { /* usamos la memoria */ }
    const next = available[(available.indexOf(last) + 1) % available.length];
    lastScheduledInMemory = next;
    withTimeout(redisClient.set(SCHEDULE_ROTATION_KEY, next)).catch(() => { /* usamos la memoria */ });
    return { executive: next, sent: true };
  }
  if (onShift.length) console.warn(`⚠️  De turno: ${onShift.join(', ')}, pero ninguna disponible → respaldo`);
  if (await isAvailable(SCHEDULE_DEFAULT_EXECUTIVE)) return { executive: SCHEDULE_DEFAULT_EXECUTIVE, sent: true };
  if (await isAvailable(CENTRAL_EXECUTIVE)) {
    console.warn(`⚠️  ${SCHEDULE_DEFAULT_EXECUTIVE} no disponible → Central`);
    return { executive: CENTRAL_EXECUTIVE, sent: true };
  }
  console.warn('📵 Nadie disponible (ni Central): el lead queda sin WhatsApp automático');
  return { executive: SCHEDULE_DEFAULT_EXECUTIVE, sent: false };
}

// Si Redis está caído, el cliente deja los comandos en cola indefinidamente; no esperamos más de 2 s.
function withTimeout(promise, ms = 2000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

/**
 * Segmento Cyber a partir de las respuestas del formulario. null si no llegó ninguna respuesta.
 */
// Respuestas de visita que significan "después de octubre" (el formulario dice, p. ej., "Al siguiente mes")
const CYBER_LATE_VISIT = /siguiente mes|pr[oó]ximo mes|noviembre|despu[eé]s|m[aá]s adelante/i;

function cyberSegmentFromAnswers(visita, pago) {
  if (!visita && !pago) return null;
  if (CYBER_LATE_VISIT.test(visita || '')) return 'sin_urgencia';
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
 * Deja un solo tag de segmento Cyber en el contacto: agrega el actual y quita los otros dos
 */
async function setCyberSegmentTag(contactId, segment) {
  await addTagInGhl(contactId, CYBER_SEGMENT_TAGS[segment]);
  const others = Object.entries(CYBER_SEGMENT_TAGS).filter(([s]) => s !== segment).map(([, tag]) => tag);
  if (!GHL_PIT || !contactId) return;
  try {
    await axios.delete(`${GHL_API_URL}/contacts/${contactId}/tags`, { headers: ghlHeaders(), data: { tags: others }, timeout: 10000 });
  } catch (err) {
    console.error('❌ No se pudieron quitar los otros tags de segmento en GHL:', err.response?.status || err.message);
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
 * Envía una tarjeta de contacto (vCard) para guardar al lead con "Guardar contacto"
 */
async function sendContactCard(phoneNumber, { fullName, contactPhone }, instanceId) {
  const response = await axios.post(
    `${EVOLUTION_API_URL}/message/sendContact/${instanceId}`,
    {
      number: phoneNumber,
      contact: [{ fullName, wuid: contactPhone, phoneNumber: `+${contactPhone}` }]
    },
    { headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY } }
  );
  console.log(`📇 Tarjeta de contacto enviada a ${phoneNumber} (desde instancia ${instanceId})`);
  return response.data;
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
      contactName: rawContactName,
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
    // GHL puede mandar el nombre con tabulaciones o espacios de más (p. ej. "	Gerardo")
    const contactName = String(rawContactName || '').trim();
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
    // Si ese owner no está disponible, se aplica la misma cadena de respaldo.
    let executiveName = mapOwnerToExecutive(assignedTo);
    let sent = true;
    const ghlContactId = req.body.contact_id || contactId;

    if (executiveName && await isAvailable(executiveName)) {
      console.log(`👤 Ejecutivo tomado del Owner asignado en GHL: ${executiveName}`);
    } else {
      if (executiveName) console.warn(`⚠️  Owner de GHL ${executiveName} no disponible → cadena de respaldo`);
      ({ executive: executiveName, sent } = await assignBySchedule());
      console.log(`🕒 Asignado por horario: ${executiveName}${sent ? '' : ' (sin envío automático)'}`);
      assignOwnerInGhl({ contactId: ghlContactId, opportunityId, executiveName });
    }
    const isCentral = executiveName === CENTRAL_EXECUTIVE;
    
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
    // Nombre de pila con mayúscula inicial (GHL a veces lo guarda en minúsculas)
    const firstWord = contactName.split(/\s+/)[0];
    const leadFirstName = firstWord.charAt(0).toUpperCase() + firstWord.slice(1);

    let segment, matched, audioPath, message;
    if (isCyber) {
      // Cyber: el segmento sale de las respuestas del formulario (visita/pago) y el servidor
      // pone el tag en GHL; si no llegan, se usan los tags cyber-* que traiga el contacto.
      const fromAnswers = cyberSegmentFromAnswers(visita, pago);
      if (fromAnswers) {
        segment = fromAnswers;
        matched = true;
        setCyberSegmentTag(ghlContactId, segment);
      } else {
        ({ segment, matched } = getSegment(tags, CYBER_SEGMENT_TAGS));
      }
      audioPath = isCentral ? null : getCyberAudioPath(executiveName);
      message = (isCentral ? CENTRAL_CYBER_MESSAGE : CYBER_MESSAGE)
        .replace('{nombre}', leadFirstName)
        .replace('{ejecutivo}', EXECUTIVE_DISPLAY_NAMES[executiveName])
        .replace('{proyecto}', projectBase)
        .replace('{emoji}', SEGMENT_LABELS[segment].split(' ')[0]);
    } else {
      // Determinar segmento según el tag que GHL puso al contacto
      // Solo aplica para Volkania por ahora; Tricalén usa el segmento por defecto y un texto genérico
      ({ segment, matched } = projectKey === 'volkania'
        ? getSegment(tags)
        : { segment: DEFAULT_SEGMENT, matched: true });
      audioPath = isCentral ? null : getAudioPath(executiveName, segment);
      if (isCentral) message = CENTRAL_MESSAGE.replace('{proyecto}', projectBase);
      else message = projectKey === 'volkania'
        ? SEGMENT_MESSAGES[segment]
        : `Hola {nombre}, gracias por tu interés en ${projectBase}. Te enviaremos más información en breve. ¿Tienes alguna pregunta?`;
    }
    console.log(`💰 Segmento: ${segment} (tags: "${tags || 'N/A'}", pie: "${pieAnswer || 'N/A'}") → audio ${audioPath || 'ninguno'}`);

    // Envío en segundo plano. La disponibilidad ya se revisó al asignar; si nadie estaba
    // disponible (sent = false), no se envía nada y la Maestra avisa a Gerardo y a Central.
    (async () => {
      if (sent) {
        sendMessageAndAudio(
          phoneNumber,
          contactName,
          message,
          audioPath,
          randomBetween(AUDIO_DELAY_RANGE),
          instanceId,
          randomBetween(TEXT_DELAY_RANGE)
        ).then(() => {
          // Confirmación al ejecutivo cuando el lead ya recibió todo
          const received = audioPath ? 'el mensaje y el audio' : 'el mensaje';
          notifyExecutive(executiveName, `⚡ A ${leadFirstName} ya le llegó ${received}, ¡vamos por ese cierre!`);
        }).catch(err => {
          console.error('Error en envío de mensaje/audio:', err.message);
        });
      } else {
        console.warn(`📵 No se envía WhatsApp a ${contactName}: nadie disponible`);
      }

      // Aviso interno desde la Maestra (en paralelo, no espera al lead)
      const notification = buildExecutiveNotification({
        projectDisplay,
        projectEmoji: PROJECT_EMOJIS[projectKey],
        segment,
        matched,
        contactName,
        phoneNumber,
        tags,
        budgetAnswer: pieAnswer,
        sent,
        answers: { visita, pago }
      });
      const recipients = sent ? [executiveName] : [SCHEDULE_DEFAULT_EXECUTIVE, CENTRAL_EXECUTIVE];
      // Tarjeta para guardar al lead en el teléfono, con el proyecto en el nombre
      const contactCard = { fullName: `${contactName} · ${projectDisplay}`, contactPhone: phoneNumber };
      recipients.forEach(r => notifyExecutive(r, notification, contactCard));
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
        autoMessage: sent,
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
 * Página de disponibilidad: marcar a alguien ausente (solo hoy / hasta reactivar) o disponible.
 * Se entra con la clave ADMIN_KEY (variable de Railway); queda guardada en una cookie del navegador.
 */
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const ADMIN_COOKIE = 'maihue_admin';
const ABSENCE_MODE_LABELS = { hoy: 'ausente solo por hoy (hasta las 23:59)', indefinido: 'ausente hasta que lo reactives', disponible: 'disponible' };

function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const cookie = (req.headers.cookie || '').split(';').map(c => c.trim())
    .find(c => c.startsWith(`${ADMIN_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.slice(ADMIN_COOKIE.length + 1)) : '';
  const a = Buffer.from(value);
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function adminPage(body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Disponibilidad Maihue</title><style>
body{font-family:system-ui,sans-serif;background:#f5f5f4;color:#1c1917;margin:0;padding:16px;max-width:560px;margin-inline:auto}
h1{font-size:1.3rem;margin:0 0 4px}.sub{color:#78716c;margin:0 0 16px;font-size:.9rem}
.card{background:#fff;border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px #0001}
.name{font-weight:700;font-size:1.05rem}.state{font-size:.9rem;margin:4px 0 10px;color:#44403c}
form{display:inline}button{border:0;border-radius:8px;padding:9px 12px;margin:3px 4px 0 0;font-size:.9rem;cursor:pointer}
.off{background:#fee2e2;color:#991b1b}.on{background:#dcfce7;color:#166534}.key{background:#F15A24;color:#fff}
input{padding:10px;border:1px solid #d6d3d1;border-radius:8px;font-size:1rem;width:100%;box-sizing:border-box;margin-bottom:8px}
</style></head><body>${body}</body></html>`;
}

app.get('/disponibilidad', async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).send(adminPage('<h1>Página desactivada</h1><p class="sub">Falta la variable ADMIN_KEY en Railway.</p>'));
  if (!isAdmin(req)) {
    return res.send(adminPage(`<h1>Disponibilidad Maihue</h1><p class="sub">Ingresa la clave de administración.</p>
<div class="card"><form method="post" action="/disponibilidad/login"><input type="password" name="key" autocomplete="current-password" required>
<button class="key" type="submit">Entrar</button></form></div>`));
  }
  const minutes = chileMinutes();
  const onShift = executivesOnShift();
  const rows = await Promise.all(Object.keys(EXECUTIVE_INSTANCES).map(async executive => {
    const [absence, open] = await Promise.all([getAbsence(executive), isInstanceOpen(getExecutiveInstance(executive))]);
    const shift = WORK_SCHEDULE.find(w => w.executive === executive);
    const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const shiftText = shift ? `turno ${fmt(shift.start)}–${fmt(shift.end)}${onShift.includes(executive) ? ' · de turno ahora' : ''}`
      : executive === CENTRAL_EXECUTIVE ? 'último respaldo' : 'fuera de los turnos de las ejecutivas';
    const icon = absence ? '🔕' : open ? '🟢' : '🔴';
    const stateText = absence ? ABSENCE_MODE_LABELS[absence] : open ? 'WhatsApp conectado' : 'WhatsApp desconectado';
    const button = (mode, label, cls) => `<form method="post" action="/disponibilidad"><input type="hidden" name="executive" value="${executive}">
<input type="hidden" name="mode" value="${mode}"><button class="${cls}" type="submit">${label}</button></form>`;
    const actions = absence
      ? button('disponible', 'Marcar disponible', 'on')
      : button('hoy', 'Ausente solo hoy', 'off') + button('indefinido', 'Ausente hasta reactivar', 'off');
    return `<div class="card"><div class="name">${icon} ${escapeHtml(EXECUTIVE_DISPLAY_NAMES[executive])}</div>
<div class="state">${escapeHtml(stateText)} · ${escapeHtml(shiftText)}</div>${actions}</div>`;
  }));
  res.send(adminPage(`<h1>Disponibilidad Maihue</h1><p class="sub">Hora de Chile: ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} · <a href="/disponibilidad">actualizar</a></p>${rows.join('')}`));
});

app.post('/disponibilidad/login', (req, res) => {
  const key = String(req.body.key || '');
  const ok = ADMIN_KEY && key.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
  if (!ok) return res.status(401).send(adminPage('<h1>Clave incorrecta</h1><p class="sub"><a href="/disponibilidad">Volver</a></p>'));
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${encodeURIComponent(key)}; Path=/disponibilidad; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 24 * 180}`);
  res.redirect(303, '/disponibilidad');
});

app.post('/disponibilidad', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).send(adminPage('<h1>Sin acceso</h1><p class="sub"><a href="/disponibilidad">Entrar</a></p>'));
  const { executive, mode } = req.body;
  if (!EXECUTIVE_INSTANCES[executive] || !ABSENCE_MODE_LABELS[mode]) return res.status(400).send(adminPage('<h1>Datos inválidos</h1>'));
  await setAbsence(executive, mode);
  console.log(`🔕 Disponibilidad: ${executive} → ${mode}`);
  const icon = mode === 'disponible' ? '🟢' : '🔕';
  notifyExecutive(SCHEDULE_DEFAULT_EXECUTIVE, `${icon} ${EXECUTIVE_DISPLAY_NAMES[executive]} quedó ${ABSENCE_MODE_LABELS[mode]}`);
  res.redirect(303, '/disponibilidad');
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
      absent: Object.fromEntries(await Promise.all(
        Object.keys(EXECUTIVE_INSTANCES).map(async e => [e, await getAbsence(e)])
      )),
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
  console.log('  GET  /disponibilidad');
});
