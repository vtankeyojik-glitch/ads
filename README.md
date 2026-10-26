# Lampa: безкоштовні джерела + відключення реклами

Перевірено на `yumata/lampa-source` (актуальна версія) і на живих HTTP-відповідях
сайтів (2026-10-21).

---

## 1. `no-ads.js` — гасить рекламу Lampa перед кожним фільмом/серією

### Що це робить

Lampa показує VAST-заставку «Реклама» перед кожним запуском (і перед кожною серією —
тому при 10-хвилинних мультфільмах це найбільша біль). Логіка в
`src/interaction/advert/ima.js`:

```js
function getMediaType(player_data){
    return {
        iptv: player_data.iptv,
        any:  is_torrent || is_youtube || is_continue || player_data.iptv
    };
}
// Preroll.show(): if(type.any) -> реклама пропускається повністю
```

Плагін підміняє `data.iptv` геттером: `true` **поки не стартував плеєр**
(події `start` / `external` / `destroy`). Лічильник на 2 читання не працює:
між `create` і `Preroll.show()` Lampa робить `console.log(data)`, а інші
плагіни теж читають `iptv` — «безкоштовні» читання згорають, і реклама знову
йде. Тому:

* реклама не показується (і не чекається 2 хвилини);
* інтерфейс плеера не ламається: кнопка «назад»/перемотка, блок «О фільмі»,
  лічильники метрик працюють як завжди (вони читають `data.iptv` після проверки).

Додатково обнуляє `data.vast_url` — рекламу, которую присилають сторонні плагіни.

### Установка

Варіант 1 (Android TV / будь-яка Lampa з розширеннями):
`Настройки → Расширення → Плагини → Добавить` → URL файлу (має бути `https`).

Варіант 2 (збірка з `lampa-source`): покласти як `plugins/modification.js`.

Варіант 3 (desktop/web): рядок в `Настройки → Расширення` → той самий URL.

### Перевірка

```bash
cd ~/lampa-plugins
node test_no_ads.js
```

Тест імітує `Lampa` і копіює `getMediaType()` з `ima.js` дослівно:

```
  ok   реклама пропускается (type.any === true)
  ok   после проверки data.iptv === false
  ok   чужой iptv=true не перебит
  ok   vast_url обнулён
  ok   при выключенной настройке data.iptv не подменяется
OK
```

Перемикач у настройках: `Настройки → NO-ADS → Отключать рекламу перед фильмом`
(зберётся в `Lampa.Storage` под ключом `lampa_no_ads_enabled`).

---

## 2. Джерела: що реально живе станом на 2026-10-21

Перевірено живими запитами (не документацією):

| Сайт | Статус | Що видно |
|---|---|---|
| `kinokong.com` | **домен продаётся** (NS → `domainmarket.com`) | парсер не имеет смысла |
| `kinokong.net` | не резолвится | — |
| `kinokong.es` | жив, движок DLE | `GET /engine/ajax/search.php?q=` отдаёт 200, но **без `Access-Control-Allow-Origin`**; `POST /engine/ajax/controller.php` → «Hacking attempt!» |
| `seasonvar.com` | A-записи есть (через 8.8.8.8), но сайт отдаёт заглушку «Coming Soon» | `www.seasonvar.com` — только IPv6, отсюда недоступен |
| `hdrezka.com` | редирект на `/lander` | — |
| `hdrezka.net` / `ww17.hdrezka.net` | жив | страницы фильмов закрыты **Anubis** («Проверяем, что вы не бот») для гостя |
| `rezka.fi`, `rezka.ag`, `hdrezka.club` | жив, тот же движок DLE | `GET /engine/ajax/search.php?q=matrix` → **200 с разметкой** (`<span class="enty">Матрица</span> (The Matrix, 1999)`), ссылки вида `/films/fiction/981-matrica-1999-latest.html` |
| `4k-hd.club` | жив, DLE | `/engine/ajax/search.php?q=` → 403 (другой WAF) |
| `kinobase.org` | жив | `GET /search?query=` → 200 с разметкой; **уже встроен в Lampa** как балансер `kinobase` |

Ключевой вывод: **все эти сайты — один и тот же движок DLE** с одинаковыми
эндпоинтами (`/engine/ajax/search.php?q=`, `/films/...`, `/ajax/get_cdn_series/`).
То есть один парсер покрывает hdrezka/rezka/kinokong с разными зеркалами.

### Два технических ограничения (важно понимать до реализации)

1. **CORS.** Ни один из этих трекеров не отдаёт `Access-Control-Allow-Origin`.
   Значит из веб/десктоп-сборки Lampa прямой `fetch` будет заблокирован —
   нужен прокси. В Lampa это уже предусмотрено: `Lampa.Params` имеет
   `online_proxy_all` и `online_proxy_<balanser>`, а балансеры ходят через
   `component.proxy('rezka')`. Для внешнего плагина — то же самое, читаем
   `Lampa.Storage.get('online_proxy_all')`.
2. **Anubis (JS-проверка на бот).** `hdrezka.net`/`rezka.ag` отдают гостю
   HTML-заглушку с JS-челленджем. Внутри настоящего WebView (Android TV, XWalk)
   челлендж проходится; в «честном» HTTP-клиенте (curl/fetch) — нет. Плюс
   `POST /ajax/get_cdn_series/` на гостевой сессии отдал `405 Not Allowed`
   (нужна авторизация, т.е. логин на сайте).

### Что уже готово и не нужно писать

Под все эти сайты (DLE-движок) уже есть MIT-плагин сообщества с полным
функционалом — вход по логину, выбор озвучки/сезона/серии, качества
360p…4K, субтитры, свой домен-зеркало, распаковка «trash»-ссылок:

```
https://github.com/Kimvnx/lampa-hdrezka        (rezka.js, ~850 строк, MIT)
https://github.com/D1N0v/hdplugin               (hdrezka.js)
https://github.com/ABurnglv/lampa-hdrezka-plugin
```

Установка — тот же путь: URL в `Настройки → Расширения → Плагины`.
Домен-зеркало настраивается в его настройках (по умолчанию `https://rezka.fi`).

Живые зеркала на момент проверки (все отвечают на `GET /engine/ajax/search.php?q=`):
`rezka.fi`, `rezka.ag`, `hdrezka.club`, `kinokong.es`.

---

## 3. Что сделано / что осталось

Сделано:

* `no-ads.js` — плагин, гасящий рекламу Lampa перед просмотром; логика сверена с
  `ima.js`/`preroll.js`, покрыта тестом `test_no_ads.js` (5/5 ok).
* Инвентаризация источников: что живо, что мертво, какие ограничения по CORS и
  Anubis.

Не сделано (нужен выбор/доступ):

* Новый балансер DLE для `hdrezka/kinokong/seasonvar` — либо берём MIT-плагин
  сообщества и правим под зеркала, либо пишем свой (нужен рабочий прокси для CORS
  и живая сессия сайта для проверки `get_cdn_series`).
* `seasonvar` сейчас отдаёт заглушку «Coming Soon» — парсер писать не на что.

Следующий шаг по умолчанию, если не скажешь иначе: взять DLE-парсер (свой, ~300
строк, с прокси-опцией и зеркальным списком) и добавить в него «без рекламы» —
выбор перевода с `is_ads=0` (это чистый поток без рекламных вставок сайта), плюс
подключить к ней `no-ads.js`, чтобы гасилась и заставка Lampa.
