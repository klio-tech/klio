# Multi-stage build for the Klio bridge daemon.
#
# Why containerize: the npm-launched onboarding flow (`npx
# @klio-tech/klio init`) ships zero host-side binaries. Hooks fired
# by Claude Code/Cursor reach the daemon via `docker exec klio-bridge
# klio hook <event>`; the MCP shim is invoked the same way. Putting
# the bridge in a container removes the platform-specific build
# matrix that would otherwise gate npm releases on Go cross-compiles.
#
# Stage 1 (build): alpine + build-base. CGO is required because
# internal/cache uses mattn/go-sqlite3 (the canonical SQLite driver
# for Go has no pure-Go fallback). We pin -trimpath -ldflags="-s -w"
# to keep binaries reproducible and small.
#
# Stage 2 (runtime): alpine + ca-certificates only. The two binaries
# (klio, klio-mcp) live under /usr/local/bin so PATH lookups resolve
# them in `docker exec` invocations spawned by Claude Code.
#
# Final image is ~30 MB (mostly the two binaries + libsqlite).

FROM golang:1.24-alpine AS build

# build-base provides gcc + musl-dev; required for CGO compilation
# of go-sqlite3 on alpine. git is needed by `go mod download` for
# any modules whose source is fetched via git rather than a
# pre-cached zip.
RUN apk add --no-cache build-base git

WORKDIR /src

# Cache the dependency layer separately so source-only changes don't
# re-download the module graph on every build.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=1 forces cgo on (alpine builds set it off by default
# in some toolchain versions, which would silently swap go-sqlite3
# for a no-op driver and crash at runtime).
#
# -trimpath drops absolute build paths from the binary so two builds
# on different hosts produce identical binaries given identical
# inputs (helps with reproducible-build verification).
#
# -ldflags="-s -w" strips the symbol table + DWARF debug info,
# halving binary size. Stack traces in production logs lose
# function names but keep line numbers, which is the right tradeoff
# for a daemon that exits on panic.
ENV CGO_ENABLED=1
RUN go build -trimpath -ldflags="-s -w" -o /out/klio ./cmd/klio
RUN go build -trimpath -ldflags="-s -w" -o /out/klio-mcp ./cmd/klio-mcp


FROM alpine:3.20 AS runtime

# ca-certificates: required for the daemon's HTTPS calls to the
# engine when running against a TLS-terminated cloud deployment.
# tzdata: structured-log timestamps render correctly in the user's
# tz when KLIO_TZ is passed (the daemon doesn't currently read TZ,
# but we ship the data so future versions can).
RUN apk add --no-cache ca-certificates tzdata

# Bake the build version into the image so the bridge's
# `/internal/version` package (file → env → default resolution) can
# report what's actually running, regardless of whether the operator
# threaded KLIO_BRIDGE_VERSION through the compose template. The
# default `0.0.0-dev` mirrors the Go-level fallback so a developer
# running `docker build .` without --build-arg sees a recognisable
# placeholder rather than an empty version field.
#
# Why /etc and not /usr/share or /var/lib: /etc is the conventional
# location for image-baked, OS-style config. `cat /etc/klio-version`
# is the same UX as `cat /etc/alpine-release`.
ARG KLIO_VERSION=0.0.0-dev
RUN echo "$KLIO_VERSION" > /etc/klio-version

COPY --from=build /out/klio /usr/local/bin/klio
COPY --from=build /out/klio-mcp /usr/local/bin/klio-mcp

# /data is the bind-mount target for the named volume that holds:
#   - bridge.sock — unix socket the MCP shim and hook subcommands
#     reach via `docker exec klio-bridge`
#   - cache.db — SQLite mirror of recent memories for offline reads
#   - credentials.enc — file-keychain backend output (refresh token,
#     user_id, agent_id, default_space_id), encrypted under a
#     deterministic key derived from $HOME and a salt
#
# We force the file keychain because OS keychain backends (macOS
# Keychain Services, Linux secret-service via dbus) are not
# accessible from inside a Linux container.
ENV HOME=/data
ENV KLIO_USE_FILE_KEYCHAIN=1
ENV KLIO_SOCKET_PATH=/data/bridge.sock
ENV KLIO_CACHE_DB_PATH=/data/cache.db

# /host is reserved for read-only bind-mounts of host directories
# the daemon needs to read but not write — e.g. ~/.claude/projects
# for `klio backfill`. Compose mounts these in; the binary itself
# never assumes specific paths under /host.
RUN mkdir -p /data /host && chmod 0700 /data

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/klio"]
CMD ["daemon"]
