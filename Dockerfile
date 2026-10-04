# AAS 저작·배포·수집 통합 플랫폼 — 단일 이미지
#
# API와 저작 UI를 **한 컨테이너·한 포트**로 낸다. 배포처가 폐쇄망 공장 서버라
# (기획서 Ⅷ) 반입·기동·점검이 한 번에 끝나는 편이 낫고, 같은 출처가 되어 CORS도 없다.
#
# 2단계로 나눈 이유: 빌드 도구(typescript·vite·테스트 의존성)는 운영 이미지에 남길 이유가 없다.

# ── 1단계: 빌드 ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 잠금 파일까지 그대로 복사해 **정확히 같은 판**을 설치한다(npm ci)
COPY package.json package-lock.json ./
COPY packages/aas-core/package.json  packages/aas-core/
COPY packages/aasx/package.json      packages/aasx/
COPY packages/linter/package.json    packages/linter/
COPY packages/store/package.json     packages/store/
COPY packages/collector/package.json packages/collector/
COPY packages/opcua/package.json     packages/opcua/
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
RUN npm ci

COPY . .
RUN npm run build && npm run --silent build --workspace @aas/web

# ── 2단계: 운영 ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 운영에 필요한 의존성만. 빌드 도구는 넘어오지 않는다
COPY package.json package-lock.json ./
COPY packages/aas-core/package.json  packages/aas-core/
COPY packages/aasx/package.json      packages/aasx/
COPY packages/linter/package.json    packages/linter/
COPY packages/store/package.json     packages/store/
COPY packages/collector/package.json packages/collector/
COPY packages/opcua/package.json     packages/opcua/
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
RUN npm ci --omit=dev --workspace @aas/api --include-workspace-root

# 빌드 결과만 가져온다
COPY --from=build /app/packages/aas-core/dist  packages/aas-core/dist
COPY --from=build /app/packages/aasx/dist      packages/aasx/dist
COPY --from=build /app/packages/linter/dist    packages/linter/dist
COPY --from=build /app/packages/store/dist     packages/store/dist
COPY --from=build /app/packages/collector/dist packages/collector/dist
COPY --from=build /app/packages/opcua/dist     packages/opcua/dist
COPY --from=build /app/apps/api/dist           apps/api/dist
COPY --from=build /app/apps/web/dist           apps/web/dist

# 🔴 root로 돌리지 않는다. 업로드된 AASX를 푸는 프로세스다 — 권한을 줄여 둔다
USER node

ENV PORT=8080
ENV WEB_ROOT=/app/apps/web/dist
EXPOSE 8080

# 인증이 꺼진 채 뜨면 기동 로그가 경고한다(apps/api/src/auth.ts)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
