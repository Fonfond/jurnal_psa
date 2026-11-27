# PILOT-RUN — локальный пилот Logbook

Короткий чек-лист. Подробная установка — [35_Руководство_по_установке.md](35_Руководство_по_установке.md), статус — [41_Пилотный_пакет.md](41_Пилотный_пакет.md).

> Это не production. Dev-вход и `SIGNATURE_PROVIDER=none` только для локальной проверки. Production-релиз не одобрен.

## 0. Что нужно

- Docker Desktop + Compose
- свободные порты 3000, 3443, 55432
- ПК и телефон в одной Wi-Fi-сети
- Edge/Chromium на ПК

## 1. Запуск

```powershell
docker compose -f docker-compose.pilot.yml up --build -d
docker compose -f docker-compose.pilot.yml ps
curl http://localhost:3000/v1/health
```

Ожидаемо:

- `logbook-pilot-db` — healthy;
- `logbook-pilot-seed` — exited 0, в логах `0001…0017`, `Seed complete ... ANALYZE done`;
- `logbook-pilot-app` — healthy;
- health: `{"status":"ok","db":"ok"}`.

Если 3000 занят:

```powershell
$env:APP_PORT=3100
docker compose -f docker-compose.pilot.yml up --build -d
```

## 2. Проверка на ПК

1. `http://localhost:3000/`.
2. Вход: `admin@logbook.local` / `Logbook!2026` (или `worker@logbook.local`, `supervisor@logbook.local`).
3. Проверить: журнал → создать запись → синхронизация → карточка → печать/CSV.
4. Админ: `http://localhost:3000/admin` (admin).
5. PWA: `localhost` — secure context; установить приложение из меню браузера.
6. Офлайн: DevTools → Network → Offline → reload; приложение должно открыться из SW, запись — в очередь.

## 3. Проверка на телефоне (HTTP)

LAN-IP в текущем окружении: **192.168.31.87** (проверить: `Get-NetIPAddress -AddressFamily IPv4`).

1. Телефон в той же Wi-Fi.
2. Открыть `http://192.168.31.87:3000/`.
3. Войти теми же seed-учётками.
4. Убедиться, что интерфейс открывается и API отвечает.

HTTP-сценарий **не даёт** service worker/PWA/офлайн — для этого нужен HTTPS.

## 4. HTTPS/PWA на телефоне

Подготовлен nginx `https://192.168.31.87:3443/` с mkcert-сертификатом (localhost, 127.0.0.1, 192.168.31.87).

Сертификаты не коммитятся. Если каталога `deploy/https` нет:

```powershell
mkcert -cert-file deploy/https/pilot.crt -key-file deploy/https/pilot.key localhost 127.0.0.1 192.168.31.87
copy "$(mkcert -CAROOT)\rootCA.pem" deploy/https/rootCA.pem
docker compose -f docker-compose.pilot.yml --profile https up -d https
```

### 4.1. Доверие корневому CA

Файл: `deploy/https/rootCA.pem` (не коммитится).

Android:

1. Передать `rootCA.pem` на телефон (USB/файл).
2. Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
3. Выбрать файл, подтвердить.
4. Открыть `https://192.168.31.87:3443/`; предупреждения быть не должно.

iOS:

1. Передать `rootCA.pem` (AirDrop/файл/почта), открыть профиль.
2. Settings → General → VPN & Device Management → установить профиль.
3. Settings → General → About → Certificate Trust Settings → включить full trust для mkcert CA.
4. Открыть `https://192.168.31.87:3443/` в Safari.

На ПК: импортировать `rootCA.pem` в «Доверенные корневые центры» вручную (Current User). Автоматическая установка mkcert в этом окружении заблокирована политикой UI; без доверия браузер покажет предупреждение.

### 4.2. Установка PWA

- Android/Chrome: меню → «Установить приложение» / «Добавить на главный экран».
- iOS/Safari: «Поделиться» → «На экран Домой».
- После установки открыть иконку, проверить offline: включить авиарежим, открыть приложение, создать запись, выключить авиарежим → синхронизация.

### 4.3. Если HTTPS/CA недоступны

Временный туннель:

```powershell
cloudflared tunnel --url http://localhost:3000
```

Открыть выданный `https://…trycloudflare.com` на телефоне. Это внешний трафик; только для проверки, без реальных данных. В текущей сети туннель Cloudflare был заблокирован (UDP/TCP 7844).

## 5. Полезные команды

```powershell
docker compose -f docker-compose.pilot.yml logs -f app
docker compose -f docker-compose.pilot.yml logs seed
docker compose -f docker-compose.pilot.yml exec db psql -U logbook -d logbook -c "select count(*) from journal_entries;"
docker compose -f docker-compose.pilot.yml down
docker compose -f docker-compose.pilot.yml down -v
```

Если телефон не открывает LAN-адрес, разрешите порты в Windows Firewall (PowerShell от администратора):

```powershell
New-NetFirewallRule -DisplayName "Logbook pilot" -Direction Inbound -Protocol TCP -LocalPort 3000,3443 -Action Allow
```

Проверьте, что телефон в той же сети (не в гостевом Wi-Fi/VPN) и что `Get-NetTCPConnection -LocalPort 3000` показывает `0.0.0.0`.

## 6. Критерии успеха

- [ ] health 200, `db=ok`
- [ ] `/` отдаёт HTML, JS/CSS 200, страница рендерится
- [ ] вход admin/worker
- [ ] запись создаётся и синхронизируется
- [ ] телефон открывает HTTP LAN
- [ ] телефон доверяет HTTPS и открывает PWA
- [ ] offline reload/очередь работают
- [ ] после `down` данные сохраняются; `down -v` очищает

## 7. Остановка

```powershell
docker compose -f docker-compose.pilot.yml down
```

Данные — volume `jurnal_logbook-pilot-pgdata`; удаление — `down -v` (необратимо).
