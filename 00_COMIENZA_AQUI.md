# 🎯 MAIHUE - SISTEMA DE ASIGNACIÓN DE LEADS

## ¿Qué acabamos de construir?

Un sistema automatizado que:

1. **Recibe leads** de anuncios en Meta Ads (Volkania y Tricalén)
2. **Los valida** en GoHighLevel
3. **Los asigna automáticamente** a ejecutivos vía Round Robin o fijo
4. **Les envía un mensaje de bienvenida** + audio por WhatsApp
5. **Todo sucede en ~2 minutos**

---

## 📂 ARCHIVOS QUE TIENES

```
maihue-webhook-server/
├── 📖 00_COMIENZA_AQUI.md          ← TÚ ESTÁS AQUÍ
├── 🚀 PROXIMOS_PASOS.md           ← Lee esto después
├── 📋 DEPLOY_RAILWAY.md           ← Guía detallada de deployment
├── 🏗️  ARQUITECTURA.md             ← Diagrama del sistema
├── 📘 README.md                    ← Documentación técnica
│
├── server.js                       ← Código principal (Node.js)
├── package.json                    ← Dependencias
├── Dockerfile                      ← Imagen Docker
├── railway.json                    ← Configuración Railway
├── .env.example                    ← Variables de entorno
├── .gitignore                      ← Archivos a ignorar
│
└── audios/
    └── audio_pdo_gerardo.aac      ← Tu audio de bienvenida
```

---

## 🚀 COMIENZA AQUÍ (5 PASOS)

### 1️⃣ **Crea repositorio en GitHub** (5 min)

- Ve a github.com → New Repository
- Nombre: `maihue-webhook-server`
- Sube todos estos archivos

### 2️⃣ **Deploy en Railway** (10 min)

- Railway Dashboard → New → GitHub Repo
- Selecciona `maihue-webhook-server`
- Click Deploy
- **Espera a que esté online** ✅

### 3️⃣ **Configura Variables de Entorno** (5 min)

En Railway, agrega:

```
EVOLUTION_API_URL=https://evolution-api-production-0237.up.railway.app
INSTANCE_ID=9C60DB508943-4380-855D-F5E612394CF5
EVOLUTION_API_KEY=[OBTENER DE EVOLUTION API]
REDIS_HOST=redis
REDIS_PORT=6379
```

### 4️⃣ **Prueba** (10 min)

```bash
# Health check
curl https://[tu-url].up.railway.app/health

# Enviar mensaje de prueba
curl -X POST https://[tu-url].up.railway.app/test/send-message \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"56961451738","message":"Hola!"}'
```

### 5️⃣ **Configura Webhook en GoHighLevel** (15 min)

- GHL → Automations → New Workflow
- Trigger: "Opportunity Created"
- Action: Webhook
- URL: `https://[tu-url].up.railway.app/webhook/ghl`

---

## 🎯 RESULTADO FINAL

Cuando alguien haga clic en tu anuncio:

```
Cliente → Anuncio Meta Ads
   ↓
Cliente → Responde formulario GHL
   ↓
GHL crea Oportunidad
   ↓
Webhook → Tu servidor en Railway
   ↓
Servidor envía WhatsApp a Gerardo (tú)
   ↓
+ 120 segundos
   ↓
Servidor envía audio
   ↓
✅ Gerardo responde en WhatsApp
```

---

## 📊 FLUJO DE ASIGNACIÓN

### Para Volkania:
```
Lead 1 → Gerardo
Lead 2 → Josefina (cuando la conectes)
Lead 3 → Gerardo
Lead 4 → Josefina
...
```

### Para Tricalén:
```
Todos los leads → Carolina (cuando la conectes)
```

---

## 🔧 DATOS TÉCNICOS

- **Lenguaje:** Node.js
- **Framework:** Express
- **Base de datos:** Redis (para Round Robin)
- **API:** Evolution API (WhatsApp)
- **Hosting:** Railway

---

## ✅ CHECKLIST RÁPIDO

- [ ] Repositorio creado en GitHub
- [ ] Código uploadado
- [ ] Deployado en Railway
- [ ] Variables de entorno configuradas
- [ ] Webhook de GHL configurado
- [ ] Primera prueba exitosa

---

## 📖 ¿POR DÓNDE CONTINUAR?

### Para entender el sistema:
1. Lee `ARQUITECTURA.md` (diagrama visual)
2. Lee `README.md` (documentación técnica)

### Para hacer deployment:
1. Sigue `DEPLOY_RAILWAY.md` paso a paso
2. O usa `PROXIMOS_PASOS.md` como checklist rápido

### Para troubleshooting:
1. Consulta la sección de errores en `README.md`
2. Revisa los logs en Railway Dashboard

---

## 🎁 LO QUE ESTÁ INCLUIDO

✅ Servidor Node.js completo con validaciones  
✅ Integración Evolution API para WhatsApp  
✅ Lógica de Round Robin con Redis  
✅ Endpoints de prueba para debugging  
✅ Documentación completa  
✅ Audio de bienvenida listo  
✅ Dockerfile para deployment  
✅ Variables de entorno configurables  

---

## 🔮 PRÓXIMAS FASES

### Fase 2 (próxima semana):
- Conectar número de Josefina
- Conectar número de Carolina
- Redeployar

### Fase 3 (futuro):
- Webhooks inversos (respuestas → GHL)
- Dashboard de asignaciones
- Analytics por ejecutivo
- Alertas por Slack

---

## 💡 TIPS

1. **Guarda tus URLs:**
   - Railway Project
   - Servidor webhook
   - Evolution API

2. **Mantén Redis en línea:**
   - Es crucial para el Round Robin

3. **Prueba primero con tu número:**
   - Antes de agregar otros ejecutivos

4. **Revisa los logs constantemente:**
   - Railway Dashboard → Logs

---

## 🆘 ¿AYUDA?

**Errores más comunes:**
- 502 Bad Gateway → Esperá que se despliege
- Redis error → Verificá `REDIS_HOST`
- Evolution API error → Verificá `EVOLUTION_API_KEY`

Revisa `DEPLOY_RAILWAY.md` sección "Troubleshooting"

---

## 🎬 ¡AHORA!

👉 **Siguiente paso:** Abre `PROXIMOS_PASOS.md`

Ese archivo tiene un checklist paso a paso que necesitas seguir.

**Tiempo estimado: 60 minutos para estar 100% operativo.**

---

**Hecho con ❤️ para Maihue SpA**

Enero 2025
