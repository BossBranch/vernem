# CI/CD production

CI запускается автоматически для pull request и `main`. Production обновляется только вручную через GitHub Actions. MAX-токен, `.env`, SQLite и сертификаты Caddy остаются на VPS.

## 1. Ключ GitHub Actions

На компьютере создайте отдельный ключ без passphrase. Не используйте ключ администратора или deploy key, которым VPS читает GitHub.

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\vernem_github_actions" -C "github-actions-vernem"
```

На оба вопроса о passphrase нажмите Enter. Публичный ключ:

```powershell
Get-Content "$env:USERPROFILE\.ssh\vernem_github_actions.pub"
```

Приватный ключ будет добавлен в GitHub Secret. Не отправляйте его в чат и не коммитьте.

## 2. Ограниченный пользователь на VPS

Под `root` на VPS установите скрипты из уже развёрнутого commit и создайте пользователя:

```bash
cd /opt/vernem
install -o root -g root -m 750 deploy/deploy-vernem /usr/local/sbin/deploy-vernem
install -o root -g root -m 755 deploy/vernem-ssh-wrapper /usr/local/sbin/vernem-ssh-wrapper
useradd --create-home --shell /bin/sh deploy
passwd --lock deploy
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
```

Создайте `/home/deploy/.ssh/authorized_keys`:

```bash
nano /home/deploy/.ssh/authorized_keys
```

Вставьте одну строку, заменив `ssh-ed25519 ...` публичным ключом из шага 1:

```text
restrict,command="/usr/local/sbin/vernem-ssh-wrapper" ssh-ed25519 ... github-actions-vernem
```

Сохраните и задайте права:

```bash
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
printf 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/deploy-vernem\n' > /etc/sudoers.d/vernem-deploy
chmod 440 /etc/sudoers.d/vernem-deploy
visudo -cf /etc/sudoers.d/vernem-deploy
```

Ключ не получит shell, port forwarding или произвольный sudo. Он сможет вызвать только `deploy <commit SHA>`.

## 3. Проверка SSH host key

На VPS посмотрите fingerprint ключа SSH:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

На компьютере сохраните ключ сервера по домену:

```powershell
ssh-keyscan -H -t ed25519 vernem.xyz > "$env:TEMP\vernem_known_hosts"
ssh-keygen -lf "$env:TEMP\vernem_known_hosts"
Get-Content "$env:TEMP\vernem_known_hosts"
```

Fingerprint на компьютере должен совпасть с fingerprint на VPS. Содержимое `vernem_known_hosts` понадобится для GitHub Secret.

## 4. GitHub Secrets

В репозитории откройте **Settings -> Secrets and variables -> Actions** и добавьте repository secrets:

| Secret | Значение |
|---|---|
| `VPS_HOST` | `vernem.xyz` |
| `VPS_PORT` | `22` |
| `VPS_USER` | `deploy` |
| `VPS_SSH_PRIVATE_KEY` | содержимое `vernem_github_actions` без `.pub` |
| `VPS_KNOWN_HOSTS` | содержимое `vernem_known_hosts` |

Не добавляйте `MAX_BOT_TOKEN`, `.env`, данные SQLite или ключ, которым VPS читает GitHub.

В **Settings -> Environments** создайте `production`. Если в тарифе доступны protection rules, включите required reviewer: это добавит второе подтверждение перед подключением Actions к VPS.

## 5. Первый запуск

Закоммитьте и отправьте workflow. Вкладка **Actions** должна показать успешный workflow `CI` для `main`.

Для production откройте **Actions -> Deploy Production -> Run workflow**:

1. В `ref` оставьте `main` или укажите конкретный commit SHA из `main`.
2. В `confirm` введите `DEPLOY`.
3. Запустите workflow.

Скрипт VPS откажется от commit вне `origin/main`, от параллельного запуска, от грязной рабочей копии, от свободного места менее 2 ГБ или от неработающего текущего контейнера.

После deployment проверьте:

```bash
curl -fsS https://vernem.xyz/health
docker compose --profile https ps
docker image ls vernem-bot
```

## 6. Обслуживание

Скрипт держит текущий образ `vernem-bot:current`, один `vernem-bot:rollback`, 14 резервных копий SQLite в `/opt/vernem-backups` и build cache до 1 ГБ. Он не удаляет Docker volumes.

Если менялись `deploy/deploy-vernem` или `deploy/vernem-ssh-wrapper`, установите обновлённые файлы под `root` повторно командами из шага 2. После дедлайна удалите public key GitHub Actions из `authorized_keys` или отключите workflow deployment. Это не остановит работающий бот.
