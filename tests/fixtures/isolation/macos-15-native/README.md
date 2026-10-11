# Реальные немодельные наблюдения native-прототипа 0C

Отдельны от синтетических потоков и реальных модельных Claude fixtures. macOS 15.0.1 / Darwin 24.0.0, Node 24.15.0, установленная Claude 2.1.295. Никаких модельных запросов. Эти файлы **не AccessVerification**.

- `icu-denied.json`: --help exit 1, только диагностическая строка TypeError; bundled source, stdout и сырой stderr не сохранены.
- `icu-only-allowed.json`: профиль отрицательного контроля плюс ровно одна строка read-only `/usr/share/icu`; --help успешен. Равенство остальных строк проверено.
- `icu-allowed-auth.json`: заключительная отдельная проверка расширенных auth исключений. Auth status остаётся false/none при перечисленных исключениях, нормальных HOME/Keychain и TMPDIR собственного стенда. Это не доказательство несовместимости Keychain; причина auth false не локализована.
- `plugins-inline-denied.json`: inline --settings требует mkdir общего `/tmp/claude-<UID>`; это разрешение не добавлено.
- `plugins-settings-file.json`: собственный файл --settings принимается без такой записи. plugin list пуст и с ним, и без него: это не effective builtin inventory и не подтверждение пустого init.plugins.
- `observations.json`, `profile.redacted.sb`: настоящий Seatbelt через наш ProcessRunner. DNS/dial broker заменены **доверенным локальным transport double**, контактов с provider нет. Наличие public IP в double не является реальным DNS evidence. Есть положительный IPv6-контроль вне профиля. Собственный C helper делает fork/setsid, переживает SIGTERM группы и пишет marker после done, затем сам выходит.

Пути заменены на `<STAND>/<HOME>/<CONFIG>/<CLI>`, UID обезличен. В stdout стенда только искусственные контрольные строки. Токены, email, account, Keychain contents и чужие транскрипты не сохранялись. Исходные временные артефакты оставлены; удалялись только созданные стендом targets. Общий Git-контроль не изменился.
