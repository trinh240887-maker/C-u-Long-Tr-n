# Chạy app trên máy chủ cloud (Railway, Render, VPS có Docker…)
# Dữ liệu lưu ở /data: trên Railway tạo Volume gắn vào /data (không dùng lệnh VOLUME, Railway không hỗ trợ)
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
