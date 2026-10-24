/* Только пять фиксированных операций над приманками собственного стенда.
 * Нет обхода дерева, запуска shell, сети, изменения прав или чтения окружения. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  const char *state;
  const char *code;
  int matched;
} Result;

static Result failure(int code) {
  if (code == EACCES) return (Result){"denied", "EACCES", 0};
  if (code == EPERM) return (Result){"denied", "EPERM", 0};
  return (Result){"error", "OTHER", 0};
}

static Result read_probe(const char *path, const char *expected) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return failure(errno);
  char bytes[64];
  ssize_t size = read(fd, bytes, sizeof(bytes));
  int saved_errno = errno;
  if (close(fd) < 0) return (Result){"error", "OTHER", 0};
  if (size < 0) return failure(saved_errno);
  int matched = (size_t)size == strlen(expected) && memcmp(bytes, expected, (size_t)size) == 0;
  return (Result){"allowed", "NONE", matched};
}

static Result write_probe(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) return failure(errno);
  ssize_t size = write(fd, "x", 1);
  int saved_errno = errno;
  if (close(fd) < 0) return (Result){"error", "OTHER", 0};
  if (size < 0) return failure(saved_errno);
  return (Result){"allowed", "NONE", size == 1};
}

static void print_result(const char *name, Result result, int last) {
  printf("\"%s\":{\"attempted\":true,\"state\":\"%s\",\"code\":\"%s\",\"matched\":%s}%s",
    name, result.state, result.code, result.matched ? "true" : "false", last ? "" : ",");
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return 2;
  Result control = read_probe("CONTROL.txt", "vs-control\n");
  Result outside = read_probe("../outside/OUTSIDE.txt", "vs-outside\n");
  Result symlink = read_probe("OUTSIDE-LINK", "vs-outside\n");
  Result inside_write = write_probe("NEW.txt");
  Result outside_write = write_probe("../outside/WRITE-TARGET");
  printf("{\"schemaVersion\":1,");
  print_result("control", control, 0);
  print_result("outside", outside, 0);
  print_result("symlink", symlink, 0);
  print_result("writeInside", inside_write, 0);
  print_result("writeOutside", outside_write, 1);
  puts("}");
  return fflush(stdout) == 0 ? 0 : 3;
}
