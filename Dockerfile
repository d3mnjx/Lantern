# The build stage runs natively on the build machine and cross-compiles for the target arch.
# AOT builds under QEMU emulation are many times slower.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0.403-noble-aot AS build
ARG TARGETARCH
ARG BUILDARCH
# The -aot image has clang but no linker or C runtime for a foreign arch. Add them only for a cross build.
RUN if [ "$TARGETARCH" != "$BUILDARCH" ]; then \
      case "$TARGETARCH" in arm64) triple=aarch64-linux-gnu ;; amd64) triple=x86-64-linux-gnu ;; *) exit 1 ;; esac; \
      apt-get update && apt-get install -y --no-install-recommends \
        "gcc-$triple" "binutils-$triple" "libc6-dev-$TARGETARCH-cross" \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /src
COPY global.json Lantern.csproj ./
RUN dotnet restore -a $TARGETARCH
COPY . .
RUN dotnet publish -c Release -a $TARGETARCH --no-restore -o /out

# Chiseled runtime-deps: no shell, no package manager, non-root user by default.
FROM mcr.microsoft.com/dotnet/runtime-deps:10.0.14-noble-chiseled
WORKDIR /app
COPY --from=build /out/lantern .
# The base image sets ASPNETCORE_HTTP_PORTS=8080. Override it to keep the Lantern port.
ENV ASPNETCORE_HTTP_PORTS=7319
EXPOSE 7319
ENTRYPOINT ["./lantern"]
