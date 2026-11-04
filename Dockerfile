# tokenyard image: the committed single-file bundle on Node 24, run as a non-root user.
# Build: npm run build && docker build -t tokenyard:dev .   (the build context holds only bin/ and deploy/, see .dockerignore)
# Run it with a read-only root filesystem; the one writable place is /var/lib/tokenyard (traces, policy state).
FROM node:24-slim

RUN install -d -o node -g node /var/lib/tokenyard /app
WORKDIR /var/lib/tokenyard
COPY --chown=root:root bin/tokenyard.mjs /app/bin/tokenyard.mjs
COPY --chown=root:root deploy /app/deploy

USER node
VOLUME /var/lib/tokenyard
ENTRYPOINT ["node", "/app/bin/tokenyard.mjs"]
CMD ["--help"]
