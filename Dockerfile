FROM node:18-alpine

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm ci --only=production

# Copiar código
COPY . .

# Crear directorio para audios
RUN mkdir -p /app/audios

# Exponer puerto
EXPOSE 3000

# Comando para iniciar
CMD ["npm", "start"]
