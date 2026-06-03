FROM node:18-alpine

WORKDIR /usr/src/app

# Install build dependencies for sqlite3 (native addon compilations)
RUN apk add --no-cache python3 make g++

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 8080

# Environment variable to control port if needed
ENV PORT=8080

CMD ["npm", "start"]
