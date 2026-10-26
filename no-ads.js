/*!
 * Lampa plugin: NO-ADS
 * ---------------------------------------------------------------------------
 * Убирает рекламную заставку, которую Lampa показывает ПЕРЕД каждым
 * просмотром (VAST preroll из аккаунта + vast_url от сторонних плагинов).
 *
 * Почему именно так (src/interaction/advert/ima.js):
 *   getMediaType(data).any = torrent || youtube || continue || data.iptv
 *   Preroll.show(): если any === true -> реклама пропускается целиком,
 *   без анимации «Реклама» и без ожидания её окончания.
 *
 * Флаг data.iptv ставится в событии 'create' (оно приходит ДО проверки
 * рекламы) и снимается после: свойства-геттера отдают true только на
 * чтениях, которые делает проверка рекламы, и дальше — обычное значение.
 * Так интерфейс плеера (кнопка перемотки, «О фильме», счётчики) не ломается.
 *
 * Установка (любой из вариантов):
 *   1) Lampa -> Настройки -> Расширения -> Плагины -> Добавить -> URL файла
 *      (файл должен лежать на https-хостинге)
 *   2) положить файл как <корень lampa>/plugins/modification.js
 *   3) для Android TV: Lampa -> Настройки -> Расширения -> Плагины -> URL
 */
(function () {
    'use strict';

    if (window.lampa_no_ads_ready) return;
    window.lampa_no_ads_ready = true;

    // ponytail: чтений data.iptv на проверку рекламы ровно два (getMediaType:
    // поле iptv и поле any). Два -> true, дальше обычное значение.
    var AD_READS = 2;

    var KEY = 'lampa_no_ads_enabled';

    function enabled() {
        var v = Lampa.Storage.get(KEY, 'true');

        return v === true || v === 'true' || v === 1 || v === '1';
    }

    function init() {
        try {
            Lampa.SettingsApi.addComponent({
                component: 'lampa_no_ads',
                name: 'NO-ADS',
                icon: ''
            });

            Lampa.SettingsApi.addParam({
                component: 'lampa_no_ads',
                param: {
                    name: KEY,
                    type: 'trigger',
                    default: 'true'
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

        Lampa.Player.listener.follow('create', function (e) {
            if (!enabled()) return;

            var data = e && e.data;
            if (!data) return;

            // Lampa сама выставила iptv (режим IPTV) - не трогаем
            if (data.iptv) return;

            // реклама, которую присылают сторонние плагины (vast_url)
            if (typeof data.vast_url === 'string') data.vast_url = null;

            var reads = 0;

            Object.defineProperty(data, 'iptv', {
                configurable: true,
                enumerable: true,
                get: function () {
                    reads++;

                    return reads <= AD_READS ? true : false;
                },
                set: function (v) {
                    Object.defineProperty(data, 'iptv', {
                        value: v,
                        writable: true,
                        configurable: true
                    });
                }
            });
        });
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type == 'ready') init();
    });
})();
