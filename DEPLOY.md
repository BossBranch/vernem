# Развёртывание на VPS (≈ 20 минут)

Нужно: VPS в России (152-ФЗ: в заявлениях есть ФИО и адрес), Ubuntu 22.04/24.04, 1 vCPU, 1 ГБ RAM. Для мини-приложения и webhook нужен домен или поддомен.

## 1. Сервер и Docker

```bash
ssh root@IP_СЕРВЕРА
apt update && apt -y upgrade
curl -fsSL https://get.docker.com | sh      # официальный скрипт Docker
docker compose version                      # нужна 2.24+
```

## 2. Домен

В DNS создайте A-запись `vernem.ваш-домен.ru` → IP сервера. Проверка: `ping vernem.ваш-домен.ru` должен показывать IP сервера. Если домена пока нет, пропустите: бот будет работать через long polling, но без мини-приложения.

## 3. Код и секреты

```bash
git clone <URL_РЕПОЗИТОРИЯ> vernem && cd vernem
cp .env.example .env
nano .env
```

Заполните:

```
MAX_BOT_TOKEN=<токен от организаторов>
PUBLIC_URL=https://vernem.ваш-домен.ru
DOMAIN=vernem.ваш-домен.ru
MINIAPP_ENABLED=true
DEMO_MODE=true
ADMIN_IDS=<ваш user_id в MAX>
```

Проверьте, что `.env` не попадёт в git: `git status` не должен его показывать.

## 4. Запуск

```bash
docker compose --profile https up -d --build     # с доменом: webhook + мини-приложение
# или без домена:
docker compose up -d --build                     # long polling
docker compose logs -f app                       # ждём «бот запущен: running (webhook)»
curl -s https://vernem.ваш-домен.ru/health       # {"ok":true,...,"bot":"running (webhook)"}
```

`restart: unless-stopped` перезапускает контейнеры после сбоя и перезагрузки сервера.

## 5. Мини-приложение в кабинете MAX

В кабинете MAX для партнёров (business.max.ru → Чат-боты → ваш бот → расширенные настройки) укажите URL мини-приложения `https://vernem.ваш-домен.ru/app/`. После этого кнопки «📱 Мои случаи» в боте открывают приложение. Проверьте в мобильном и веб-клиенте MAX: кейс требует, чтобы функциональность работала в обоих.

## 6. Перед сдачей

- Прогнать сценарий из README («Как проверить») в мобильном и веб-MAX, 2–3 раза подряд.
- Замерить сборку с нуля: `docker compose build --no-cache` должна уложиться в 5 минут.
- Зафиксировать commit hash: `git rev-parse HEAD`.
- **После дедлайна не обновлять код на сервере** до объявления финалистов.
- Токен вписать только на первый слайд PDF-презентации.

## Обновление и резервная копия

```bash
git pull && docker compose --profile https up -d --build

# Консистентная копия БД (VACUUM INTO), затем забираем её с сервера
docker compose exec app rm -f /app/data/backup.db
docker compose exec app node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('/app/data/vernem.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker compose cp app:/app/data/backup.db ./backup-$(date +%F).db
```

## CI/CD

GitHub Actions проверяет pull request и `main` через `npm run typecheck`, `npm test`, `npm run build` и Docker-сборку. Production не обновляется по push: workflow **Deploy Production** запускается вручную и требует ввести `DEPLOY`.

До включения workflow на VPS нужно установить root-owned скрипты из `deploy/deploy-vernem` и `deploy/vernem-ssh-wrapper`, создать ограниченного пользователя `deploy` и отдельный SSH-ключ. Подробная процедура: [`deploy/CI-CD.md`](deploy/CI-CD.md). Секреты MAX остаются только в `/opt/vernem/.env` и не добавляются в GitHub Secrets.

При успешном deployment скрипт сохраняет один rollback-образ, до 14 консистентных копий SQLite в `/opt/vernem-backups`, ограничивает build cache 1 ГБ и удаляет только dangling images. Volumes SQLite и Caddy автоматически не удаляются.
