FROM node:20-alpine

# Seteamos TZ (opcional pero útil para logs)
ENV TZ=America/Argentina/San_Juan
WORKDIR /usr/src/app

# Dependencias
COPY package*.json ./
RUN npm ci --only=production

# Código
COPY . .

# Usá el mismo puerto que en .env (CapRover mapea igual)
EXPOSE 3001

# Seguridad básica de Node
ENV NODE_ENV=production

CMD ["node", "server.js"]
