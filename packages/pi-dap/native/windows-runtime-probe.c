// Windows 10+/Server 2016+. Built ahead of time; no end-user compiler or VC
// redist.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <windows.h>

static DWORD failure(const char *operation) {
  DWORD error = GetLastError();
  fprintf(stderr, "DAP runtime probe: %s failed (Windows error %lu)\n",
          operation, error);
  return error ? error : ERROR_GEN_FAILURE;
}

static BOOL search_file(const wchar_t *directory, const wchar_t *file,
                        wchar_t *resolved) {
  // directory is already one parsed PATH entry. SearchPathW would reinterpret
  // a literal semicolon in it as another list separator and select a different
  // executable. Join only bare names, then let Win32 normalize this single
  // path.
  wchar_t *joined = NULL;
  if (!wcspbrk(file, L"\\/:")) {
    size_t size = wcslen(directory);
    joined = malloc((size + wcslen(file) + 2) * sizeof(wchar_t));
    if (!joined) {
      SetLastError(ERROR_NOT_ENOUGH_MEMORY);
      return FALSE;
    }
    wcscpy(joined, directory);
    if (size && !wcschr(L"\\/:", joined[size - 1]))
      joined[size++] = L'\\';
    wcscpy(joined + size, file);
  }
  DWORD length =
      GetFullPathNameW(joined ? joined : file, 32768, resolved, NULL);
  free(joined);
  if (!length || length >= 32768)
    return FALSE;
  DWORD attributes = GetFileAttributesW(resolved);
  return attributes != INVALID_FILE_ATTRIBUTES &&
         !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

// Preserve Node's cwd-then-PATH and per-directory literal-extension/.com/.exe
// order, without invoking a shell, PATHEXT, or a default system-directory
// search.
static BOOL search_directory(const wchar_t *directory, const wchar_t *file,
                             wchar_t *candidate, wchar_t *resolved) {
  const wchar_t *name = file;
  for (const wchar_t *p = file; *p; ++p) {
    if (*p == L'\\' || *p == L'/' || *p == L':')
      name = p + 1;
  }
  const wchar_t *dot = wcschr(name, L'.');
  if (dot && dot[1] && search_file(directory, file, resolved))
    return TRUE;
  const wchar_t *extensions[] = {L".com", L".exe"};
  for (int i = 0; i < 2; ++i) {
    wcscpy(candidate, file);
    size_t size = wcslen(candidate);
    if (size && candidate[size - 1] == L'.')
      candidate[--size] = L'\0';
    wcscat(candidate, extensions[i]);
    if (search_file(directory, candidate, resolved))
      return TRUE;
  }
  return FALSE;
}

static BOOL resolve_application(const wchar_t *file, wchar_t *resolved) {
  wchar_t *candidate = malloc((wcslen(file) + 5) * sizeof(wchar_t));
  wchar_t *path = NULL;
  BOOL found = FALSE;
  if (!candidate) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return FALSE;
  }
  if (wcspbrk(file, L"\\/:")) {
    found = search_directory(L".", file, candidate, resolved);
    goto done;
  }
  if (NeedCurrentDirectoryForExePathW(L"")) {
    found = search_directory(L".", file, candidate, resolved);
    if (found)
      goto done;
  }
  const wchar_t *environment_path = _wgetenv(L"PATH");
  if (!environment_path)
    goto done;
  path = _wcsdup(environment_path);
  if (!path) {
    free(candidate);
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return FALSE;
  }
  for (wchar_t *directory = path; *directory;) {
    wchar_t *end = directory;
    if (*end == L'"' || *end == L'\'') {
      wchar_t *quote = wcschr(end + 1, *end);
      if (quote)
        end = quote + 1;
    }
    while (*end && *end != L';')
      ++end;
    wchar_t *next = *end ? end + 1 : end;
    *end = L'\0';
    if (*directory == L'"' || *directory == L'\'')
      ++directory;
    if (end > directory && (end[-1] == L'"' || end[-1] == L'\''))
      end[-1] = L'\0';
    if (*directory && search_directory(directory, file, candidate, resolved)) {
      found = TRUE;
      break;
    }
    directory = next;
  }
done:
  free(path);
  free(candidate);
  if (!found)
    SetLastError(ERROR_FILE_NOT_FOUND);
  return found;
}

int wmain(int argc, wchar_t **argv) {
  HANDLE job = NULL;
  HANDLE streams[3] = {NULL, NULL, NULL};
  const DWORD stream_ids[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
                               STD_ERROR_HANDLE};
  PROCESS_INFORMATION process = {0};
  STARTUPINFOEXW startup = {0};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  SIZE_T attribute_size = 0;
  BOOL attributes_initialized = FALSE;
  wchar_t *command = NULL;
  wchar_t *application = NULL;
  DWORD result = ERROR_GEN_FAILURE;

  if (argc < 2 || !argv[1][0] || wcscmp(argv[1], L".") == 0) {
    fputs("DAP runtime probe: expected an executable and its arguments\n",
          stderr);
    return ERROR_BAD_ARGUMENTS;
  }

  // Node already quoted each argument. Strip only this helper's argv[0], whose
  // Windows filename cannot contain a quote; preserve the remaining UTF-16
  // text.
  const wchar_t *tail = GetCommandLineW();
  BOOL quoted = FALSE;
  while (*tail && (quoted || (*tail != L' ' && *tail != L'\t'))) {
    if (*tail == L'"')
      quoted = !quoted;
    ++tail;
  }
  while (*tail == L' ' || *tail == L'\t')
    ++tail;
  command = _wcsdup(tail);
  if (!command) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    result = failure("command allocation");
    goto cleanup;
  }

  application = malloc(32768 * sizeof(wchar_t));
  if (!application) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    result = failure("application allocation");
    goto cleanup;
  }
  if (!resolve_application(argv[1], application)) {
    result = failure("executable lookup");
    goto cleanup;
  }

  // Unnamed, noninheritable, and never eligible for breakaway. The helper alone
  // owns this handle: abrupt helper termination also closes the whole tree.
  job = CreateJobObjectW(NULL, NULL);
  if (!job) {
    result = failure("CreateJobObjectW");
    goto cleanup;
  }
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    result = failure("SetInformationJobObject");
    goto cleanup;
  }

  for (int i = 0; i < 3; ++i) {
    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(stream_ids[i]),
                         GetCurrentProcess(), &streams[i], 0, TRUE,
                         DUPLICATE_SAME_ACCESS)) {
      result = failure("DuplicateHandle(stdio)");
      goto cleanup;
    }
  }
  InitializeProcThreadAttributeList(NULL, 2, 0, &attribute_size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !attribute_size) {
    result = failure("InitializeProcThreadAttributeList(size)");
    goto cleanup;
  }
  startup.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, attribute_size);
  if (!startup.lpAttributeList) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    result = failure("attribute allocation");
    goto cleanup;
  }
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0,
                                         &attribute_size)) {
    result = failure("InitializeProcThreadAttributeList");
    goto cleanup;
  }
  attributes_initialized = TRUE;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_JOB_LIST, &job,
                                 sizeof(job), NULL, NULL) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_HANDLE_LIST, streams,
                                 sizeof(streams), NULL, NULL)) {
    result = failure("UpdateProcThreadAttribute");
    goto cleanup;
  }
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = streams[0];
  startup.StartupInfo.hStdOutput = streams[1];
  startup.StartupInfo.hStdError = streams[2];

  // JOB_LIST is applied atomically at creation, including when the helper dies
  // inside CreateProcessW. Never spawn first and assign a running/suspended
  // PID. NULL environment/cwd preserve exactly what Node supplied to this
  // helper.
  if (!CreateProcessW(application, command, NULL, NULL, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, NULL,
                      NULL, &startup.StartupInfo, &process)) {
    result = failure("CreateProcessW");
    goto cleanup;
  }
  if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0) {
    result = failure("WaitForSingleObject");
    goto cleanup;
  }
  if (!GetExitCodeProcess(process.hProcess, &result)) {
    result = failure("GetExitCodeProcess");
    goto cleanup;
  }

cleanup:
  if (process.hProcess) {
    // A successful leader must not leave descendants behind, even when they
    // closed stdio. Observe job accounting, never scan/reopen PIDs for
    // ownership.
    if (!TerminateJobObject(job, ERROR_PROCESS_ABORTED)) {
      result = failure("TerminateJobObject");
    } else {
      const ULONGLONG deadline = GetTickCount64() + 1000;
      for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                       &accounting, sizeof(accounting), NULL)) {
          result = failure("QueryInformationJobObject");
          break;
        }
        if (!accounting.ActiveProcesses)
          break;
        if (GetTickCount64() >= deadline) {
          SetLastError(ERROR_TIMEOUT);
          result = failure("job cleanup deadline");
          break;
        }
        Sleep(1);
      }
    }
  }
  if (attributes_initialized)
    DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (startup.lpAttributeList)
    HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
  for (int i = 0; i < 3; ++i) {
    if (streams[i] && !CloseHandle(streams[i]))
      result = failure("CloseHandle(stdio)");
  }
  if (process.hThread && !CloseHandle(process.hThread))
    result = failure("CloseHandle(thread)");
  if (process.hProcess && !CloseHandle(process.hProcess))
    result = failure("CloseHandle(process)");
  if (job && !CloseHandle(job))
    result = failure("CloseHandle(job)");
  free(application);
  free(command);
  // Do not truncate native exit codes through an int return from wmain.
  ExitProcess(result);
}
