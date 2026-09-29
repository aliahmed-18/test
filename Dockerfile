# Single image: builds the React app and the Go server, which serves both.
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM golang:1.25-alpine AS api
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
RUN CGO_ENABLED=0 go build -o /getit-server .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=api /getit-server /usr/local/bin/getit-server
COPY --from=web /app/dist /srv/web
ENV STATIC_DIR=/srv/web PORT=8080
EXPOSE 8080
CMD ["getit-server"]
