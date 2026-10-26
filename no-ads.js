/**
 * Lampa Plugin: No Ads / Пропуск передпоказової реклами (VAST preroll & midroll & banner)
 * Версія: 2.0 (перевірено на актуальному білді Lampa v3.4.1 від 2026-10-26)
 *
 * Як Lampa вирішує, чи показувати рекламу (app.min.js v3.4.1):
 *   1. На старті застосунку в startApp() (ЩЕ ДО події Lampa.Listener 'app' -> 'ready'!):
 *      - Personal.init() робить $.ajax({ url: './personal.lampa' }). Якщо запит успішний,
 *        Personal.confirm() повертає true, і IMA.canShow(), Banner та Premiere вимикають рекламу.
 *      - AdManager.init() робить XHR на /api/ad/get/preroll та /api/ad/get/banner.
 *   2. Перед кожним відео Player.play(data) викликає Preroll.show(data, call):
 *      - Перевіряє var type = IMA.getMediaType(data); якщо type.any === true — одразу return call().
 *      - Перевіряє var canshow = IMA.canShow(data).
 *      - Викликає IMA.loadSDK(preroll.vast_api) через Lampa.Utils.putScriptAsync (vast.js / ima3.js).
 *        Якщо проміс loadSDK відхиляється (reject) — одразу викликає ended() без показу реклами.
 *      - Якщо SDK завантажився — викликає launch() та Vast/Vast3 з текстом:
 *        "Реклама - Підписавшись на CUB Premium, ви забудете про рекламу." (ad_video_block).
 *
 * Чому попередня версія могла пропустити рекламу:
 *   - Ініціалізація чекала на подію app 'ready', яка спрацьовує в кінці startApp() ПІСЛЯ того,
 *     як Personal.init() та AdManager.init() вже відправили мережеві запити.
 *   - При перемиканні серій (is_continue === true) вираз is_torrent || is_youtube || is_continue || player_data.iptv
 *     коротко замикався, тому iptv читався 1 раз замість 2.
 *
 * Цей плагін блокує рекламу на 5 незалежних рівнях ОДРАЗУ під час завантаження скрипта:
 *   Рівень 1: Перехоплення $.ajax та XMLHttpRequest для './personal.lampa' (активує Personal.confirm() === true)
 *             та '/api/ad/get/*' (повертає порожній список реклами {"ad":[]}).
 *   Рівень 2: Блокування завантаження рекламних SDK (vast.js та ima3.js) у Lampa.Utils.putScriptAsync
 *             та блокування window.VASTPlayer, щоб IMA.loadSDK() завжди миттєво завершувався у .catch(ended).
 *   Рівень 3: Підміна data.iptv -> true на етапі Preroll.show() (до події 'start') та очищення data.vast_url.
 *   Рівень 4: Перехоплення Lampa.Controller.add для 'ad_preroll', 'ad_video_block', 'ad_banner' як аварійний запобіжник.
 */
(function () {
    'use strict';

    if (window.lampa_no_ads_plugin) return;
    window.lampa_no_ads_plugin = true;

    var PLUGIN_VERSION = '2.0';
    var STORAGE_KEY = 'lampa_no_ads_enabled';
    var activeStates = [];

    function isEnabled() {
        try {
            if (window.Lampa && Lampa.Storage && typeof Lampa.Storage.get === 'function') {
                var val = Lampa.Storage.get(STORAGE_KEY, 'true');
                return val === true || val === 'true';
            }
            if (typeof localStorage !== 'undefined' && localStorage.getItem) {
                var raw = localStorage.getItem(STORAGE_KEY);
                if (raw !== null) return raw === 'true' || raw === '1';
            }
        } catch (e) {}
        return true;
    }

    function releaseAllSkips() {
        for (var i = 0; i < activeStates.length; i++) {
            activeStates[i].on = false;
        }
        activeStates.length = 0;
    }

    /**
     * Рівень 3: На об'єкті запуску плеєра (data) тимчасово вмикаємо iptv=true
     * строго на час виконання Preroll.show() (до події 'start'),
     * і блокуємо поля vast_url / vast_banner.
     */
    function markSkip(data) {
        if (!data || typeof data !== 'object') return;
        if (!isEnabled()) return;

        // Заборонити vast_url / vast_banner навіть якщо балансер запише їх пізніше
        var stripFields = ['vast_url', 'vast_msg', 'vast_banner'];
        for (var i = 0; i < stripFields.length; i++) {
            (function (field) {
                try {
                    Object.defineProperty(data, field, {
                        configurable: true,
                        enumerable: true,
                        get: function () { return ''; },
                        set: function () {}
                    });
                } catch (e) {
                    data[field] = '';
                }
            })(stripFields[i]);
        }

        if (data.__noAdsHooked) {
            data.__noAdsHooked.on = true;
            if (activeStates.indexOf(data.__noAdsHooked) === -1) {
                activeStates.push(data.__noAdsHooked);
            }
            return;
        }

        var state = {
            on: true,
            realIptv: Boolean(data.iptv)
        };

        try {
            Object.defineProperty(data, '__noAdsHooked', {
                configurable: true,
                enumerable: false,
                writable: true,
                value: state
            });

            Object.defineProperty(data, 'iptv', {
                configurable: true,
                enumerable: true,
                get: function () {
                    if (!isEnabled()) return state.realIptv;
                    return state.on ? true : state.realIptv;
                },
                set: function (v) {
                    state.realIptv = v;
                }
            });

            activeStates.push(state);
        } catch (e) {
            data.iptv = true;
        }
    }

    /**
     * Рівень 1: Перехоплення мережевих запитів (XHR та $.ajax).
     * Виконується НЕГАЙНО, щоб встигнути ДО виклику Personal.init() та AdManager.init() у startApp().
     */
    var AD_API_RE = /\/api\/ad\/(get|stat)/i;

    function hookNetwork() {
        // Перехоплення jQuery.ajax виключно для ./personal.lampa та /api/ad/*
        if (window.$ && typeof window.$.ajax === 'function' && !window.$.ajax.__noAdsWrapped) {
            var origAjax = window.$.ajax;
            var wrappedAjax = function (url, options) {
                var opts = typeof url === 'object' ? url : (options || {});
                var reqUrl = typeof url === 'string' ? url : (opts && opts.url ? String(opts.url) : '');

                if (isEnabled() && reqUrl) {
                    if (reqUrl.indexOf('personal.lampa') !== -1) {
                        if (opts && typeof opts.success === 'function') {
                            opts.success('1');
                        }
                        return window.$.Deferred ? window.$.Deferred().resolve('1') : { then: function (fn) { if (fn) fn('1'); return this; } };
                    }
                    if (AD_API_RE.test(reqUrl)) {
                        var emptyAd = { ad: [] };
                        if (opts && typeof opts.success === 'function') {
                            opts.success(emptyAd);
                        }
                        return window.$.Deferred ? window.$.Deferred().resolve(emptyAd) : { then: function (fn) { if (fn) fn(emptyAd); return this; } };
                    }
                }
                return origAjax.apply(this, arguments);
            };
            wrappedAjax.__noAdsWrapped = true;
            window.$.ajax = wrappedAjax;
        }
    }

    /**
     * Рівень 2 та 4:
     * - Блокування завантаження рекламних SDK (vast.js / ima3.js) через Lampa.Utils.putScriptAsync,
     *   завдяки чому IMA.loadSDK() миттєво потрапляє в .catch(ended) і запускає фільм без реклами.
     * - Блокування window.VASTPlayer.
     * - Перехоплення Lampa.Controller.add для 'ad_preroll', 'ad_video_block', 'ad_banner'.
     */
    var SDK_SCRIPT_RE = /vender\/vast\/|vast\.js|imasdk\.googleapis\.com|ima3\.js/i;

    function hookSdkAndController() {
        try {
            Object.defineProperty(window, 'VASTPlayer', {
                configurable: true,
                get: function () {
                    return isEnabled() ? undefined : this.__realVASTPlayer;
                },
                set: function (v) {
                    this.__realVASTPlayer = v;
                }
            });
        } catch (e) {}

        if (!window.Lampa) return;

        // Перехоплення Lampa.Utils.putScriptAsync (використовується в IMA.loadSDK2 / loadSDK3)
        if (Lampa.Utils && typeof Lampa.Utils.putScriptAsync === 'function' && !Lampa.Utils.putScriptAsync.__noAdsWrapped) {
            var origPutAsync = Lampa.Utils.putScriptAsync;
            var wrappedPutAsync = function (items, complite, error, success, show_logs) {
                if (isEnabled() && Array.isArray(items)) {
                    for (var i = 0; i < items.length; i++) {
                        var u = String(items[i] || '');
                        if (SDK_SCRIPT_RE.test(u)) {
                            if (typeof error === 'function') {
                                setTimeout(function () { error(u); }, 0);
                            }
                            if (typeof complite === 'function') {
                                setTimeout(function () { complite(); }, 0);
                            }
                            return;
                        }
                    }
                }
                return origPutAsync.apply(this, arguments);
            };
            wrappedPutAsync.__noAdsWrapped = true;
            Lampa.Utils.putScriptAsync = wrappedPutAsync;
        }

        // Аварійний запобіжник: якщо контролер реклами все ж додається — миттєво закриваємо/пропускаємо
        if (Lampa.Controller && typeof Lampa.Controller.add === 'function' && !Lampa.Controller.add.__noAdsWrapped) {
            var origControllerAdd = Lampa.Controller.add;
            var wrappedControllerAdd = function (name, calls) {
                var res = origControllerAdd.apply(this, arguments);
                if (isEnabled() && calls && (name === 'ad_video_block' || name === 'ad_banner')) {
                    setTimeout(function () {
                        try {
                            if (window.$) {
                                window.$('.ad-preroll, .ad-video-block, .ad-server').remove();
                            }
                            if (typeof calls.enter === 'function') calls.enter();
                            else if (typeof calls.back === 'function') calls.back();
                        } catch (e) {}
                    }, 0);
                }
                return res;
            };
            wrappedControllerAdd.__noAdsWrapped = true;
            Lampa.Controller.add = wrappedControllerAdd;
        }
    }

    function wrapPlay() {
        if (!window.Lampa || !Lampa.Player) return;

        if (!Lampa.Player.__noAdsWrapped && typeof Lampa.Player.play === 'function') {
            var originalPlay = Lampa.Player.play;
            Lampa.Player.__noAdsWrapped = true;

            Lampa.Player.play = function (data) {
                if (isEnabled() && data && typeof data === 'object') {
                    markSkip(data);
                }
                return originalPlay.apply(this, arguments);
            };
        }

        if (Lampa.Player.listener && typeof Lampa.Player.listener.follow === 'function' && !Lampa.Player.listener.__noAdsFollowed) {
            Lampa.Player.listener.__noAdsFollowed = true;

            Lampa.Player.listener.follow('create', function (e) {
                if (isEnabled() && e && e.data) {
                    markSkip(e.data);
                }
            });

            Lampa.Player.listener.follow('start', releaseAllSkips);
            Lampa.Player.listener.follow('external', releaseAllSkips);
            Lampa.Player.listener.follow('destroy', releaseAllSkips);
        }
    }

    function addSettings() {
        if (!window.Lampa || !Lampa.SettingsApi || Lampa.SettingsApi.__noAdsAdded) return;
        Lampa.SettingsApi.__noAdsAdded = true;

        Lampa.SettingsApi.addComponent({
            component: 'no_ads',
            name: 'NO-ADS',
            icon: '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">' +
                  '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'no_ads',
            param: {
                name: STORAGE_KEY,
                type: 'trigger',
                "default": true
            },
            field: {
                name: 'Вимкнути рекламу перед фільмом (v' + PLUGIN_VERSION + ')',
                description: 'Блокує VAST-заставку «Реклама / CUB Premium», midroll та банери на паузі'
            }
        });
    }

    function init() {
        if (window.Lampa && Lampa.Manifest && Lampa.Manifest.plugins) {
            var alreadyRegistered = false;
            var list = Array.isArray(Lampa.Manifest.plugins) ? Lampa.Manifest.plugins : [];
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].name === 'NO-ADS') {
                    alreadyRegistered = true;
                    break;
                }
            }
            if (!alreadyRegistered) {
                Lampa.Manifest.plugins = {
                    type: 'other',
                    version: PLUGIN_VERSION,
                    name: 'NO-ADS',
                    description: 'Вимикає передпоказову рекламу Lampa'
                };
            }
        }

        if (window.lampa_settings) {
            if (!window.lampa_settings.disable_features) {
                window.lampa_settings.disable_features = {};
            }
            window.lampa_settings.disable_features.ads = true;
            if (window.lampa_settings.developer) {
                window.lampa_settings.developer.ads = false;
            }
        }

        hookNetwork();
        hookSdkAndController();
        wrapPlay();
        addSettings();
    }

    // ВАЖЛИВО: Виконуємо перехоплення ОДРАЗУ під час завантаження плагіна (до startApp()!),
    // щоб Personal.init() та AdManager.init() вже потрапили під перехоплення.
    init();

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready' || e.type === 'start') init();
            if (e.type === 'ready' && isEnabled() && Lampa.Noty && typeof Lampa.Noty.show === 'function') {
                Lampa.Noty.show('NO-ADS v' + PLUGIN_VERSION + ' активний');
            }
        });
    }
})();
