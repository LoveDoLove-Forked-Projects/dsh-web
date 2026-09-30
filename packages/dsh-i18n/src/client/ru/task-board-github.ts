/**
 * Russian dictionary for the "task-board-github" locale namespace.
 * Source package: packages/dsh-task-board-github (its zh dictionary is the key
 * source). Maintained centrally by the dsh-i18n language pack; when a zh key is
 * added or changed upstream, mirror it here and run `pnpm i18n:check`.
 */

export const ru: Record<string, string> = {
  'settings.collapse': 'Скрыть настройки',
  'settings.description': 'Внешнее расширение-провайдер для доски задач: синхронизирует GitHub Issues в карточки доски. Включено по умолчанию, отключается в этой карточке.',
  'settings.discard': 'Отменить',
  'settings.enabled': 'Включить синхронизацию GitHub Issues',
  'settings.enabledHint': 'Когда выключено, расширение ничего не предоставляет доске задач и синхронизация GitHub Issues останавливается; сама доска не затрагивается.',
  'settings.expand': 'Показать настройки',
  'settings.inherit': 'Наследовать (значение развёртывания)',
  'settings.invalidValue': 'Значение не принимается',
  'settings.notExposed': 'В этой версии DSH пространство имён настроек этого плагина недоступно странице настроек, поэтому форма не работает. Отредактируйте ~/.dsh/settings.yaml напрямую либо добавьте это пространство имён в белый список настроек Host и перезапустите.',
  'settings.off': 'Выкл',
  'settings.on': 'Вкл',
  'settings.overridden': 'Переопределено',
  'settings.placeholder': 'На этом этапе есть только главный переключатель: список репозиториев, переменная окружения с токеном и состояние синхронизации появятся вместе с регистрацией провайдера.',
  'settings.readOnly': 'В этом развёртывании настройки доступны только для чтения.',
  'settings.reset': 'Вернуть по умолчанию',
  'settings.save': 'Сохранить',
  'settings.saveFailed': 'Развёртывание не приняло эти значения; они оставлены, чтобы вы могли их исправить.',
  'settings.saving': 'Сохранение…',
  'settings.title': 'Синхронизация GitHub Issues',
  'settings.unsaved': 'Не сохранено',
}
