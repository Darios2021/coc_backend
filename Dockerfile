FROM node:18

# Crear directorio de la app
WORKDIR /usr/src/app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar dependencias
RUN npm install --production

# Copiar el resto del código
COPY . .

# Exponer el puerto (el que uses en tu server.js, ej: 3000)
EXPOSE 3000

# Comando de inicio
CMD ["npm", "start"]