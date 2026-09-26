# 🚀 Maihue Webhook Server

Servidor Node.js para integrar GoHighLevel con Evolution API (WhatsApp).

**Flujo:**
```
GHL (Oportunidad) → Webhook → Este servidor → Evolution API → WhatsApp ejecutivo
```

---

## 📋 Requisitos

- [x] Evolution API deployado en Railway
- [x] Redis en Railway
- [x] Postgres en Railway (opcional, para logging futuro)
- [x] Audio grabado (formato AAC, MP3, WAV)
- [ ] Repositorio GitHub
- [ ] Cuenta de Railway

---

## 🔧 Configuración Inicial

### 1. Crear repositorio GitHub

```bash
# En tu máquina local
git clone https://github.com/tu-usuario/maihue-webhook-server.git
cd maihue-webhook-server

# Copiar archivos
cp .env.example .env
```

### 2. Configurar Railway

**Opción A: Desde Railway Dashboard**

1. Ir a tu proyecto de Railway
2. Click en **"New" → "GitHub Repo"**
3. Seleccionar el repositorio `maihue-webhook-server`
4. Railway detectará automáticamente el Dockerfile
5. Click en **"Deploy"**

**Opción B: Desde Railway CLI**

```bash
npm install -g @railway/cli

railway init
railway up
```

---

## 🔐 Variables de Entorno en Railway

Una vez deployado, ve a **Settings** del servicio y configura:

```
EVOLUTION_API_URL=https://evolution-api-production-0237.up.railway.app
INSTANCE_ID=9C60DB508943-4380-855D-F5E612394CF5
EVOLUTION_API_KEY=tu-api-key-aqui

REDIS_HOST=redis (o el nombre del servicio Redis en Railway)
REDIS_PORT=6379
REDIS_PASSWORD=(si lo tienes)

VOLKANIA_FORM_URL=https://tu-ghl-domain.com/volkania
TRICALEN_FORM_URL=https://tu-ghl-domain.com/tricalen

AUDIO_PATH=/app/audios/audio_pdo_gerardo.aac
```

---

## 📁 Subir el Audio a Railway

### Opción 1: Volumen Persistente (Recomendado)

1. En Railway, ve al servicio **maihue-webhook-server**
2. Click en **"Volume"** → **"+ New Volume"**
3. Nombre: `audios-volume`
4. Mount path: `/app/audios`
5. Una vez creado, usar el CLI o SFTP para subir el archivo:

```bash
railway shell

# Dentro del contenedor
cd /app/audios
# Pegar aquí el archivo audio_pdo_gerardo.aac
```

### Opción 2: Inline en Dockerfile (No recomendado)

Agregar el audio dentro del repositorio:
```
maihue-webhook-server/
├── audios/
│   └── audio_pdo_gerardo.aac
├── server.js
└── Dockerfile
```

---

## 📞 Obtener API Key de Evolution API

Si no la tienes:

1. Abre el dashboard de Evolution API
2. Ve a **Settings** o **API**
3. Genera una nueva **API Key**
4. Configura en Railway como `EVOLUTION_API_KEY`

---

## 🧪 Pruebas Rápidas

### 1. Health Check

```bash
curl https://maihue-webhook-server-production.up.railway.app/health
```

Respuesta esperada:
```json
{
  "status": "online",
  "timestamp": "2024-01-15T10:30:00Z",
  "instance": "9C60DB508943-4380-855D-F5E612394CF5"
}
```

### 2. Enviar Mensaje de Prueba

```bash
curl -X POST https://maihue-webhook-server-production.up.railway.app/test/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "56961451738",
    "message": "Hola Gerardo, este es un mensaje de prueba"
  }'
```

### 3. Enviar Audio de Prueba

```bash
curl -X POST https://maihue-webhook-server-production.up.railway.app/test/send-audio \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "56961451738"
  }'
```

### 4. Ver Estado de Round Robin

```bash
curl https://maihue-webhook-server-production.up.railway.app/debug/round-robin
```

---

## 🔗 Configurar Webhook en GoHighLevel

### 1. En GHL, ir a **Automations**

- Crear un nuevo workflow
- Trigger: **"Oportunidad Creada"** o **"Lead Calificado"**

### 2. Agregar acción: **Webhook**

- **URL:** `https://maihue-webhook-server-production.up.railway.app/webhook/ghl`
- **Método:** POST
- **Headers:**
  ```
  Content-Type: application/json
  ```
- **Body:** (mapear los campos de GHL)
  ```json
  {
    "contactName": "{{contactName}}",
    "contactPhone": "{{contactPhone}}",
    "contactId": "{{contactId}}",
    "opportunityId": "{{opportunityId}}",
    "formUrl": "{{formUrl}}",
    "project": "volkania"  // O "tricalen"
  }
  ```

### 3. Guardar y activar el workflow

---

## 📊 Lógica de Asignación

### Volkania (Round Robin)
```
Lead 1 → Gerardo
Lead 2 → Josefina
Lead 3 → Gerardo
Lead 4 → Josefina
...
```

*El estado se guarda en Redis con la clave: `volkania:round_robin:last`*

### Tricalén (Fijo)
```
Todos los leads → Carolina
```

---

## 🔄 Flujo de Mensajes

```
1. GHL crea oportunidad
   ↓
2. GHL dispara webhook → Servidor
   ↓
3. Servidor identifica proyecto (Volkania/Tricalén)
   ↓
4. Asigna ejecutivo (Round Robin o Carolina)
   ↓
5. Envía mensaje de texto vía Evolution API
   ↓
6. Espera 120 segundos
   ↓
7. Envía audio de bienvenida
   ↓
8. Ejecutivo recibe en su WhatsApp
   ↓
9. Ejecutivo responde y continúa conversación
```

---

## 📝 Estructura de Archivos

```
maihue-webhook-server/
├── server.js              # Código principal
├── package.json           # Dependencias
├── Dockerfile             # Configuración Docker
├── railway.json           # Configuración Railway
├── .env.example           # Variables de entorno (ejemplo)
├── .gitignore             # (crear)
└── README.md              # Este archivo
```

### .gitignore

```
node_modules/
.env
.DS_Store
*.log
```

---

## 🐛 Troubleshooting

### "Conexión rechazada con Evolution API"
- Verificar `EVOLUTION_API_URL`
- Verificar `INSTANCE_ID`
- Verificar `EVOLUTION_API_KEY`
- Verificar que Evolution API esté online en Railway

### "Redis no conecta"
- Verificar `REDIS_HOST` y `REDIS_PORT`
- Verificar contraseña (si aplica)
- Verificar que Redis esté en el mismo proyecto de Railway

### "Audio no se envía"
- Verificar que el archivo existe en `/app/audios/`
- Verificar formato (AAC, MP3, WAV)
- Verificar permisos del archivo

### "Round Robin no funciona"
- Verificar Redis está conectado: `GET /debug/round-robin`
- Limpiar Redis si es necesario: `redis-cli FLUSHDB`

---

## 📞 Próximos Pasos

- [ ] Conectar números de Josefina y Carolina en Evolution API
- [ ] Actualizar la variable `EXECUTIVES` en `server.js` con sus números
- [ ] Crear formularios en GHL para Volkania y Tricalén
- [ ] Configurar webhooks en GHL
- [ ] Hacer pruebas end-to-end
- [ ] Agregar logging a base de datos
- [ ] Configurar alertas

---

## 📚 Documentación

- [Evolution API Docs](https://github.com/EvolutionAPI/evolution-api)
- [Railway Docs](https://docs.railway.app/)
- [GoHighLevel API](https://ghl.api-docs.io/)

---

**Última actualización:** Enero 2025  
**Desarrollador:** Maihue SpA
