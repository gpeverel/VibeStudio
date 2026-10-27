/*
 * Диагностика доступности двух именованных служб в текущем bootstrap namespace.
 * Не создаёт окно, не регистрирует приложение и не отправляет сообщения службам.
 * Не меняет sandbox, bootstrap namespace, окружение или настройки macOS.
 * Успешный lookup не доказывает возможность GUI-регистрации или успешный smoke.
 * Сборка/запуск с конечным таймаутом: scripts/macos-gui-probe.mjs.
 */
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>

int main(void) {
    const char *services[] = {
        "com.apple.coreservices.launchservicesd",
        "com.apple.windowserver.active",
    };
    int failed = 0;
    puts("{\"schemaVersion\":1,\"checks\":[");
    for (unsigned int i = 0; i < sizeof(services) / sizeof(services[0]); i++) {
        mach_port_t port = MACH_PORT_NULL;
        kern_return_t code = bootstrap_look_up(bootstrap_port, services[i], &port);
        const char *status = code == BOOTSTRAP_SUCCESS ? "reachable"
            : code == BOOTSTRAP_NOT_PRIVILEGED ? "denied"
            : code == BOOTSTRAP_UNKNOWN_SERVICE ? "unknown_service" : "error";
        kern_return_t released = KERN_SUCCESS;
        if (code == BOOTSTRAP_SUCCESS && port != MACH_PORT_NULL) {
            released = mach_port_deallocate(mach_task_self(), port);
        }
        printf("%s{\"service\":\"%s\",\"code\":%d,\"status\":\"%s\",\"releaseCode\":%d}",
            i ? ",\n" : "", services[i], code, status, released);
        if (code != BOOTSTRAP_SUCCESS || released != KERN_SUCCESS) failed = 1;
    }
    puts("\n]}");
    return failed;
}
