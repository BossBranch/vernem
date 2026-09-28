# Развёртывание на сервере

Нужен сервер в России (в заявлениях есть ФИО и адрес, это требование 152-ФЗ), Ubuntu 22.04 или 24.04, 1 vCPU и 1 ГБ памяти. Для мини-приложения и webhook нужен домен или поддомен. На всё уходит минут двадцать.

## 1. Сервер и Docker

```bash
ssh root@IP_СЕРВЕРА
apt update && apt -y upgrade
curl -fsSL https://get.docker.com | sh      # официальный скрипт Docker
docker compose version                      # нужна 2.24 или новее
```

## 2. Домен

Создайте A-запись `vernem.ваш-домен.ru` с IP сервера. Проверить можно так: `ping vernem.ваш-домен.ru` должен показать IP сервера. Без домена бот тоже заработает (через long polling), но без мини-приложения.

## 3. Код и настройки

```bash
git clone https://github.com/BossBranch/vernem.git vernem && cd vernem
cp .env.example .env
nano .env
```

Заполните:

```
MAX_BOT_TOKEN=<токен бота>
PUBLIC_URL=https://vernem.ваш-домен.ru
DOMAIN=vernem.ваш-домен.ru
MINIAPP_ENABLED=true
DEMO_MODE=true
ADMIN_IDS=<ваш ID в MAX>
```

Файл `.env` в git не попадает, `git status` его не показывает.

## 4. Запуск

```bash
docker compose --profile https up -d --build     # с доменом: webhook и мини-приложение
# или без домена:
docker compose up -d --build                     # long polling
docker compose logs -f app                       # ждём «бот запущен: running (webhook)»
curl -s https://vernem.ваш-домен.ru/health       # {"ok":true,...,"bot":"running (webhook)"}
```

Контейнеры сами перезапускаются после сбоя и перезагрузки сервера.

## 5. Мини-приложение

Адрес мини-приложения: `https://vernem.ваш-домен.ru/app/`. Его привязывают к боту в кабинете MAX для партнёров (для бота хакатона это делают организаторы). После этого первой кнопкой в меню бота становится «📱 Открыть приложение». Проверьте и в телефоне, и в веб-версии MAX.

## Обновление и резервная копия

```bash
git pull && docker compose --profile https up -d --build

# Копия базы: делаем её внутри контейнера и забираем на сервер
docker compose exec app rm -f /app/data/backup.db
docker compose exec app node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('/app/data/vernem.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker compose cp app:/app/data/backup.db ./backup-$(date +%F).db
```

Сборка образа с нуля занимает меньше минуты.

## CI/CD

GitHub Actions проверяет каждый push и pull request: типы, тесты, сборку и Docker-образ. На сервер код сам не выкатывается. Для этого есть отдельный workflow **Deploy Production**: его запускают вручную и подтверждают словом `DEPLOY`.

Перед первым запуском на сервере ставятся скрипты из `deploy/deploy-vernem` и `deploy/vernem-ssh-wrapper`, создаётся пользователь `deploy` с отдельным SSH-ключом. Подробно — в [`deploy/CI-CD.md`](deploy/CI-CD.md). Токен MAX хранится только в `/opt/vernem/.env` на сервере, в GitHub его нет.

После удачного деплоя скрипт хранит предыдущий образ для отката и до 14 копий базы в `/opt/vernem-backups`. Если новая версия не прошла проверку здоровья, он сам возвращает предыдущую. Тома с базой и сертификатами не удаляются.
