# 🎯 PRÓXIMOS PASOS - Checklist Final

Aquí está todo lo que necesitas hacer para poner en marcha el sistema.

---

## 📋 RESUMEN DE LO QUE GENERAMOS

✅ **Servidor Node.js completo** para recibir webhooks de GHL  
✅ **Integración con Evolution API** para enviar WhatsApp  
✅ **Lógica de Round Robin** para Volkania  
✅ **Audio de bienvenida** subido y listo  
✅ **Redis para manejo de turnos**  
✅ **Documentación completa**  

---

## 🚀 AHORA: PASOS A SEGUIR

### PASO 1: Subir código a GitHub (5 minutos)

```bash
# En tu terminal
git clone https://github.com/tu-usuario/maihue-webhook-server.git
cd maihue-webhook-server

# Copiar todos estos archivos a esa carpeta:
# - server.js
# - package.json
# - Dockerfile
# - railway.json
# - .env.example
# - .gitignore
# - README.md
# - DEPLOY_RAILWAY.md
# - ARQUITECTURA.md
# - audios/audio_pdo_gerardo.aac

# Subir a GitHub
git add .
git commit -m "Initial: Maihue webhook server"
git push origin main
```

---

### PASO 2: Desplegar en Railway (10 minutos)

**En Railway Dashboard:**

1. Ve a tu proyecto: https://railway.com/project/ad0ed790-8272-4669-9c14-ec22c8633252
2. Click **"New"** → **"GitHub Repo"**
3. Busca `maihue-webhook-server`
4. Click **"Deploy"**
5. Espera a que se construya (~3-5 minutos)

**Resultado esperado:**
- ✅ Build successful
- ✅ Servicio online

---

### PASO 3: Configurar Variables de Entorno (5 minutos)

**En Railway, en el servicio `maihue-webhook-server`:**

1. Click en **"Variables"**
2. Agregar estas variables:

```
EVOLUTION_API_URL = https://evolution-api-production-0237.up.railway.app
INSTANCE_ID = 9C60DB508943-4380-855D-F5E612394CF5
EVOLUTION_API_KEY = [OBTENER ABAJO]
REDIS_HOST = redis
REDIS_PORT = 6379
VOLKANIA_FORM_URL = [TU URL DE FORMULARIO]
TRICALEN_FORM_URL = [TU URL DE FORMULARIO]
AUDIO_PATH = /app/audios/audio_pdo_gerardo.aac
```

**¿Dónde obtener `EVOLUTION_API_KEY`?**

1. Abre tu Evolution API: https://evolution-api-production-0237.up.railway.app
2. Busca **Settings** o **API**
3. Genera una **New API Key**
4. Copia y pégala en Railway

---

### PASO 4: Cargar el Audio (5 minutos)

**Opción A: Volumen Persistente (Recomendado)**

```bash
# En terminal (con Railway CLI)
railway shell

# Dentro del contenedor
cd /app/audios
# Pegar el archivo aquí (o hacer upload)
```

**Opción B: Incluir en Dockerfile**

Agregar esto al inicio del repositorio:

```
maihue-webhook-server/
├── audios/
│   └── audio_pdo_gerardo.aac  ← AQUÍ
├── server.js
└── ...
```

Luego hacer `git push` para redeployar.

---

### PASO 5: Pruebas (10 minutos)

#### 5.1 Health Check
```bash
curl https://[TU-URL].up.railway.app/health
```

Debería ver:
```json
{"status":"online","instance":"9C60DB508943..."}
```

#### 5.2 Enviar Mensaje de Prueba
```bash
curl -X POST https://[TU-URL].up.railway.app/test/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "56961451738",
    "message": "Hola Gerardo, prueba del servidor"
  }'
```

**Resultado:** Recibes un WhatsApp en tu número

#### 5.3 Enviar Audio de Prueba
```bash
curl -X POST https://[TU-URL].up.railway.app/test/send-audio \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "56961451738"}'
```

**Resultado:** Espera 120 segundos, luego recibes el audio

#### 5.4 Ver Round Robin
```bash
curl https://[TU-URL].up.railway.app/debug/round-robin
```

**Resultado:**
```json
{"lastExecutive":"gerardo"}
```

---

### PASO 6: Configurar Webhook en GoHighLevel (15 minutos)

**EN GOHIGHLEVEL:**

1. Ve a **Automations** → **Create Workflow**
2. Nombre: `Maihue - Asignar Lead Volkania`
3. Trigger: **Opportunity Created**
4. Click **"+ Add Action"** → **Webhook**

**Configurar Webhook:**

```
URL: https://[TU-URL].up.railway.app/webhook/ghl

Method: POST

Headers:
  Content-Type: application/json

Body (raw JSON):
{
  "contactName": "{{contactFirstName}} {{contactLastName}}",
  "contactPhone": "{{contactPhone}}",
  "contactId": "{{contactId}}",
  "opportunityId": "{{opportunityId}}",
  "formUrl": "{{formUrl}}",
  "project": "volkania"
}
```

**Guardar y activar** el workflow.

**Repetir para Tricalén:**
- Mismo webhook
- Cambiar `"project": "tricalen"`

---

### PASO 7: Test End-to-End (10 minutos)

**En GHL:**

1. Crear un contacto de prueba
2. Nombre: "Test Volkania"
3. Teléfono: Tu número real
4. Crear oportunidad desde ese contacto

**Resultado esperado:**

```
T=0s    Webhook se dispara
T=1s    Recibes mensaje de texto en WhatsApp
T=121s  Recibes el audio
```

---

## 📊 ARQUITECTURA GENERAL

```
┌──────────────────┐
│  GoHighLevel     │
│  (Webhook)       │
└────────┬─────────┘
         │
         ↓
┌──────────────────────────────────┐
│  Railway Server                  │
│  (Webhook Receiver)              │
│  - Identifica proyecto           │
│  - Round Robin                   │
│  - Envía WhatsApp                │
└────────┬────────────────────────┘
         │
         ├─→ Evolution API → Meta WhatsApp API
         │
         └─→ Redis (guardando estado)
```

---

## 🚨 ERRORES COMUNES

### "502 Bad Gateway"
→ El servidor aún está deployando. Espera 5 minutos.

### "Cannot connect to Redis"
→ Verificar que `REDIS_HOST=redis` en variables

### "Evolution API not reachable"
→ Verificar `EVOLUTION_API_URL` y que Evolution esté online

### "Audio not found"
→ Verificar que está en `/app/audios/audio_pdo_gerardo.aac`

---

## 🎯 AHORA MISMO

1. **[5 min]** Sube código a GitHub
2. **[10 min]** Deploy en Railway
3. **[5 min]** Configura variables
4. **[5 min]** Carga audio
5. **[10 min]** Prueba endpoints
6. **[15 min]** Configura webhook en GHL
7. **[10 min]** Test end-to-end

**TOTAL: ~60 minutos**

---

## ✅ CUANDO LO TERMINES

Deberías tener:

```
✅ Servidor online en Railway
✅ Conectado a Evolution API
✅ Round Robin funcionando
✅ Audio cargado
✅ Webhook en GHL activo
✅ Mensaje de texto + audio llegando a WhatsApp
```

---

## 📞 URLS QUE NECESITARÁS MEMORIZAR

```
Railway Project:
https://railway.com/project/ad0ed790-8272-4669-9c14-ec22c8633252

Evolution API Dashboard:
https://evolution-api-production-0237.up.railway.app

Tu Servidor Webhook:
https://maihue-webhook-server-production.up.railway.app

GitHub Repo:
https://github.com/tu-usuario/maihue-webhook-server
```

---

## 🔮 FASE 2 (PRÓXIMA)

Una vez que Gerardo esté funcionando:

1. Conectar número de **Josefina** en Evolution API
2. Conectar número de **Carolina** en Evolution API
3. Actualizar la sección `EXECUTIVES` en `server.js`
4. Redeployar

---

## 📞 PREGUNTAS FRECUENTES

**P: ¿Necesito hacer algo más en Meta?**  
R: No. Evolution API maneja todo.

**P: ¿El Round Robin se reinicia si reinicio el servidor?**  
R: No. Redis lo guarda, así que persiste.

**P: ¿Puedo cambiar la latencia de 120 segundos?**  
R: Sí. En `server.js`, busca `120000` y cambia a lo que quieras (en milisegundos).

**P: ¿Y si alguien responde en WhatsApp?**  
R: Por ahora solo enviamos mensajes. Las respuestas quedan en Evolution API. Más adelante podemos conectarlas de vuelta a GHL.

**P: ¿Puedo tener múltiples audios?**  
R: Sí, pero primero haz funcionar este. Luego agrego lógica para seleccionar audios dinámicamente.

---

**¡Dale, que esto funciona! 🚀**

Avísame cuando hayas hecho el primer test y recibas el mensaje en WhatsApp.
