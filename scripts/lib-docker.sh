# shellcheck shell=bash
# Resolve a docker CLI that ACTUALLY works, by running it.
#
# On WSL with Docker Desktop but no WSL integration enabled, the `docker` found on
# PATH is a stub that prints
#   "The command 'docker' could not be found in this WSL 2 distro."
# and exits 1. `command -v docker` succeeds for that stub, so a PATH lookup picks a
# CLI that can never work -- which is exactly how a "no docker" script failure
# looked while Docker was running fine. The Windows-side docker.exe, or reaching
# docker through cmd.exe, do work. Probing `compose version` proves it.
#
# Usage: source this file, then
#   docker_resolve || exit 1
#   docker_run compose ps app
# On success DOCKER (a bash array) holds the working argv.

DOCKER=()

_try_docker_candidate() {
  # "$@" is one candidate argv; prove it can talk to compose before adopting it.
  "$@" compose version >/dev/null 2>&1
}

docker_resolve() {
  DOCKER=()
  if command -v docker >/dev/null 2>&1 && _try_docker_candidate docker; then
    DOCKER=(docker)
  elif command -v docker.exe >/dev/null 2>&1 && _try_docker_candidate docker.exe; then
    DOCKER=(docker.exe)
  elif command -v cmd.exe >/dev/null 2>&1 && _try_docker_candidate cmd.exe /c docker; then
    DOCKER=(cmd.exe /c docker)
  elif command -v powershell.exe >/dev/null 2>&1 &&
    _try_docker_candidate powershell.exe -NoProfile -Command docker; then
    DOCKER=(powershell.exe -NoProfile -Command docker)
  else
    return 1
  fi
  return 0
}

docker_run() {
  if [ ${#DOCKER[@]} -eq 0 ]; then
    echo "docker_run called before docker_resolve succeeded" >&2
    return 127
  fi
  "${DOCKER[@]}" "$@"
}
