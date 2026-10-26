/*
 * Test for no-ads.js — проверяем ровно ту логику, на которой держится
 * отключение рекламы в Lampa (src/interaction/advert/ima.js + player.js).
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

    function follow(type, fn) {
        String(type).split(',').forEach((name) => {
            (listeners[name] = listeners[name] || []).push(fn);
        });
    }

    function play(data) {
        send('create', { data, abort() {} });
        // как в player.js: между create и preroll объект логируют
        JSON.stringify(data);
        return data;
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
            play,
            iptv: play,
            listener: { follow, send }
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

function canShow(player_data) {
    const player_type = getMediaType(player_data);

    return player_type.any ? false : true;
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

// 1. Player.play + лишние чтения iptv до preroll (console.log / другие плагины)
const data = { url: 'https://example.com/movie.mp4', title: 'Test' };
lampa.Player.play(data);
JSON.stringify(data);
data.iptv;
data.iptv;
const type = getMediaType(data);
check('реклама пропускается после лишних чтений (type.any === true)', type.any === true, type);
check('canShow === false пока плеер не стартовал', canShow(data) === false, canShow(data));

// 2. После start интерфейс плеера должен видеть обычное значение
lampa.Player.listener.send('start', data);
check('после start data.iptv === false', data.iptv === false, data.iptv);

// 3. Если Lampa сама выставила iptv (режим IPTV) — не ломаем
const ipTV = { url: 'x', iptv: true };
lampa.Player.play(ipTV);
check('чужой iptv=true не перебит', ipTV.iptv === true, ipTV.iptv);

// 4. vast_url / vast_banner от стороннего плагина гасятся
const withAd = { url: 'x', vast_url: 'https://ads.example/vast.xml', vast_banner: 'https://ads.example/banner.xml' };
lampa.Player.play(withAd);
check('vast_url обнулён', withAd.vast_url === null, withAd.vast_url);
check('vast_banner обнулён', withAd.vast_banner === null, withAd.vast_banner);

// 5. Выключатель в настройках
lampa.Storage.set('lampa_no_ads_enabled', false);
const off = { url: 'y' };
lampa.Player.play(off);
check('при выключенной настройке data.iptv не подменяется', off.iptv === undefined, off.iptv);

console.log(failed ? '\nFAILED: ' + failed : '\nOK');
process.exit(failed ? 1 : 0);
