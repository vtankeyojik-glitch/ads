/*!
 * Lampa plugin: NO-ADS
 * ---------------------------------------------------------------------------
 * Убирает рекламную заставку, которую Lampa показывает ПЕРЕД каждым
 * просмотром (VAST preroll из аккаунта + vast_url / vast_banner от плагинов).
 *
 * Почему именно так (src/interaction/advert/ima.js + preroll.js + player.js):
 *   Player.play() шлёт 'create', затем console.log(data), затем Preroll.show().
 *   getMediaType(data).any = torrent || youtube || continue || data.iptv
 *   Preroll.show(): если any === true -> реклама пропускается целиком.
 *
 * Раньше геттер отдавал true только на 2 чтения. Это ломалось: между
 * 'create' и Preroll.show() iptv читают другие плагины и console.log
 * (enumerable-свойства). К моменту проверки рекламы оба «бесплатных»
 * чтения уже были потрачены, type.any становился false, preroll шёл.
 *
 * Теперь iptv=true держится до событий start / external / destroy —
 * то есть ровно пока идёт решение о preroll, а интерфейс плеера после
 * старта снова видит false.
 *
 * Установка:
 *   Lampa -> Настройки -> Расширения -> Плагины -> Добавить -> URL файла
 *   (файл должен лежать на https-хостинге)
 */
(function () {
    'use strict';

    if (window.lampa_no_ads_ready) return;
    window.lampa_no_ads_ready = true;

    var KEY = 'lampa_no_ads_enabled';
    var FLAG = '__lampa_no_ads';
    var skipState = null;

    function enabled() {
        var v = Lampa.Storage.get(KEY, 'true');

        return v === true || v === 'true' || v === 1 || v === '1';
    }

    function releaseSkip() {
        if (skipState) skipState.on = false;
    }

    function markSkip(data) {
        if (!enabled() || !data || data[FLAG]) return;

        if (typeof data.vast_url === 'string') data.vast_url = null;
        if (typeof data.vast_banner === 'string') data.vast_banner = null;

        // Настоящий IPTV: не подменяем флаг, только глушим VAST от плагинов
        if (data.iptv) {
            data[FLAG] = true;
            return;
        }

        var state = { on: true };

        skipState = state;
        data[FLAG] = true;

        try {
            Object.defineProperty(data, 'iptv', {
                configurable: true,
                enumerable: true,
                get: function () {
                    return state.on;
                },
                set: function (v) {
                    state.on = false;

                    Object.defineProperty(data, 'iptv', {
                        value: v,
                        writable: true,
                        configurable: true,
                        enumerable: true
                    });
                }
            });
        }
        catch (e) {
            data.iptv = true;
            console.log('NO-ADS', 'defineProperty failed:', e.message);
        }
    }

    function wrapPlay() {
        if (!Lampa.Player || Lampa.Player.__lampa_no_ads_wrapped) return;

        Lampa.Player.__lampa_no_ads_wrapped = true;

        var origPlay = Lampa.Player.play;
        var origIptv = Lampa.Player.iptv;

        if (typeof origPlay === 'function') {
            Lampa.Player.play = function (data) {
                markSkip(data);

                return origPlay.apply(this, arguments);
            };
        }

        if (typeof origIptv === 'function') {
            Lampa.Player.iptv = function (data) {
                markSkip(data);

                return origIptv.apply(this, arguments);
            };
        }
    }

    function init() {
        try {
            Lampa.SettingsApi.addComponent({
                component: 'lampa_no_ads',
                name: 'NO-ADS',
                icon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l16 16M9 9H5v6h4l5 4V5L9 9z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            });

            Lampa.SettingsApi.addParam({
                component: 'lampa_no_ads',
                param: {
                    name: KEY,
                    type: 'trigger',
                    default: true
                },
                field: {
                    name: 'Отключать рекламу перед фильмом',
                    description: 'Не показывать рекламную заставку перед просмотром'
                }
            });
        }
        catch (e) {
            console.log('NO-ADS', 'settings api error:', e.message);
        }

        wrapPlay();

        Lampa.Player.listener.follow('create', function (e) {
            markSkip(e && e.data);
        });

        Lampa.Player.listener.follow('start,external,destroy', function () {
            releaseSkip();
        });

        console.log('NO-ADS', 'ready');
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type == 'ready') init();
    });
})();
