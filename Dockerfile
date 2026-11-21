FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ribalka3d.html models.js ./
ENV PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
