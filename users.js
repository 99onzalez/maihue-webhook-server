// Usuarios del panel de Disponibilidad: perfil, rol, horario, contraseña, mensajes y audios.
// Todo queda en Redis (con volumen persistente en Railway), con una copia en memoria para que
// el flujo de leads siga funcionando aunque Redis no responda.
const crypto = require('crypto');

const USERS_KEY = 'panel:users';
const AUDIO_KEY_PREFIX = 'panel:audio:';
const SESSION_KEY_PREFIX = 'panel:session:';
const SESSION_TTL = 60 * 60 * 24 * 180; // 180 días

// Gerardo atiende fuera de los turnos y Central es el último respaldo: sus claves son fijas.
const DEFAULT_EXECUTIVE = 'gerardo';
const CENTRAL_EXECUTIVE = 'central';

// Mensajes y audios que cada usuario puede personalizar (la misma lógica de siempre, ahora editable)
const MESSAGE_SLOTS = {
  cyber: 'Cyber',
  contado: 'Volkania · Contado',
  financiamiento: 'Volkania · Financiamiento',
  sin_urgencia: 'Volkania · Sin urgencia',
  general: 'Otros proyectos (Tricalén)'
};
const CENTRAL_MESSAGE_SLOTS = { cyber: 'Cyber', general: 'General' };
const AUDIO_SLOTS = {
  cyber: 'Cyber',
  contado: 'Contado',
  financiamiento: 'Financiamiento',
  sin_urgencia: 'Sin urgencia'
};

let redisClient = null;
let withTimeout = p => p;
let users = {};           // username -> perfil
let defaultMessages = {}; // { normal: {slot: texto}, central: {slot: texto} }
const sessionsInMemory = new Map();

function init({ client, timeout, seedUsers, messages }) {
  redisClient = client;
  withTimeout = timeout;
  defaultMessages = messages;
  users = Object.fromEntries(seedUsers.map(u => [u.username, normalize(u)]));
}

function normalize(u) {
  return {
    username: u.username,
    displayName: u.displayName,
    role: u.role === 'admin' ? 'admin' : 'ejecutivo',
    phone: u.phone || null,
    instance: u.instance || u.displayName,
    ghlUserId: u.ghlUserId || null,
    schedule: u.schedule || null,     // { start, end } en minutos desde medianoche (hora de Chile)
    passwordHash: u.passwordHash || null,
    messages: u.messages || {},       // solo los personalizados; el resto usa el texto por defecto
    audios: u.audios || {},           // slot -> fecha de subida (el audio va en otra clave)
    createdAt: u.createdAt || new Date().toISOString()
  };
}

/**
 * Carga los usuarios guardados. La primera vez (Redis vacío) guarda los iniciales.
 * Si Redis no responde, se queda con los iniciales en memoria.
 */
async function load() {
  try {
    const raw = await withTimeout(redisClient.get(USERS_KEY));
    if (raw) {
      users = Object.fromEntries(Object.values(JSON.parse(raw)).map(u => [u.username, normalize(u)]));
      console.log(`👥 Usuarios del panel cargados: ${Object.keys(users).join(', ')}`);
    } else {
      await save();
      console.log('👥 Usuarios del panel creados por primera vez');
    }
    return true;
  } catch (err) {
    console.error('⚠️  No se pudieron cargar los usuarios desde Redis (uso los iniciales):', err.message);
    return false;
  }
}

async function save() {
  await withTimeout(redisClient.set(USERS_KEY, JSON.stringify(users)));
}

const list = () => Object.values(users);
const get = username => users[username] || null;
const byGhlUserId = id => (id && list().find(u => u.ghlUserId === String(id).trim())?.username) || null;
const displayName = username => users[username]?.displayName || username;
const isAdmin = username => users[username]?.role === 'admin';
const canManage = (actor, target) => isAdmin(actor) || actor === target;

function slug(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function create(profile) {
  const username = slug(profile.displayName);
  if (!username) throw new Error('Nombre inválido');
  if (users[username]) throw new Error('Ya existe un usuario con ese nombre');
  users[username] = normalize({ ...profile, username });
  await save();
  return users[username];
}

async function update(username, changes) {
  if (!users[username]) throw new Error('Usuario no existe');
  users[username] = normalize({ ...users[username], ...changes, username });
  await save();
  return users[username];
}

// Contraseñas con scrypt y sal aleatoria: lo guardado no permite recuperar la contraseña.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(username, password) {
  const stored = users[username]?.passwordHash;
  if (!stored || !password) return false;
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(password, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function setPassword(username, password) {
  if (String(password).length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres');
  return update(username, { passwordHash: hashPassword(password) });
}

// Mensajes: el personalizado del usuario o, si no tiene, el texto por defecto
function messageSlots(username) {
  return username === CENTRAL_EXECUTIVE ? CENTRAL_MESSAGE_SLOTS : MESSAGE_SLOTS;
}

function defaultMessage(username, slot) {
  return (username === CENTRAL_EXECUTIVE ? defaultMessages.central : defaultMessages.normal)[slot] || '';
}

function getMessage(username, slot) {
  return users[username]?.messages?.[slot] || defaultMessage(username, slot);
}

async function setMessage(username, slot, text) {
  const messages = { ...users[username].messages };
  if (text && text.trim() && text.trim() !== defaultMessage(username, slot)) messages[slot] = text.trim();
  else delete messages[slot];
  return update(username, { messages });
}

// Audios: OGG Opus en base64, una clave por usuario y slot
async function getAudio(username, slot) {
  if (!users[username]?.audios?.[slot]) return null;
  try {
    return await withTimeout(redisClient.get(`${AUDIO_KEY_PREFIX}${username}:${slot}`), 5000);
  } catch (err) {
    console.error(`⚠️  No se pudo leer el audio ${slot} de ${username} desde Redis:`, err.message);
    return null;
  }
}

async function setAudio(username, slot, base64) {
  await withTimeout(redisClient.set(`${AUDIO_KEY_PREFIX}${username}:${slot}`, base64), 5000);
  return update(username, { audios: { ...users[username].audios, [slot]: new Date().toISOString() } });
}

async function deleteAudio(username, slot) {
  await withTimeout(redisClient.del(`${AUDIO_KEY_PREFIX}${username}:${slot}`)).catch(() => {});
  const audios = { ...users[username].audios };
  delete audios[slot];
  return update(username, { audios });
}

// Sesiones del panel: token aleatorio en una cookie HttpOnly → usuario
async function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessionsInMemory.set(token, username);
  await withTimeout(redisClient.set(SESSION_KEY_PREFIX + token, username, { EX: SESSION_TTL })).catch(() => {});
  return token;
}

async function sessionUser(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  let username = null;
  try {
    username = await withTimeout(redisClient.get(SESSION_KEY_PREFIX + token));
  } catch (err) {
    username = sessionsInMemory.get(token) || null;
  }
  return username && users[username] ? username : null;
}

async function deleteSession(token) {
  sessionsInMemory.delete(token);
  if (token) await withTimeout(redisClient.del(SESSION_KEY_PREFIX + token)).catch(() => {});
}

module.exports = {
  DEFAULT_EXECUTIVE, CENTRAL_EXECUTIVE, MESSAGE_SLOTS, CENTRAL_MESSAGE_SLOTS, AUDIO_SLOTS, SESSION_TTL,
  init, load, list, get, byGhlUserId, displayName, isAdmin, canManage, create, update,
  verifyPassword, setPassword, messageSlots, defaultMessage, getMessage, setMessage,
  getAudio, setAudio, deleteAudio, createSession, sessionUser, deleteSession
};
