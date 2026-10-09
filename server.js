require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const redis = require('redis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const users = require('./users');

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

// Los ejecutivos (instancia de WhatsApp, teléfono, usuario de GHL, horario, mensajes y audios)
// se administran desde el panel /disponibilidad y viven en users.js. Estos son solo los datos
// iniciales que se guardan la primera vez. "central" es el último respaldo (ver assignBySchedule).
const CENTRAL_EXECUTIVE = users.CENTRAL_EXECUTIVE;

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
const CYBER_CAMPAIGN_LABEL = 'Cyber Oct26';
// Desde Central sale solo texto (sin audio), firmado por el equipo de Maihue
const CENTRAL_CYBER_MESSAGE = 'Hola {nombre}, ¿cómo estás? Te escribimos del equipo de Maihue. Recibimos tu registro en el Cyber de {proyecto} 🙂 Te recordamos las condiciones: $1.000.000 de descuento en cualquier parcela, con cualquier medio de pago y acumulable con el precio al contado. Son solo 3 cupos en total entre Volkania y Tricalén, y para hacerlo válido debes agendar tu visita y comprar durante octubre (hasta el 31 de octubre). ¿Qué día te acomoda visitar el proyecto? {emoji}';
const CENTRAL_MESSAGE = 'Hola {nombre}, ¿cómo estás? Te escribimos del equipo de Maihue. Recibimos tu registro en {proyecto} 🙂 ¿Qué día te acomoda visitar el proyecto?';
// Proyectos sin mensajes por segmento (hoy Tricalén fuera del Cyber)
const GENERAL_MESSAGE = 'Hola {nombre}, gracias por tu interés en {proyecto}. Te enviaremos más información en breve. ¿Tienes alguna pregunta?';
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
// Dirección pública del panel (va en los avisos de desconexión)
const PANEL_URL = `${process.env.PUBLIC_URL || 'https://maihue-webhook-server-production.up.railway.app'}/disponibilidad`;
const SEGMENT_LABELS = {
  contado: '👍 Contado',
  financiamiento: '🙌 Financiamiento',
  sin_urgencia: '😊 Sin urgencia'
};
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'ZgMWAqw0bvt3n7ZSg9mf';
// Token de GHL (Private Integration) para escribir el ejecutivo asignado en el contacto y la oportunidad
const GHL_PIT = process.env.GHL_PIT || null;
const GHL_API_URL = 'https://services.leadconnectorhq.com';

// Horario de trabajo (hora de Chile). Se edita desde el panel; WORK_SCHEDULE
// ("carolina=15:00-20:00;josefina=17:00-21:00") solo se usa para los datos iniciales.
// Fuera de todas las ventanas, o si quien está de turno no está disponible, atiende Gerardo.
const SCHEDULE_TIMEZONE = 'America/Santiago';
const SCHEDULE_DEFAULT_EXECUTIVE = users.DEFAULT_EXECUTIVE;
const INITIAL_SCHEDULE = parseSchedule(process.env.WORK_SCHEDULE ?? 'carolina=15:00-20:00');

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

// Gerardo y Central no tienen turno propio: Gerardo cubre fuera de turnos y Central es el último respaldo
function executivesOnShift(date = new Date()) {
  const now = chileMinutes(date);
  return users.list()
    .filter(u => u.schedule && ![SCHEDULE_DEFAULT_EXECUTIVE, CENTRAL_EXECUTIVE].includes(u.username))
    .filter(u => now >= u.schedule.start && now < u.schedule.end)
    .map(u => u.username);
}

// Datos iniciales de los ejecutivos (se guardan en Redis la primera vez; después manda el panel).
// ghlUserId: Settings → My Staff → click en el usuario → el ID está en la URL.
const initialSchedule = executive => {
  const w = INITIAL_SCHEDULE.find(s => s.executive === executive);
  return w ? { start: w.start, end: w.end } : null;
};
const SEED_USERS = [
  { username: 'gerardo', displayName: 'Gerardo', role: 'admin', instance: process.env.INSTANCE_GERARDO || INSTANCE_ID,
    phone: process.env.PHONE_GERARDO, ghlUserId: 'xfGUbyF37C0bBtsNGHgb' },
  { username: 'josefina', displayName: 'Josefina', role: 'ejecutivo', instance: process.env.INSTANCE_JOSEFINA || 'Josefina',
    phone: process.env.PHONE_JOSEFINA, ghlUserId: 'vGsKBT2O5dDRwH8OZOtj', schedule: initialSchedule('josefina') },
  { username: 'carolina', displayName: 'Carolina', role: 'ejecutivo', instance: process.env.INSTANCE_CAROLINA || 'Carolina',
    phone: process.env.PHONE_CAROLINA, ghlUserId: 'o38VaOWN6Cjzdsmd66JH', schedule: initialSchedule('carolina') },
  { username: 'central', displayName: 'Central', role: 'admin', instance: process.env.INSTANCE_CENTRAL || 'Central',
    phone: process.env.PHONE_CENTRAL, ghlUserId: 'HlToqIEm89vSAJHzah7M' }
];

/**
 * Traduce el ID del "Assigned To" de GHL a nuestra clave interna de ejecutivo
 */
function mapOwnerToExecutive(assignedToId) {
  return users.byGhlUserId(assignedToId);
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

// "albert cayumán" → "Albert Cayumán" (no toca lo que ya viene con mayúsculas)
function capitalizeWords(text) {
  return text.split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_PROBLEM_TAG = 'telefono-invalido';
const PHONE_PROBLEM_LABELS = {
  formato: 'El número está incompleto, mal escrito o es de red fija',
  sin_whatsapp: 'El número no tiene WhatsApp'
};

/**
 * Revisa el teléfono del lead: formato (móvil chileno 569 + 8 dígitos, o internacional de 8 a 15 dígitos)
 * y, si el formato está bien, si el número tiene WhatsApp (Evolution). Devuelve null si está bien,
 * "formato" o "sin_whatsapp". Si Evolution no responde, se da por bueno para no frenar el lead.
 */
async function checkLeadPhone(phoneNumber, instanceId) {
  if (!phoneNumber || !/^\d{8,15}$/.test(phoneNumber) || (phoneNumber.startsWith('56') && !/^569\d{8}$/.test(phoneNumber))) return 'formato';
  if (!instanceId) return null;
  try {
    const { data } = await axios.post(`${EVOLUTION_API_URL}/chat/whatsappNumbers/${encodeURIComponent(instanceId)}`,
      { numbers: [phoneNumber] }, { headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 });
    const entry = Array.isArray(data) ? data[0] : null;
    if (entry && entry.exists === false) return 'sin_whatsapp';
  } catch (err) {
    console.warn('⚠️  No se pudo verificar si el número tiene WhatsApp (se envía igual):', err.message);
  }
  return null;
}

function shortPie(pie) {
  if (!pie) return null;
  const hit = PIE_SHORT.find(([re]) => re.test(pie));
  return hit ? hit[1] : pie;
}

function buildExecutiveNotification({ projectDisplay, projectEmoji, segment, matched, contactName, phoneNumber, tags, budgetAnswer, sent = true, answers = {}, derivedNote = null, phoneProblem = null, rawPhone = '', email = '' }) {
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
  if (phoneProblem) {
    const emailLine = !email ? '✉️ No dejó correo'
      : `✉️ ${email}${EMAIL_PATTERN.test(email) ? '' : ' (el correo también parece mal escrito)'}`;
    return [
      `📵 Lead con teléfono inválido — ${header}`,
      `👤 ${contactName} | 📱 escribió: ${rawPhone || '(nada)'}`,
      emailLine,
      ...details.slice(1),
      `⚠️ ${PHONE_PROBLEM_LABELS[phoneProblem]}: no se le envió WhatsApp. Escríbele al correo o búscalo en GHL.`
    ].filter(Boolean).join('\n');
  }
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
  return [`🔔 Nuevo lead — ${header}`, ...details, derivedNote].filter(Boolean).join('\n');
}

/**
 * Envía la notificación al ejecutivo desde la instancia Maestra (nunca bloquea el flujo del lead).
 * fromInstance permite avisar desde otra instancia cuando la caída es de la propia Maestra.
 */
async function notifyExecutive(executiveName, text, contactCard = null, { immediate = false, fromInstance = MAESTRA_INSTANCE } = {}) {
  const executivePhone = formatPhoneNumber(users.get(executiveName)?.phone);
  if (!fromInstance || !executivePhone) {
    console.warn(`⚠️  Aviso al ejecutivo omitido (instancia de aviso: ${fromInstance ? 'ok' : 'falta'}, teléfono de ${executiveName}: ${executivePhone ? 'ok' : 'falta'})`);
    return;
  }
  try {
    if (!immediate) await sleep(randomBetween(NOTIFY_DELAY_RANGE));
    await sendTextMessage(executivePhone, text, fromInstance);
    console.log(`🔔 Aviso enviado a ${executiveName} desde ${fromInstance === MAESTRA_INSTANCE ? 'la Maestra' : fromInstance}`);
    if (contactCard) await sendContactCard(executivePhone, contactCard, fromInstance);
  } catch (err) {
    console.error(`❌ No se pudo avisar a ${executiveName}:`, err.message);
  }
}

/**
 * Audio del ejecutivo para un segmento (o "cyber"), en base64. Primero el subido desde el panel,
 * luego el del repositorio (audios/{ejecutivo}/ogg/{slot}.ogg). Nunca se usa la voz de otra persona:
 * si el ejecutivo no tiene audio, se envía solo el texto.
 */
async function getAudio(executiveName, slot) {
  const uploaded = await users.getAudio(executiveName, slot);
  if (uploaded) return { base64: uploaded, label: `${slot} (panel)` };
  const file = `${AUDIO_BASE_PATH}/${executiveName}/ogg/${slot}.ogg`;
  if (fs.existsSync(file)) return { base64: fs.readFileSync(file).toString('base64'), label: `${slot} (${path.basename(file)})` };
  console.warn(`⚠️  ${executiveName} no tiene audio "${slot}": se enviará solo el texto`);
  return null;
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

users.init({
  client: redisClient,
  timeout: withTimeout,
  seedUsers: SEED_USERS,
  messages: {
    normal: { cyber: CYBER_MESSAGE, ...SEGMENT_MESSAGES, general: GENERAL_MESSAGE },
    central: { cyber: CENTRAL_CYBER_MESSAGE, general: CENTRAL_MESSAGE }
  }
});

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('Error al conectar Redis:', err);
  }
  await users.load();
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

// mode: "hoy" (hasta las 23:59), "hasta" (vuelve sola en la fecha `until`, ms), "indefinido" (hasta reactivar)
// o "disponible". En Redis queda "hoy", "indefinido" o "hasta:<ms>", con vencimiento cuando corresponde.
async function setAbsence(executive, mode, until = null) {
  const key = ABSENCE_KEY_PREFIX + executive;
  if (mode === 'disponible') {
    absentInMemory.delete(executive);
    await withTimeout(redisClient.del(key)).catch(() => { /* usamos la memoria */ });
    return;
  }
  const ttl = mode === 'hoy' ? secondsUntilChileMidnight()
    : mode === 'hasta' ? Math.max(60, Math.round((until - Date.now()) / 1000)) : null;
  const value = mode === 'hasta' ? `hasta:${until}` : mode;
  absentInMemory.set(executive, { value, expires: ttl ? Date.now() + ttl * 1000 : null });
  await withTimeout(ttl ? redisClient.set(key, value, { EX: ttl }) : redisClient.set(key, value))
    .catch(() => { /* usamos la memoria */ });
}

// null si está disponible; si no, { mode: "hoy" | "hasta" | "indefinido", until }
async function getAbsence(executive) {
  let value;
  try {
    value = await withTimeout(redisClient.get(ABSENCE_KEY_PREFIX + executive));
  } catch (err) {
    const entry = absentInMemory.get(executive);
    if (entry?.expires && entry.expires < Date.now()) absentInMemory.delete(executive);
    value = absentInMemory.get(executive)?.value || null;
  }
  if (!value) return null;
  if (value.startsWith('hasta:')) return { mode: 'hasta', until: Number(value.slice(6)) };
  return { mode: value, until: null };
}

// Disponible = no marcado ausente y con su WhatsApp conectado. Devuelve el motivo si no lo está.
async function unavailableReason(executive) {
  const absence = await getAbsence(executive);
  if (absence) {
    console.warn(`🔕 ${executive} está marcado ausente (${absence.mode})`);
    return 'ausente';
  }
  return (await isInstanceOpen(getExecutiveInstance(executive))) ? null : 'desconectado';
}

async function isAvailable(executive) {
  return !(await unavailableReason(executive));
}

/**
 * Cadena de asignación (permanente):
 *   1. Ejecutivas de turno disponibles (si hay varias, se alternan; el último queda en Redis)
 *   2. Gerardo, si está disponible
 *   3. Central (solo texto), si está disponible
 *   4. Nadie: no se envía WhatsApp; queda en Gerardo y la Maestra avisa a Gerardo y a Central
 * Devuelve { executive, sent, skipped }: skipped son a quienes les tocaba y no estaban disponibles,
 * con el motivo ("desconectado" o "ausente"), para avisar que el lead se derivó.
 */
const SCHEDULE_ROTATION_KEY = 'schedule:round_robin:last';
let lastScheduledInMemory = null; // respaldo si Redis no responde

async function assignBySchedule(date = new Date(), skipped = []) {
  const onShift = executivesOnShift(date);
  if (onShift.length) {
    // Turno rotativo entre todas las de turno; si a quien le toca no está disponible, se pasa a la
    // siguiente y la rotación avanza igual (así solo se marcan como derivados los leads que eran suyos).
    let last = lastScheduledInMemory;
    try { last = (await withTimeout(redisClient.get(SCHEDULE_ROTATION_KEY))) || last; } catch (err) { /* usamos la memoria */ }
    const start = (onShift.indexOf(last) + 1) % onShift.length;
    const order = onShift.map((_, i) => onShift[(start + i) % onShift.length]);
    let chosen = null;
    for (const executive of order) {
      const reason = await unavailableReason(executive);
      if (!reason) { chosen = executive; break; }
      skipped.push({ executive, reason });
    }
    if (chosen) {
      // Si se saltó a alguien, la rotación queda en esa persona (ese lead era suyo)
      const rotation = skipped.find(s => onShift.includes(s.executive))?.executive || chosen;
      lastScheduledInMemory = rotation;
      withTimeout(redisClient.set(SCHEDULE_ROTATION_KEY, rotation)).catch(() => { /* usamos la memoria */ });
      return { executive: chosen, sent: true, skipped };
    }
    console.warn(`⚠️  De turno: ${onShift.join(', ')}, pero ninguna disponible → respaldo`);
  }
  if (!skipped.some(s => s.executive === SCHEDULE_DEFAULT_EXECUTIVE)) {
    const reason = await unavailableReason(SCHEDULE_DEFAULT_EXECUTIVE);
    if (!reason) return { executive: SCHEDULE_DEFAULT_EXECUTIVE, sent: true, skipped };
    skipped.push({ executive: SCHEDULE_DEFAULT_EXECUTIVE, reason });
  }
  if (!skipped.some(s => s.executive === CENTRAL_EXECUTIVE) && await isAvailable(CENTRAL_EXECUTIVE)) {
    console.warn(`⚠️  ${SCHEDULE_DEFAULT_EXECUTIVE} no disponible → Central`);
    return { executive: CENTRAL_EXECUTIVE, sent: true, skipped };
  }
  console.warn('📵 Nadie disponible (ni Central): el lead queda sin WhatsApp automático');
  return { executive: SCHEDULE_DEFAULT_EXECUTIVE, sent: false, skipped };
}

// "Carolina tiene su WhatsApp desconectado y Josefina está ausente"
function skippedReasonText(skipped) {
  const parts = skipped.map(({ executive, reason }) =>
    `${users.displayName(executive)} ${reason === 'ausente' ? 'está ausente' : 'tiene su WhatsApp desconectado'}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}` : parts[0];
}

/**
 * Avisos de lead derivado. Quien lo recibe ve por qué le llegó. Si el motivo es un WhatsApp
 * desconectado, la Maestra avisa también a esa persona y a Gerardo; si solo estaba ausente, no.
 * Devuelve la línea para el aviso de quien recibe el lead.
 */
function derivationNotices({ skipped, executiveName, contactName, projectDisplay }) {
  if (!skipped.length) return null;
  const disconnected = skipped.filter(s => s.reason === 'desconectado').map(s => s.executive);
  const warned = [...new Set([...disconnected, ...(disconnected.length ? [SCHEDULE_DEFAULT_EXECUTIVE] : [])])]
    .filter(e => e !== executiveName);
  for (const executive of disconnected) {
    if (executive === executiveName) continue;
    notifyExecutive(executive, `↪️ Un lead tuyo (${contactName} · ${projectDisplay}) se derivó a ${users.displayName(executiveName)} porque tu WhatsApp está desconectado.\n🔌 Reconéctalo desde el panel: ${PANEL_URL}`);
  }
  if (warned.includes(SCHEDULE_DEFAULT_EXECUTIVE) && !disconnected.includes(SCHEDULE_DEFAULT_EXECUTIVE)) {
    const owners = disconnected.map(users.displayName).join(' y ');
    notifyExecutive(SCHEDULE_DEFAULT_EXECUTIVE, `↪️ Lead de ${owners} (${contactName} · ${projectDisplay}) derivado a ${users.displayName(executiveName)}: ${skippedReasonText(skipped.filter(s => s.reason === 'desconectado'))}.`);
  }
  const told = warned.length ? ` Ya ${warned.length === 1 ? 'le' : 'les'} avisamos a ${warned.map(users.displayName).join(' y a ')}.` : '';
  return `↪️ Entró a tu canal porque ${skippedReasonText(skipped)}.${told}`;
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
 * Base de clientes: escribe en el contacto de GHL los campos fijos (sirven para cualquier campaña)
 * y al final agrega el tag "base-clientes", que dispara el workflow que agrega la fila en la planilla.
 * Los campos se buscan por nombre; si falta alguno en GHL, se omite y queda en el log.
 */
const CLIENT_BASE_TAG = 'base-clientes';
const CLIENT_BASE_FIELDS = {
  proyecto: 'Proyecto',
  segmento: 'Segmento',
  campana: 'Campaña',
  capacidad: 'Capacidad de pago',
  visita: 'Visita',
  fechaMarketing: 'Fecha aceptación marketing'
};
let customFieldIds = null; // nombre → id, se carga una vez

async function getCustomFieldIds() {
  if (customFieldIds) return customFieldIds;
  const { data } = await axios.get(`${GHL_API_URL}/locations/${GHL_LOCATION_ID}/customFields`, { headers: ghlHeaders(), timeout: 10000 });
  customFieldIds = Object.fromEntries((data.customFields || []).map(f => [f.name, f.id]));
  return customFieldIds;
}

// El tag va al final, cuando el responsable ya quedó escrito, para que la fila salga completa
async function syncClientBase(contactId, values, ownerWritten = Promise.resolve()) {
  if (!GHL_PIT || !contactId) {
    console.warn(`⚠️  Base de clientes omitida (GHL_PIT: ${GHL_PIT ? 'ok' : 'falta'}, contactId: ${contactId ? 'ok' : 'falta'})`);
    return;
  }
  try {
    const ids = await getCustomFieldIds();
    const accepted = isMarketingAccepted(values.marketing);
    const all = { ...values, fechaMarketing: accepted ? new Date().toLocaleDateString('es-CL', { timeZone: SCHEDULE_TIMEZONE }) : null };
    const missing = [];
    const customFields = Object.entries(CLIENT_BASE_FIELDS).flatMap(([key, name]) => {
      if (!all[key]) return [];
      if (!ids[name]) { missing.push(name); return []; }
      return [{ id: ids[name], field_value: String(all[key]) }];
    });
    if (missing.length) console.warn(`⚠️  Campos de la base de clientes que no existen en GHL: ${missing.join(', ')}`);
    if (customFields.length) await axios.put(`${GHL_API_URL}/contacts/${contactId}`, { customFields }, { headers: ghlHeaders(), timeout: 10000 });
    await ownerWritten;
    await addTagInGhl(contactId, CLIENT_BASE_TAG);
    console.log(`📒 Base de clientes: ${customFields.length} campos escritos en GHL`);
  } catch (err) {
    console.error('❌ No se pudo escribir la base de clientes en GHL:', err.response?.status || err.message);
  }
}

/**
 * Planilla "Base de Clientes Maihue": el servidor envía cada lead a un Apps Script publicado en la
 * planilla (gratis, sin la acción premium de GHL). El script ubica cada valor por el nombre del
 * encabezado, así que agregar o mover columnas solo requiere ajustar estas claves.
 */
const CLIENT_SHEET_URL = process.env.CLIENT_SHEET_URL || null;
const CLIENT_SHEET_SECRET = process.env.CLIENT_SHEET_SECRET || null;

function isMarketingAccepted(answer) {
  return /^(s[ií]|yes|true|1|acepto)/i.test(String(answer || '').trim());
}

// Método de pago estándar, sin importar cómo lo pregunte cada formulario ("Al contado" → "Contado")
const PAYMENT_METHODS = [
  [/contado/i, 'Contado'],
  [/cr[eé]dito|hipotec|banco|financ/i, 'Crédito'],
  [/cuota|directo|plazo/i, 'Cuotas directas']
];
function standardPaymentMethod(answer) {
  if (!answer) return '';
  const hit = PAYMENT_METHODS.find(([re]) => re.test(answer));
  return hit ? hit[1] : String(answer).trim();
}

/**
 * Todas las respuestas del formulario como texto ("Pregunta: respuesta | ..."), tomadas de los campos
 * personalizados que GHL manda en la raíz del webhook. Se omiten los campos que llena el propio servidor.
 */
async function formAnswersText(body) {
  if (!GHL_PIT) return '';
  try {
    const own = new Set(Object.values(CLIENT_BASE_FIELDS));
    return Object.keys(await getCustomFieldIds())
      .filter(name => !own.has(name) && body[name] !== undefined && String(body[name]).trim())
      .map(name => `${name}: ${String(body[name]).trim()}`)
      .join(' | ');
  } catch (err) {
    console.warn('⚠️  No se pudieron leer las respuestas del formulario:', err.message);
    return '';
  }
}

async function appendClientRow(lead) {
  if (!CLIENT_SHEET_URL || !CLIENT_SHEET_SECRET) {
    console.warn('⚠️  Planilla de clientes omitida (faltan CLIENT_SHEET_URL o CLIENT_SHEET_SECRET)');
    return;
  }
  const today = new Date().toLocaleDateString('es-CL', { timeZone: SCHEDULE_TIMEZONE });
  const accepted = isMarketingAccepted(lead.marketing);
  const fila = {
    'Fecha de ingreso': today,
    'Nombre': lead.nombre,
    'Teléfono': lead.telefono,
    'Correo': lead.correo || '',
    'Proyecto': lead.proyecto,
    'Campaña': lead.campana,
    'Segmento': lead.segmento,
    'Método de pago': standardPaymentMethod(lead.pago),
    'Capacidad de pago': lead.capacidad || '',
    'Visita': lead.visita || '',
    'Responsable': lead.responsable,
    'Acepta marketing': lead.marketing ? (accepted ? 'Sí' : 'No') : '',
    'Fecha de aceptación': accepted ? today : '',
    'ID contacto GHL': lead.contactId || '',
    'Formulario': lead.formulario || '',
    'Anuncio': lead.anuncio || '',
    'Estado': 'Nuevo',
    'Notas': lead.notas || '',
    'Respuestas del formulario': lead.rawBody ? await formAnswersText(lead.rawBody) : ''
  };
  // Sheets toma como fórmula todo lo que empieza con + = - @ (p. ej. "+6M" → #ERROR!): se fuerza como texto.
  // Teléfono e ID ya los deja como texto el script de la planilla.
  for (const [header, value] of Object.entries(fila)) {
    if (!['Teléfono', 'ID contacto GHL'].includes(header) && /^[+=\-@]/.test(String(value))) fila[header] = `'${value}`;
  }
  try {
    const { data } = await axios.post(CLIENT_SHEET_URL, { secret: CLIENT_SHEET_SECRET, fila }, { timeout: 30000, maxRedirects: 5 });
    if (data?.ok) console.log(`📗 Planilla de clientes: ${data.duplicate ? 'ya estaba registrado' : 'fila agregada'}`);
    else console.error('❌ La planilla de clientes rechazó la fila:', data?.error || 'respuesta inesperada');
  } catch (err) {
    console.error('❌ No se pudo escribir en la planilla de clientes:', err.response?.status || err.message);
  }
}

/**
 * Reemplaza {nombre}, {ejecutivo}, {proyecto} y {emoji} en un mensaje
 */
function fillMessage(template, values) {
  return template.replace(/\{(nombre|ejecutivo|proyecto|emoji)\}/g, (_, key) => values[key] ?? '');
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
  const userId = users.get(executiveName)?.ghlUserId;
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
  return users.get(executiveName)?.instance || users.get(SCHEDULE_DEFAULT_EXECUTIVE)?.instance || INSTANCE_ID;
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
async function sendAudioMessage(phoneNumber, base64Audio, instanceId = INSTANCE_ID) {
  try {
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
async function sendMessageAndAudio(phoneNumber, leadName, message, audio, delay = randomBetween(AUDIO_DELAY_RANGE), instanceId = INSTANCE_ID, textDelay = 0) {
  try {
    if (textDelay > 0) {
      console.log(`⏱️  Esperando ${textDelay / 1000} segundos antes de enviar el texto...`);
      await sleep(textDelay);
    }

    // Enviar mensaje de texto
    const formattedMessage = message.replace('{nombre}', leadName);
    await sendTextMessage(phoneNumber, formattedMessage, instanceId);

    if (!audio) {
      return { success: true, message: 'Texto enviado (sin audio)', phoneNumber, leadName };
    }

    // Esperar antes del audio
    console.log(`⏱️  Esperando ${delay / 1000} segundos antes de enviar audio (${audio.label})...`);
    await sleep(delay);

    // Enviar audio
    await sendAudioMessage(phoneNumber, audio.base64, instanceId);

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
    // Nombre completo tal como lo escribió en el formulario (customData.contactName trae solo el nombre de pila,
    // a veces con tabulaciones de más). GHL a veces lo guarda en minúsculas: se capitaliza cada palabra.
    const contactName = capitalizeWords(String(req.body.full_name
      || [req.body.first_name, req.body.last_name].filter(Boolean).join(' ')
      || rawContactName || '').trim());
    // Formulario de Meta de origen (para la planilla y para comparar formularios)
    const formName = req.body.contact?.lastAttributionSource?.formName
      || req.body.contact?.attributionSource?.formName || payload.formName || '';
    const adName = req.body.contact?.lastAttributionSource?.adName || req.body.contact?.attributionSource?.adName || '';
    // El teléfono de la raíz trae el código de país (+56...); el de customData, solo lo que escribió el lead
    const rawPhone = String(req.body.phone || contactPhone || '').trim();
    const email = String(req.body.email || payload.contactEmail || payload.email || '').trim();
    const isCyber = String(campaign || '').trim().toLowerCase() === 'cyber';
    // GHL manda los tags del contacto en la raíz del body, no dentro de customData
    const tags = req.body.tags ?? payload.tags;

    // Validar datos mínimos
    // Sin teléfono el lead igual se procesa: la Maestra avisa para contactarlo por otro medio
    if (!contactName) {
      console.error('❌ Datos insuficientes: falta el nombre del lead');
      return res.status(400).json({
        error: 'Datos insuficientes: se requiere el nombre'
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
    let skipped = [];
    let ownerWritten = Promise.resolve();
    const ghlContactId = req.body.contact_id || contactId;
    const ownerReason = executiveName ? await unavailableReason(executiveName) : 'sin owner';

    if (!ownerReason) {
      console.log(`👤 Ejecutivo tomado del Owner asignado en GHL: ${executiveName}`);
    } else {
      if (executiveName) {
        console.warn(`⚠️  Owner de GHL ${executiveName} no disponible (${ownerReason}) → cadena de respaldo`);
        skipped.push({ executive: executiveName, reason: ownerReason });
      }
      ({ executive: executiveName, sent, skipped } = await assignBySchedule(new Date(), skipped));
      console.log(`🕒 Asignado por horario: ${executiveName}${sent ? '' : ' (sin envío automático)'}`);
      ownerWritten = assignOwnerInGhl({ contactId: ghlContactId, opportunityId, executiveName });
    }
    const isCentral = executiveName === CENTRAL_EXECUTIVE;

    // La instancia de WhatsApp desde la que se envía es la del ejecutivo asignado
    const instanceId = getExecutiveInstance(executiveName);

    // El destinatario del mensaje es el LEAD. Si el número está mal escrito o no tiene WhatsApp,
    // no se le envía nada y la Maestra avisa al ejecutivo para que lo contacte por correo.
    const phoneNumber = formatPhoneNumber(rawPhone);
    const phoneProblem = await checkLeadPhone(phoneNumber, sent ? instanceId : MAESTRA_INSTANCE);
    const contactable = sent && !phoneProblem;
    if (phoneProblem) {
      console.warn(`📵 Teléfono del lead con problema (${phoneProblem}): no se envía WhatsApp`);
      addTagInGhl(ghlContactId, PHONE_PROBLEM_TAG);
    }

    const projectKey = String(projectName).trim().toLowerCase();
    const projectBase = PROJECT_DISPLAY_NAMES[projectKey] || (projectName.charAt(0).toUpperCase() + projectName.slice(1));
    const projectDisplay = isCyber ? `Cyber ${projectBase}` : projectBase;
    // Nombre de pila con mayúscula inicial (GHL a veces lo guarda en minúsculas)
    const firstWord = contactName.split(/\s+/)[0];
    const leadFirstName = firstWord.charAt(0).toUpperCase() + firstWord.slice(1);

    let segment, matched, audioSlot, message;
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
      audioSlot = 'cyber';
      message = users.getMessage(executiveName, 'cyber');
    } else {
      // Determinar segmento según el tag que GHL puso al contacto
      // Solo aplica para Volkania por ahora; Tricalén usa el segmento por defecto y un texto genérico
      ({ segment, matched } = projectKey === 'volkania'
        ? getSegment(tags)
        : { segment: DEFAULT_SEGMENT, matched: true });
      audioSlot = segment;
      message = users.getMessage(executiveName, isCentral || projectKey !== 'volkania' ? 'general' : segment);
    }
    // Los mensajes (editables en el panel) usan {nombre}, {ejecutivo}, {proyecto} y {emoji}
    message = fillMessage(message, {
      nombre: leadFirstName,
      ejecutivo: users.displayName(executiveName),
      proyecto: projectBase,
      emoji: SEGMENT_LABELS[segment].split(' ')[0]
    });
    // Central envía solo texto; los demás, su propio audio si lo tienen (nunca la voz de otro)
    const audio = isCentral || !contactable ? null : await getAudio(executiveName, audioSlot);
    console.log(`💰 Segmento: ${segment} (tags: "${tags || 'N/A'}", pie: "${pieAnswer || 'N/A'}") → audio ${audio ? audio.label : 'ninguno'}`);

    // Base de clientes: campos fijos en GHL + tag "base-clientes", y la fila en la planilla
    const clientBase = {
      proyecto: projectBase,
      segmento: SEGMENT_LABELS[segment].split(' ').slice(1).join(' '),
      campana: isCyber ? CYBER_CAMPAIGN_LABEL : (payload.campaignName || 'General'),
      capacidad: shortPie(pieAnswer),
      visita,
      marketing: payload.marketing
    };
    syncClientBase(ghlContactId, clientBase, ownerWritten);
    appendClientRow({
      ...clientBase,
      contactId: ghlContactId,
      nombre: contactName,
      telefono: phoneProblem ? rawPhone : formatPhoneForReading(phoneNumber),
      correo: email,
      formulario: formName,
      anuncio: adName,
      responsable: users.displayName(executiveName),
      notas: phoneProblem ? `⚠️ Teléfono: ${PHONE_PROBLEM_LABELS[phoneProblem]}` : '',
      pago,
      rawBody: req.body
    });

    // Envío en segundo plano. La disponibilidad ya se revisó al asignar; si nadie estaba
    // disponible (sent = false), no se envía nada y la Maestra avisa a Gerardo y a Central.
    (async () => {
      if (contactable) {
        sendMessageAndAudio(
          phoneNumber,
          contactName,
          message,
          audio,
          randomBetween(AUDIO_DELAY_RANGE),
          instanceId,
          randomBetween(TEXT_DELAY_RANGE)
        ).then(() => {
          // Confirmación al ejecutivo cuando el lead ya recibió todo
          const received = audio ? 'el mensaje y el audio' : 'el mensaje';
          notifyExecutive(executiveName, `⚡ A ${leadFirstName} ya le llegó ${received}, ¡vamos por ese cierre!`);
        }).catch(err => {
          console.error('Error en envío de mensaje/audio:', err.message);
        });
      } else {
        console.warn(`📵 No se envía WhatsApp a ${contactName}: ${phoneProblem ? 'teléfono con problema' : 'nadie disponible'}`);
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
        answers: { visita, pago },
        phoneProblem,
        rawPhone,
        email,
        derivedNote: contactable ? derivationNotices({ skipped, executiveName, contactName, projectDisplay }) : null
      });
      const recipients = sent ? [executiveName] : [SCHEDULE_DEFAULT_EXECUTIVE, CENTRAL_EXECUTIVE];
      // Tarjeta para guardar al lead en el teléfono, con su nombre completo y el proyecto
      // (sin tarjeta si el número está malo: guardaría un contacto inservible)
      const contactCard = phoneProblem ? null : { fullName: `${contactName} · ${projectDisplay}`, contactPhone: phoneNumber };
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
        autoMessage: contactable,
        phoneProblem,
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
    const audio = await getAudio(executiveName, segment === 'cyber' || SEGMENTS.includes(segment) ? segment : DEFAULT_SEGMENT);
    if (!audio) return res.status(404).json({ error: `${executiveName} no tiene ese audio` });
    const instanceId = getExecutiveInstance(executiveName);
    const result = await sendAudioMessage(phoneNumber, audio.base64, instanceId);

    res.json({
      success: true,
      audioUsed: audio.label,
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
 * Estado de una instancia en Evolution: "open", "close", "connecting"... o "missing" si no existe
 */
async function instanceState(instanceId) {
  try {
    const { data } = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${encodeURIComponent(instanceId)}`,
      { headers: { apikey: EVOLUTION_API_KEY }, timeout: 10000 });
    return data?.instance?.state || 'desconocido';
  } catch (err) {
    return err.response?.status === 404 ? 'missing' : 'desconocido';
  }
}

async function createInstance(instanceName) {
  await axios.post(`${EVOLUTION_API_URL}/instance/create`, { instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' },
    { headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
  console.log(`📱 Instancia ${instanceName} creada en Evolution`);
}

// Pide a Evolution el QR y el código de 8 caracteres para vincular el WhatsApp
async function connectInstance(instanceId, phone) {
  if (await instanceState(instanceId) === 'open') return { state: 'open' };
  const { data } = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${encodeURIComponent(instanceId)}`,
    { params: { number: formatPhoneNumber(phone) }, headers: { apikey: EVOLUTION_API_KEY }, timeout: 20000 });
  return { pairingCode: data?.pairingCode || null, qr: data?.base64 || null };
}

/**
 * Convierte cualquier audio (m4a, mp3, wav, ogg, aac...) a nota de voz de WhatsApp: OGG Opus mono 48 kHz,
 * con el mismo filtro y volumen que los audios oficiales. Máximo 3 minutos.
 */
const MAX_AUDIO_SECONDS = 180;
function convertAudio(input) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-t', String(MAX_AUDIO_SECONDS),
      '-af', 'highpass=f=80,loudnorm=I=-18:TP=-2:LRA=11', '-ar', '48000', '-ac', '1',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1']);
    const out = [];
    ffmpeg.stdout.on('data', d => out.push(d));
    ffmpeg.stderr.on('data', () => { /* los errores se reflejan en el código de salida */ });
    ffmpeg.on('error', () => reject(new Error('No se pudo convertir el audio (falta ffmpeg en el servidor)')));
    ffmpeg.on('close', code => {
      const buffer = Buffer.concat(out);
      if (code !== 0 || buffer.length < 1000) return reject(new Error('El archivo no parece ser un audio válido'));
      // Duración: posición de la última página OGG (granule position / 48000)
      const last = buffer.lastIndexOf(Buffer.from('OggS'));
      const seconds = last >= 0 ? Number(buffer.readBigUInt64LE(last + 6)) / 48000 : 0;
      if (seconds < 3) return reject(new Error('El audio dura menos de 3 segundos'));
      resolve({ buffer, seconds });
    });
    ffmpeg.stdin.on('error', () => { /* ffmpeg cerró antes; lo reporta "close" */ });
    ffmpeg.stdin.end(input);
  });
}

const ADMIN_KEY = process.env.ADMIN_KEY || null;
require('./panel')(app, {
  ADMIN_KEY,
  TIMEZONE: SCHEDULE_TIMEZONE,
  chileMinutes,
  executivesOnShift,
  getAbsence,
  setAbsence,
  getExecutiveInstance,
  instanceState,
  connectInstance,
  createInstance,
  notifyExecutive,
  convertAudio,
  getAudio,
  AUDIO_BASE_PATH_FOR: (executive, slot) => fs.existsSync(`${AUDIO_BASE_PATH}/${executive}/ogg/${slot}.ogg`)
});

/**
 * Vigilancia de los WhatsApp: cada minuto revisa todas las instancias (y la Maestra). Si una lleva
 * 2 minutos desconectada, la Maestra avisa a Gerardo, a Central y a la persona afectada; cuando
 * vuelve, avisa que se reconectó. Solo se vigilan instancias que alguna vez estuvieron conectadas.
 * Si la caída es de la Maestra, el aviso a Gerardo sale desde el WhatsApp de Central.
 */
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 60 * 1000;
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 2 * 60 * 1000;
const MONITOR_KEY_PREFIX = 'monitor:';
const monitorState = new Map(); // usuario (o "maestra") -> { downSince, alerted, seenOpen }

async function monitorFlag(id, field, value) {
  const key = `${MONITOR_KEY_PREFIX}${field}:${id}`;
  try {
    if (value === undefined) return await withTimeout(redisClient.get(key));
    return await withTimeout(value ? redisClient.set(key, '1') : redisClient.del(key));
  } catch (err) {
    return null;
  }
}

async function alertDisconnection(owner, text) {
  const maestraUp = MAESTRA_INSTANCE && (await instanceState(MAESTRA_INSTANCE)) === 'open';
  const from = maestraUp ? MAESTRA_INSTANCE : getExecutiveInstance(CENTRAL_EXECUTIVE);
  const recipients = [...new Set([SCHEDULE_DEFAULT_EXECUTIVE, CENTRAL_EXECUTIVE, owner].filter(Boolean))]
    // si el aviso sale desde el WhatsApp de Central, no se le manda a Central
    .filter(r => maestraUp || r !== CENTRAL_EXECUTIVE);
  for (const r of recipients) await notifyExecutive(r, text, null, { immediate: true, fromInstance: from });
}

async function checkInstances() {
  const watched = users.list().map(u => ({ id: u.username, owner: u.username, label: `de ${u.displayName}`, instance: u.instance }));
  if (MAESTRA_INSTANCE) watched.push({ id: 'maestra', owner: null, label: 'de la Maestra', instance: MAESTRA_INSTANCE });
  for (const { id, owner, label, instance } of watched) {
    const state = await instanceState(instance);
    if (!monitorState.has(id)) {
      monitorState.set(id, { downSince: null, alerted: (await monitorFlag(id, 'alerted')) === '1', seenOpen: (await monitorFlag(id, 'seen')) === '1' });
    }
    const entry = monitorState.get(id);
    if (state === 'open') {
      if (!entry.seenOpen) { entry.seenOpen = true; monitorFlag(id, 'seen', true); }
      if (entry.alerted) {
        entry.alerted = false; monitorFlag(id, 'alerted', false);
        console.log(`🟢 Monitor: WhatsApp ${label} reconectado`);
        alertDisconnection(owner, `🟢 El WhatsApp ${label} volvió a conectarse.`);
      }
      entry.downSince = null;
      continue;
    }
    if (!entry.seenOpen || state === 'desconocido') continue; // nunca vinculado, o Evolution no respondió
    entry.downSince = entry.downSince || Date.now();
    if (!entry.alerted && Date.now() - entry.downSince >= DISCONNECT_GRACE_MS) {
      entry.alerted = true; monitorFlag(id, 'alerted', true);
      console.warn(`🔴 Monitor: WhatsApp ${label} desconectado (${state})`);
      alertDisconnection(owner, owner
        ? `🔴 El WhatsApp ${label} se desconectó. Mientras tanto, sus leads se derivan a quien esté disponible.\n🔌 Para reconectarlo: entra a ${PANEL_URL} → Reconectar.`
        : `🔴 El WhatsApp de la Maestra se desconectó: los avisos de leads no están llegando.\n🔌 Hay que volver a vincularlo en Evolution.`);
    }
  }
}

if (process.env.DISABLE_MONITOR !== '1') {
  setInterval(() => checkInstances().catch(err => console.error('❌ Monitor de WhatsApp:', err.message)), MONITOR_INTERVAL_MS);
}

// =====================
// RED DE SEGURIDAD DE LEADS
// =====================
// Si un lead de una campaña Cyber entra a GHL pero el workflow de captura no se dispara (pasó el 8 de
// octubre con un formulario recién cambiado), el contacto queda sin el tag cyber-oct26. Cada 5 minutos
// se buscan esos contactos y se agregan al workflow del proyecto, que hace el resto como siempre.

const LEAD_SWEEP_INTERVAL_MS = Number(process.env.LEAD_SWEEP_INTERVAL_MS) || 5 * 60 * 1000;
const LEAD_SWEEP_MIN_AGE_MS = 3 * 60 * 1000;      // le da tiempo al workflow normal
const LEAD_SWEEP_MAX_AGE_MS = 12 * 60 * 60 * 1000; // no toca contactos antiguos
const LEAD_SWEEP_KEY_PREFIX = 'sweep:';
// Workflows de captura por proyecto (CYBER_CAPTURE_WORKFLOWS=volkania=<id>;tricalen=<id>)
const CYBER_CAPTURE_WORKFLOWS = Object.fromEntries(
  (process.env.CYBER_CAPTURE_WORKFLOWS || 'volkania=e283ce08-7743-4b2a-bc3d-4627045f9540;tricalen=309d1193-c672-44d5-99b8-b508761bcdde')
    .split(';').map(pair => pair.split('=').map(s => s.trim())).filter(([k, v]) => k && v)
);

function cyberAttribution(contact) {
  return (contact.attributions || []).find(a => /cyber/i.test(a.utmCampaign || '')) || null;
}

async function sweepMissedLeads() {
  if (!GHL_PIT) return;
  const { data } = await axios.get(`${GHL_API_URL}/contacts/`, {
    headers: ghlHeaders(), params: { locationId: GHL_LOCATION_ID, limit: 50 }, timeout: 15000
  });
  const now = Date.now();
  for (const contact of data.contacts || []) {
    const age = now - new Date(contact.dateAdded).getTime();
    if (age > LEAD_SWEEP_MAX_AGE_MS) break; // vienen ordenados del más nuevo al más antiguo
    if (age < LEAD_SWEEP_MIN_AGE_MS || (contact.tags || []).includes('cyber-oct26')) continue;
    const attribution = cyberAttribution(contact);
    if (!attribution) continue; // no viene de una campaña Cyber (p. ej. un mensaje de Instagram)
    const key = LEAD_SWEEP_KEY_PREFIX + contact.id;
    if (await withTimeout(redisClient.get(key)).catch(() => null)) continue; // ya se rescató antes
    const project = /trical/i.test(`${attribution.utmContent} ${attribution.utmMedium}`) ? 'tricalen' : 'volkania';
    const workflowId = CYBER_CAPTURE_WORKFLOWS[project];
    if (!workflowId) continue;
    await withTimeout(redisClient.set(key, '1', { EX: 7 * 24 * 60 * 60 })).catch(() => {});
    const name = capitalizeWords(String(contact.contactName || 'Sin nombre'));
    try {
      await axios.post(`${GHL_API_URL}/contacts/${contact.id}/workflow/${workflowId}`, {}, { headers: ghlHeaders(), timeout: 10000 });
      console.warn(`🛟 Red de seguridad: ${name} entró a GHL sin pasar por el workflow; agregado al de ${project}`);
      notifyExecutive(SCHEDULE_DEFAULT_EXECUTIVE,
        `🛟 Lead rescatado — ${name} (${PROJECT_DISPLAY_NAMES[project] || project})\nEntró a GHL pero el workflow no se disparó. Ya lo agregué al workflow: en un momento te llega el aviso normal del lead.`,
        null, { immediate: true });
    } catch (err) {
      console.error(`❌ Red de seguridad: no se pudo agregar a ${name} al workflow de ${project}:`, err.response?.status || err.message);
      await withTimeout(redisClient.del(key)).catch(() => {}); // se reintenta en la próxima vuelta
    }
  }
}

if (process.env.DISABLE_LEAD_SWEEP !== '1') {
  setInterval(() => sweepMissedLeads().catch(err => console.error('❌ Red de seguridad de leads:', err.response?.status || err.message)), LEAD_SWEEP_INTERVAL_MS);
}

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
      schedule: users.list().map(u => ({ executive: u.username, start: u.schedule?.start ?? null, end: u.schedule?.end ?? null })),
      onShift: executivesOnShift(date),
      absent: Object.fromEntries(await Promise.all(
        users.list().map(async u => [u.username, await getAbsence(u.username)])
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
  console.log('  GET  /disponibilidad  (panel de usuarios)');
});
