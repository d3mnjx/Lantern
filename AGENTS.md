# Lantern project rules

- Keep zero third-party dependencies, on the server and in `web/`. The user asked for this.
- The real vLLM endpoint goes only in the gitignored `.env`. Never commit it.
- The server forwards chat bytes and does not parse them. Keep it that way, so AOT needs no JSON metadata.
- The UI runs over plain HTTP on a LAN, which is not a secure context. Do not use APIs that need one
  (`navigator.clipboard` without a fallback, `crypto.randomUUID`, service workers).
- Large files: tool mode (`web/filetools.js`) keeps the file in the browser and gives the model
  `read_lines` and `grep`. Keep tool results small (`MAX_OUTPUT`), because each round adds them to the context.
- Build check: `dotnet publish -c Release -o publish` must give no trim or AOT warnings.
- Image check: `docker buildx build --platform linux/arm64 .` must pass. It cross-compiles, so it tests the Dockerfile toolchain step.
- CI (`.github/workflows/container.yml`) runs a smoke test and then publishes `ghcr.io/d3mnjx/lantern`
  for AMD64 and ARM64 on each push to `main`.
