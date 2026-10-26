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

        var state = { on: true, adCheckReads: 0 };
        var realYoutube = data.youtube;

        skipState = state;
        data[FLAG] = true;

        try {
            // В ima.js getMediaType(player_data) всегда читает player_data.youtube
            // прямо перед двумя чтениями player_data.iptv (и в Preroll.show, и в Banner).
            if (!realYoutube) {
                Object.defineProperty(data, 'youtube', {
                    configurable: true,
                    enumerable: false,
                    get: function () {
                        if (enabled()) state.adCheckReads = 2;
                        return realYoutube;
                    },
                    set: function (v) {
                        realYoutube = v;
                    }
                });
            }

            // enumerable: false — чтобы console.log(data) и JSON.stringify(data)
            // (в т.ч. Android.openPlayer до события 'external') не видели iptv: true.
            Object.defineProperty(data, 'iptv', {
                configurable: true,
                enumerable: false,
                get: function () {
                    if (!enabled()) return false;
                    if (state.adCheckReads > 0) {
                        state.adCheckReads--;
                        return true;
                    }
                    return state.on;
                },
                set: function (v) {
                    state.on = false;
                    state.adCheckReads = 0;

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

    function blockVastXhr() {
        if (typeof XMLHttpRequest === 'undefined' || XMLHttpRequest.prototype.__lampa_no_ads_xhr) return;

        XMLHttpRequest.prototype.__lampa_no_ads_xhr = true;

        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            this.__lampa_no_ads_block = Boolean(
                enabled() && typeof url === 'string' && url.indexOf('/api/ad/get/') !== -1
            );

            return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function () {
            if (this.__lampa_no_ads_block) {
                var self = this;

                setTimeout(function () {
                    try {
                        Object.defineProperty(self, 'status', { value: 200, configurable: true });
                        Object.defineProperty(self, 'responseText', { value: '{"ad":[]}', configurable: true });
                    }
                    catch (e) {}

                    if (typeof self.onload === 'function') self.onload();
                }, 0);

                return;
            }

            return origSend.apply(this, arguments);
        };
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

        // Важно: Panel, Info и Footer подписываются на 'start' при инициализации Lampa
        // (раньше плагинов). Перехватываем send(), чтобы сбрасывать skipState ДО того,
        // как Info и Footer прочитают data.iptv в своих обработчиках 'start'.
        var listener = Lampa.Player.listener;
        if (listener && typeof listener.send === 'function' && !listener.__lampa_no_ads_send) {
            listener.__lampa_no_ads_send = true;
            var origSend = listener.send;

            listener.send = function (type, event) {
                if (type === 'create') {
                    markSkip(event && event.data);
                } else if (type === 'start' || type === 'external' || type === 'destroy') {
                    releaseSkip();
                }

                return origSend.apply(this, arguments);
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

        blockVastXhr();
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
