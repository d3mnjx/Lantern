# Lantern

A small web chat for a local [vLLM](https://docs.vllm.ai) server, or any other server with an OpenAI-compatible API.
It is one ASP.NET Core binary, compiled with Native AOT, with the UI inside it.

- Streamed replies with Markdown (tables, code blocks with a copy button, lists, quotes).
- A collapsible thinking panel for reasoning models.
- Attach text files and images: use the paperclip, drag and drop, or paste.
- Model picker, system prompt, temperature, and max tokens.
- Token count, tokens per second, and time to first token for each reply.
- Stop and regenerate.
- Chat history stays in the browser (IndexedDB). The server keeps no state.

It is for one user on a LAN. It has no login.

## Run with Docker

```bash
docker run -d --name lantern -p 7319:7319 \
  -e VLLM_URL=http://<vllm-host>:8000/v1 \
  --restart unless-stopped \
  ghcr.io/d3mnjx/lantern:latest
```

Then open `http://<docker-host>:7319`. Images exist for `linux/amd64` and `linux/arm64`.

With Docker Compose, copy `.env.example` to `.env`, set `VLLM_URL`, and run `docker compose up -d`.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `VLLM_URL` | yes | Base URL of the OpenAI-compatible API, including `/v1`. |
| `VLLM_API_KEY` | no | Sent as a Bearer token, for a vLLM started with `--api-key`. |
| `ASPNETCORE_HTTP_PORTS` | no | Listen port. The default is `7319`. |

## Build from source

Needs the .NET 10 SDK and the [Native AOT prerequisites](https://learn.microsoft.com/dotnet/core/deploying/native-aot/#prerequisites) (clang).

```bash
dotnet publish -c Release -o publish
VLLM_URL=http://<vllm-host>:8000/v1 ./publish/lantern
```

It listens on `0.0.0.0:7319`. The output is one self-contained file, `publish/lantern`, of about 12 MB.

## How it works

- `Program.cs` serves the files in `web/` from embedded resources and forwards two routes:
  `GET /api/models` and `POST /api/chat`. It passes the bytes through without parsing them,
  so the server code does not depend on the vLLM request schema.
- `web/app.js` builds OpenAI-style chat requests and reads the SSE stream.
  Text files go into the user message as fenced blocks. Images go as `image_url` parts (base64),
  so they need a vision model.
- `web/markdown.js` is a small Markdown renderer. It escapes all input before it adds tags.
  The project has no third-party libraries.

## Limits

- No PDF or Office files. Only text files (up to 2 MB) and images (up to 20 MB).
- The page uses plain HTTP. Do not expose it to the internet.
