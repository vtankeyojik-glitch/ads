/*
 * Test for no-ads.js — проверяем ровно ту логику, на которой держится
 * отключение рекламы в Lampa (src/interaction/advert/ima.js).
 *
 * Запуск:  node test_no_ads.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- мини-имитация Lampa ---------- */

function makeLampa() {
    const listeners = {};

    function send(type, event) {
        (listeners[type] || []).forEach((fn) => fn(event));
    }

    return {
        Storage: {
            _v: {},
            get(k, d) { return (k in this._v) ? this._v[k] : d; },
            set(k, v) { this._v[k] = v; }
        },
        SettingsApi: { addComponent() {}, addParam() {} },
        Listener: { follow(type, fn) { send(type, fn); } },
        Player: {
            listener: {
                follow(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
                send
            }
        }
    };
}

/* ---------- точная копия getMediaType() из src/interaction/advert/ima.js ---------- */

function getMediaType(player_data) {
    let is_torrent = false;
    let is_youtube = false;
    let is_continue = false;

    return {
        iptv: player_data.iptv,
        torrent: is_torrent,
        youtube: is_youtube,
        continue: is_continue,
        any: is_torrent || is_youtube || is_continue || player_data.iptv
    };
}

/* ---------- загрузка плагина ---------- */

const lampa = makeLampa();
const sandbox = {
    window: { appready: true },
    Lampa: lampa,
    console
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'no-ads.js'), 'utf8'), sandbox);

/* ---------- проверки ---------- */

let failed = 0;

function check(name, cond, extra) {
    if (cond) {
        console.log('  ok   ' + name);
    } else {
        failed++;
        console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''));
    }
}

console.log('no-ads.js');

// 1. Плагин повесил обработчик 'create'
const data = { url: 'https://example.com/movie.mp4', title: 'Test' };
lampa.Player.listener.send('create', { data, abort() {} });

// 2. Проверка рекламы: getMediaType() читает data.iptv ДВА раза
const type = getMediaType(data);
check('реклама пропускается (type.any === true)', type.any === true, type);

// 3. После проверки рекламы интерфейс плеера должен видеть обычное значение
check('после проверки data.iptv === false', data.iptv === false, data.iptv);

// 4. Если Lampa сама выставила iptv (режим IPTV) — не ломаем
const ipTV = { url: 'x', iptv: true };
lampa.Player.listener.send('create', { data: ipTV, abort() {} });
check('чужой iptv=true не перебит', ipTV.iptv === true, ipTV.iptv);

// 5. vast_url от стороннего плагина гасится
const withAd = { url: 'x', vast_url: 'https://ads.example/vast.xml' };
lampa.Player.listener.send('create', { data: withAd, abort() {} });
check('vast_url обнулён', withAd.vast_url === null, withAd.vast_url);

// 6. Выключатель в настройках
lampa.Storage.set('lampa_no_ads_enabled', 'false');
const off = { url: 'y' };
lampa.Player.listener.send('create', { data: off, abort() {} });
check('при выключенной настройке data.iptv не подменяется', off.iptv === undefined, off.iptv);

console.log(failed ? '\nFAILED: ' + failed : '\nOK');
process.exit(failed ? 1 : 0);
