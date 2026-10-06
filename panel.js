// Panel de Disponibilidad (/disponibilidad): cada usuario entra con su usuario y contraseña.
// Admins (Gerardo, Central) manejan a todos y crean usuarios; los ejecutivos, solo su propio perfil:
// ausencias (hoy / hasta una fecha / hasta reactivar), horario, mensajes, audios y reconexión del WhatsApp.
const express = require('express');
const crypto = require('crypto');
const users = require('./users');

const COOKIE = 'maihue_session';
const RECONNECT_COOLDOWN_MS = 60 * 1000; // un código a la vez: pedir varios seguidos puede bloquear el número
const lastConnectRequest = new Map();

const ABSENCE_LABELS = {
  hoy: 'Ausente solo por hoy (vuelve a las 00:00)',
  indefinido: 'Ausente hasta que se reactive',
  hasta: 'Ausente hasta'
};

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMinutes = text => {
  const match = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

// "2026-10-06T09:00" en hora de Chile → milisegundos UTC
function chileLocalToMs(text, timeZone) {
  const match = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return guess - (shown - guess);
}

function formatChileDate(ms, timeZone) {
  return new Intl.DateTimeFormat('es-CL', { timeZone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function page(body, script = '') {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Disponibilidad Maihue</title><style>
:root{--brand:#F15A24;--ink:#1c1917;--muted:#78716c;--line:#e7e5e4;--bg:#f5f5f4;--card:#fff}
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:16px;max-width:640px;margin-inline:auto}
h1{font-size:1.3rem;margin:0 0 4px}h2{font-size:1rem;margin:0 0 8px}.sub{color:var(--muted);margin:0 0 16px;font-size:.9rem}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.card{background:var(--card);border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 1px 3px #0001}
.name{font-weight:700;font-size:1.05rem}.role{font-size:.75rem;background:#f5f5f4;border-radius:6px;padding:2px 6px;margin-left:6px;color:var(--muted);font-weight:600}
.state{font-size:.9rem;margin:4px 0 8px;color:#44403c}
details{border-top:1px solid var(--line);padding:8px 0 2px}summary{cursor:pointer;font-weight:600;font-size:.92rem;padding:4px 0}
form{margin:6px 0}.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
button{border:0;border-radius:8px;padding:9px 12px;font-size:.9rem;cursor:pointer;background:#e7e5e4;color:var(--ink)}
.off{background:#fee2e2;color:#991b1b}.on{background:#dcfce7;color:#166534}.key{background:var(--brand);color:#fff}.link{background:none;color:var(--muted);text-decoration:underline;padding:4px}
input,select,textarea{padding:9px;border:1px solid #d6d3d1;border-radius:8px;font-size:.95rem;font-family:inherit;max-width:100%}
textarea{width:100%;min-height:84px}input[type=password],input[type=text],input[type=tel]{width:100%}
label{font-size:.85rem;color:#44403c;display:block;margin:6px 0 2px}.hint{font-size:.8rem;color:var(--muted);margin:4px 0}
.slot{border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0}.slot b{font-size:.9rem}
.msg{background:#fef3c7;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:.92rem}.err{background:#fee2e2}
.code{font-size:1.8rem;font-weight:800;letter-spacing:4px;text-align:center;margin:8px 0}
.qr{display:block;max-width:240px;margin:8px auto}audio{width:100%;margin:6px 0}
</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

// Nombre de la instancia en Evolution: sin tildes ni espacios ("María José" → "MariaJose")
function instanceName(displayName) {
  return String(displayName).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '');
}

function readCookie(req) {
  const found = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`));
  return found ? decodeURIComponent(found.slice(COOKIE.length + 1)) : null;
}

module.exports = function registerPanel(app, deps) {
  const {
    ADMIN_KEY, TIMEZONE, chileMinutes, executivesOnShift, getAbsence, setAbsence, getExecutiveInstance,
    instanceState, connectInstance, createInstance, notifyExecutive, convertAudio, getAudio, AUDIO_BASE_PATH_FOR
  } = deps;
  const DEFAULT = users.DEFAULT_EXECUTIVE;
  const CENTRAL = users.CENTRAL_EXECUTIVE;
  const form = express.urlencoded({ extended: false });

  // Sesión obligatoria; deja req.actor con el usuario conectado
  async function auth(req, res, next) {
    req.actor = await users.sessionUser(readCookie(req));
    if (req.actor) return next();
    if (req.method === 'GET' && req.path === '/disponibilidad') return next();
    res.status(401).json({ error: 'Sesión expirada: vuelve a entrar' });
  }

  // El usuario objetivo debe existir y el que actúa debe poder manejarlo
  function target(req, res) {
    const username = String(req.body?.user || req.query.user || '');
    if (!users.get(username)) { res.status(400).send(page('<div class="card">Usuario no existe. <a href="/disponibilidad">Volver</a></div>')); return null; }
    if (!users.canManage(req.actor, username)) { res.status(403).send(page('<div class="card">Sin permiso. <a href="/disponibilidad">Volver</a></div>')); return null; }
    return username;
  }

  const back = (res, text, isError = false) =>
    res.redirect(303, `/disponibilidad?${isError ? 'e' : 'm'}=${encodeURIComponent(text)}`);

  // Aviso a Gerardo cuando otra persona cambia algo (no se avisa a sí mismo)
  function tellAdmin(actor, text) {
    if (actor !== DEFAULT) notifyExecutive(DEFAULT, text, null, { immediate: true });
  }

  app.get('/disponibilidad', auth, async (req, res) => {
    const notice = req.query.m ? `<div class="msg">${escapeHtml(req.query.m)}</div>` : req.query.e ? `<div class="msg err">${escapeHtml(req.query.e)}</div>` : '';
    if (!req.actor) {
      const options = users.list().map(u => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.displayName)}</option>`).join('');
      return res.send(page(`<h1>Disponibilidad Maihue</h1><p class="sub">Entra con tu usuario.</p>${notice}
<div class="card"><form method="post" action="/disponibilidad/login">
<label>Usuario</label><select name="user" required>${options}</select>
<label>Contraseña</label><input type="password" name="password" autocomplete="current-password" required>
<div class="row" style="margin-top:10px"><button class="key" type="submit">Entrar</button></div></form>
<p class="hint">¿No tienes contraseña? Pídesela a Gerardo o a Central.</p></div>`));
    }
    const actor = req.actor;
    const admin = users.isAdmin(actor);
    const minutes = chileMinutes();
    const onShift = executivesOnShift();
    const visible = admin ? users.list() : [users.get(actor)];
    const cards = await Promise.all(visible.map(u => userCard(u, { actor, admin, onShift })));
    const createForm = admin ? `<div class="card"><details><summary>➕ Crear usuario nuevo</summary>
<form method="post" action="/disponibilidad/usuarios">
<label>Nombre (así firma los mensajes)</label><input type="text" name="displayName" required>
<label>Rol</label><select name="role"><option value="ejecutivo">Ejecutivo/a (maneja solo su perfil)</option><option value="admin">Admin (maneja a todos)</option></select>
<label>Teléfono WhatsApp</label><input type="tel" name="phone" placeholder="+56 9 1234 5678" required>
<label>ID de usuario en GHL</label><input type="text" name="ghlUserId" placeholder="Settings → My Staff → el ID está en la URL">
<label>Horario (opcional)</label><div class="row"><input type="time" name="start"> a <input type="time" name="end"></div>
<label>Contraseña inicial (mín. 6)</label><input type="text" name="password" required minlength="6">
<p class="hint">Se crea su WhatsApp en Evolution. Después, en su tarjeta, toca <b>Reconectar</b> para vincularlo.</p>
<button class="key" type="submit">Crear usuario</button></form></details></div>` : '';
    res.send(page(`<div class="top"><div><h1>Disponibilidad Maihue</h1>
<p class="sub">Hola ${escapeHtml(users.displayName(actor))} · Hora de Chile ${hhmm(minutes)} · <a href="/disponibilidad">actualizar</a></p></div>
<form method="post" action="/disponibilidad/logout"><button class="link" type="submit">Salir</button></form></div>
${notice}${cards.join('')}${createForm}`, PANEL_SCRIPT));
  });

  async function userCard(u, { admin, onShift }) {
    const name = u.username;
    const [absence, state] = await Promise.all([getAbsence(name), instanceState(getExecutiveInstance(name))]);
    const open = state === 'open';
    const icon = absence ? '🔕' : open ? '🟢' : '🔴';
    const absenceText = absence ? (absence.mode === 'hasta' ? `${ABSENCE_LABELS.hasta} ${formatChileDate(absence.until, TIMEZONE)}` : ABSENCE_LABELS[absence.mode]) : 'Disponible';
    const waText = open ? 'WhatsApp conectado' : state === 'missing' ? 'WhatsApp sin crear' : 'WhatsApp desconectado';
    const shiftText = name === DEFAULT ? 'Cubre fuera de los turnos'
      : name === CENTRAL ? 'Último respaldo'
      : u.schedule ? `Turno ${hhmm(u.schedule.start)}–${hhmm(u.schedule.end)}${onShift.includes(name) ? ' · de turno ahora' : ''}` : 'Sin turno';
    const hidden = `<input type="hidden" name="user" value="${escapeHtml(name)}">`;
    const absenceForms = absence
      ? `<form method="post" action="/disponibilidad/ausencia">${hidden}<input type="hidden" name="mode" value="disponible"><button class="on" type="submit">Marcar disponible</button></form>`
      : `<div class="row"><form method="post" action="/disponibilidad/ausencia">${hidden}<input type="hidden" name="mode" value="hoy"><button class="off" type="submit">Ausente solo hoy</button></form>
<form method="post" action="/disponibilidad/ausencia">${hidden}<input type="hidden" name="mode" value="indefinido"><button class="off" type="submit">Ausente hasta reactivar</button></form></div>
<form method="post" action="/disponibilidad/ausencia">${hidden}<input type="hidden" name="mode" value="hasta">
<label>…o ausente y volver automáticamente el:</label><div class="row"><input type="datetime-local" name="until" required><button class="off" type="submit">Programar regreso</button></div></form>`;
    const scheduleSection = [DEFAULT, CENTRAL].includes(name) ? '' : `<details><summary>🕒 Horario</summary>
<form method="post" action="/disponibilidad/horario">${hidden}<div class="row">
<input type="time" name="start" value="${u.schedule ? hhmm(u.schedule.start) : ''}"> a <input type="time" name="end" value="${u.schedule ? hhmm(u.schedule.end) : ''}">
<button type="submit">Guardar</button></div><p class="hint">Deja ambos vacíos para quedar sin turno. Rige todos los días, hora de Chile.</p></form></details>`;
    const messageSlots = users.messageSlots(name);
    const messages = Object.entries(messageSlots).map(([slot, label]) => {
      const custom = Boolean(u.messages[slot]);
      return `<form class="slot" method="post" action="/disponibilidad/mensaje">${hidden}<input type="hidden" name="slot" value="${slot}">
<b>${escapeHtml(label)}</b>${custom ? ' <span class="role">personalizado</span>' : ''}
<textarea name="text">${escapeHtml(users.getMessage(name, slot))}</textarea>
<div class="row"><button type="submit">Guardar</button>${custom ? '<button class="link" type="submit" name="reset" value="1">Volver al original</button>' : ''}</div></form>`;
    }).join('');
    const audios = name === CENTRAL ? '<p class="hint">Central envía solo texto (sin audio).</p>' : Object.entries(users.AUDIO_SLOTS).map(([slot, label]) => {
      const uploaded = u.audios[slot];
      const inRepo = AUDIO_BASE_PATH_FOR(name, slot);
      const has = uploaded || inRepo;
      return `<div class="slot"><b>${escapeHtml(label)}</b> <span class="hint">${uploaded ? `subido ${escapeHtml(formatChileDate(Date.parse(uploaded), TIMEZONE))}` : inRepo ? 'audio cargado' : 'sin audio: se envía solo el texto'}</span>
${has ? `<audio controls preload="none" src="/disponibilidad/audio?user=${encodeURIComponent(name)}&slot=${slot}"></audio>` : ''}
<div class="row"><input type="file" accept="audio/*" data-user="${escapeHtml(name)}" data-slot="${slot}" class="audio-input"><button type="button" class="key upload">Subir</button>
${uploaded ? `<form method="post" action="/disponibilidad/audio/borrar">${hidden}<input type="hidden" name="slot" value="${slot}"><button class="link" type="submit">Quitar</button></form>` : ''}</div>
<p class="hint status"></p></div>`;
    }).join('');
    const passwordForm = `<details><summary>🔑 Contraseña</summary><form method="post" action="/disponibilidad/password">${hidden}
<input type="password" name="password" minlength="6" required placeholder="Nueva contraseña (mín. 6)" autocomplete="new-password"><div class="row" style="margin-top:6px"><button type="submit">Cambiar</button></div></form></details>`;
    return `<div class="card"><div class="name">${icon} ${escapeHtml(u.displayName)}<span class="role">${u.role === 'admin' ? 'admin' : 'ejecutivo/a'}</span></div>
<div class="state">${escapeHtml(absenceText)} · ${escapeHtml(waText)} · ${escapeHtml(shiftText)}${admin && !u.passwordHash ? ' · <b>sin contraseña</b>' : ''}</div>
${absenceForms}
<details${open ? '' : ' open'}><summary>📱 WhatsApp</summary><p class="hint">${open ? 'Conectado. Si se cae, avisaremos a Gerardo, a Central y a esta persona.' : 'Para vincularlo: toca Reconectar y en el celular abre WhatsApp → Dispositivos vinculados → Vincular dispositivo. Escanea el QR desde otra pantalla, o toca "Vincular con número de teléfono" e ingresa el código.'}</p>
<button type="button" class="key reconnect" data-user="${escapeHtml(name)}">${open ? 'Volver a vincular' : 'Reconectar'}</button><div class="pair"></div></details>
${scheduleSection}
<details><summary>💬 Mensajes iniciales</summary><p class="hint">Puedes usar {nombre}, {ejecutivo}, {proyecto} y {emoji}; se reemplazan solos.</p>${messages}</details>
<details><summary>🎙️ Audios</summary>${audios}</details>
${passwordForm}</div>`;
  }

  app.post('/disponibilidad/login', form, async (req, res) => {
    const username = String(req.body.user || '');
    const password = String(req.body.password || '');
    // La clave maestra (ADMIN_KEY) entra como Gerardo: sirve para el primer ingreso y como respaldo
    const master = username === DEFAULT && ADMIN_KEY && password.length === ADMIN_KEY.length
      && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_KEY));
    if (!users.get(username) || !(master || users.verifyPassword(username, password))) {
      return back(res, 'Usuario o contraseña incorrectos', true);
    }
    const token = await users.createSession(username);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/disponibilidad; HttpOnly; Secure; SameSite=Strict; Max-Age=${users.SESSION_TTL}`);
    res.redirect(303, '/disponibilidad');
  });

  app.post('/disponibilidad/logout', async (req, res) => {
    await users.deleteSession(readCookie(req));
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/disponibilidad; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    res.redirect(303, '/disponibilidad');
  });

  app.post('/disponibilidad/ausencia', form, auth, async (req, res) => {
    const name = target(req, res); if (!name) return;
    const mode = String(req.body.mode);
    let until = null;
    if (mode === 'hasta') {
      until = chileLocalToMs(req.body.until, TIMEZONE);
      if (!until || until <= Date.now() + 60000) return back(res, 'Elige una fecha y hora futura para el regreso', true);
    } else if (!['hoy', 'indefinido', 'disponible'].includes(mode)) return back(res, 'Opción inválida', true);
    await setAbsence(name, mode, until);
    const text = mode === 'disponible' ? 'disponible' : mode === 'hasta' ? `ausente hasta ${formatChileDate(until, TIMEZONE)}` : ABSENCE_LABELS[mode].toLowerCase();
    console.log(`🔕 Disponibilidad: ${name} → ${mode} (por ${req.actor})`);
    tellAdmin(req.actor, `${mode === 'disponible' ? '🟢' : '🔕'} ${users.displayName(name)} quedó ${text}${req.actor !== name ? ` (lo cambió ${users.displayName(req.actor)})` : ''}`);
    back(res, `${users.displayName(name)} quedó ${text}`);
  });

  app.post('/disponibilidad/horario', form, auth, async (req, res) => {
    const name = target(req, res); if (!name) return;
    const start = toMinutes(req.body.start);
    const end = toMinutes(req.body.end);
    let schedule = null;
    if (req.body.start || req.body.end) {
      if (start === null || end === null || end <= start) return back(res, 'Horario inválido: la hora de término debe ser después de la de inicio', true);
      schedule = { start, end };
    }
    await users.update(name, { schedule });
    const text = schedule ? `${hhmm(start)}–${hhmm(end)}` : 'sin turno';
    console.log(`🕒 Horario: ${name} → ${text} (por ${req.actor})`);
    tellAdmin(req.actor, `🕒 ${users.displayName(name)} quedó con horario ${text}${req.actor !== name ? ` (lo cambió ${users.displayName(req.actor)})` : ''}`);
    back(res, `Horario de ${users.displayName(name)}: ${text}`);
  });

  app.post('/disponibilidad/mensaje', form, auth, async (req, res) => {
    const name = target(req, res); if (!name) return;
    const slot = String(req.body.slot);
    if (!users.messageSlots(name)[slot]) return back(res, 'Mensaje inválido', true);
    await users.setMessage(name, slot, req.body.reset ? '' : String(req.body.text || '').slice(0, 1500));
    back(res, req.body.reset ? 'Mensaje restaurado al original' : 'Mensaje guardado');
  });

  app.post('/disponibilidad/password', form, auth, async (req, res) => {
    const name = target(req, res); if (!name) return;
    try {
      await users.setPassword(name, String(req.body.password || ''));
      back(res, `Contraseña de ${users.displayName(name)} actualizada`);
    } catch (err) {
      back(res, err.message, true);
    }
  });

  // Audio: llega el archivo tal cual (cualquier formato del celular) y se convierte a nota de voz OGG Opus
  app.post('/disponibilidad/audio', auth, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    const name = String(req.query.user || '');
    const slot = String(req.query.slot || '');
    if (!users.get(name) || !users.canManage(req.actor, name)) return res.status(403).json({ error: 'Sin permiso' });
    if (name === CENTRAL || !users.AUDIO_SLOTS[slot]) return res.status(400).json({ error: 'Audio inválido' });
    if (!req.body?.length) return res.status(400).json({ error: 'No llegó ningún archivo' });
    try {
      const { buffer, seconds } = await convertAudio(req.body);
      await users.setAudio(name, slot, buffer.toString('base64'));
      console.log(`🎙️  Audio ${slot} de ${name} actualizado (${seconds.toFixed(1)} s, por ${req.actor})`);
      tellAdmin(req.actor, `🎙️ ${users.displayName(name)} subió un audio nuevo (${users.AUDIO_SLOTS[slot]}, ${Math.round(seconds)} s)`);
      res.json({ ok: true, seconds });
    } catch (err) {
      console.error(`❌ No se pudo procesar el audio de ${name}:`, err.message);
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/disponibilidad/audio', auth, async (req, res) => {
    const name = String(req.query.user || '');
    const slot = String(req.query.slot || '');
    if (!req.actor || !users.get(name) || !users.canManage(req.actor, name)) return res.status(403).end();
    const audio = await getAudio(name, slot);
    if (!audio) return res.status(404).end();
    res.type('audio/ogg').send(Buffer.from(audio.base64, 'base64'));
  });

  app.post('/disponibilidad/audio/borrar', form, auth, async (req, res) => {
    const name = target(req, res); if (!name) return;
    const slot = String(req.body.slot);
    if (!users.AUDIO_SLOTS[slot]) return back(res, 'Audio inválido', true);
    await users.deleteAudio(name, slot);
    back(res, `Audio quitado. ${AUDIO_BASE_PATH_FOR(name, slot) ? 'Vuelve a usarse el audio anterior de esta persona.' : 'Se enviará solo el texto.'}`);
  });

  // Reconexión: crea la instancia si no existe y entrega QR + código de 8 caracteres
  app.post('/disponibilidad/conectar', express.json(), auth, async (req, res) => {
    const name = String(req.body?.user || '');
    if (!users.get(name) || !users.canManage(req.actor, name)) return res.status(403).json({ error: 'Sin permiso' });
    const wait = (lastConnectRequest.get(name) || 0) + RECONNECT_COOLDOWN_MS - Date.now();
    if (wait > 0) return res.status(429).json({ error: `Espera ${Math.ceil(wait / 1000)} s antes de pedir otro código (para no bloquear el número).` });
    const profile = users.get(name);
    if (!profile.phone) return res.status(400).json({ error: 'Falta el teléfono de esta persona' });
    lastConnectRequest.set(name, Date.now());
    try {
      const instance = getExecutiveInstance(name);
      const state = await instanceState(instance);
      if (state === 'missing') await createInstance(instance);
      const result = await connectInstance(instance, profile.phone);
      console.log(`🔌 Código de vinculación pedido para ${name} (por ${req.actor})`);
      res.json(result);
    } catch (err) {
      console.error(`❌ No se pudo pedir el código de ${name}:`, err.response?.status || err.message);
      res.status(502).json({ error: 'Evolution no respondió. Intenta de nuevo en un minuto.' });
    }
  });

  app.post('/disponibilidad/usuarios', form, auth, async (req, res) => {
    if (!users.isAdmin(req.actor)) return res.status(403).send(page('<div class="card">Solo los admins crean usuarios.</div>'));
    const { displayName, role, phone, ghlUserId, password } = req.body;
    const start = toMinutes(req.body.start);
    const end = toMinutes(req.body.end);
    if (String(password || '').length < 6) return back(res, 'La contraseña inicial debe tener al menos 6 caracteres', true);
    if ((req.body.start || req.body.end) && (start === null || end === null || end <= start)) return back(res, 'Horario inválido', true);
    const digits = String(phone || '').replace(/\D/g, '');
    try {
      const created = await users.create({
        displayName: String(displayName).trim(), role, phone: digits, ghlUserId: String(ghlUserId || '').trim() || null,
        instance: instanceName(displayName), schedule: start !== null && end !== null ? { start, end } : null
      });
      await users.setPassword(created.username, String(password));
      const instance = getExecutiveInstance(created.username);
      if (await instanceState(instance) === 'missing') await createInstance(instance).catch(err =>
        console.error(`❌ No se pudo crear la instancia de ${created.username}:`, err.response?.status || err.message));
      console.log(`👤 Usuario creado: ${created.username} (${created.role}, por ${req.actor})`);
      tellAdmin(req.actor, `👤 ${users.displayName(req.actor)} creó el usuario ${created.displayName}`);
      back(res, `Usuario ${created.displayName} creado. Usuario: ${created.username}. Ahora vincula su WhatsApp con Reconectar.`);
    } catch (err) {
      back(res, err.message, true);
    }
  });
};

// Script del navegador: subir audios y pedir el código de vinculación sin recargar la página
const PANEL_SCRIPT = `
document.querySelectorAll('.upload').forEach(btn => btn.addEventListener('click', async () => {
  const box = btn.closest('.slot'); const input = box.querySelector('.audio-input'); const status = box.querySelector('.status');
  if (!input.files.length) { status.textContent = 'Elige un archivo primero.'; return; }
  btn.disabled = true; status.textContent = 'Subiendo y convirtiendo…';
  try {
    const r = await fetch('/disponibilidad/audio?user=' + encodeURIComponent(input.dataset.user) + '&slot=' + input.dataset.slot,
      { method: 'POST', body: input.files[0], headers: { 'Content-Type': input.files[0].type || 'application/octet-stream' } });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error');
    location.href = '/disponibilidad?m=' + encodeURIComponent('Audio guardado (' + Math.round(data.seconds) + ' s)');
  } catch (e) { status.textContent = '❌ ' + e.message; btn.disabled = false; }
}));
document.querySelectorAll('.reconnect').forEach(btn => btn.addEventListener('click', async () => {
  const box = btn.parentElement.querySelector('.pair'); btn.disabled = true; box.textContent = 'Pidiendo código…';
  try {
    const r = await fetch('/disponibilidad/conectar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: btn.dataset.user }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error');
    if (data.state === 'open') { box.innerHTML = '<p class="hint">✅ Ya está conectado.</p>'; return; }
    box.innerHTML = (data.pairingCode ? '<p class="hint">Código para "Vincular con número de teléfono":</p><div class="code"></div>' : '')
      + (data.qr ? '<p class="hint">O escanea este QR desde WhatsApp → Dispositivos vinculados:</p><img class="qr" alt="QR">' : '')
      + '<p class="hint">El código dura poco. Cuando el celular confirme, toca actualizar arriba.</p>';
    if (data.pairingCode) box.querySelector('.code').textContent = data.pairingCode;
    if (data.qr) box.querySelector('.qr').src = data.qr;
  } catch (e) { box.textContent = '❌ ' + e.message; }
  finally { setTimeout(() => { btn.disabled = false; }, 60000); }
}));`;
